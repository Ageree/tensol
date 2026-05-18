// Sprint 8 §A-FD-Run, A-FD-Crash, A-FD-Tenant-Iso — coordinator's decepticon
// orchestration module.
//
// Lives under apps/api/src/scope-engine/ to keep services/coordinator/src/
// start-handler.ts ≤800 lines (R3). Pure-ish: DB I/O + object-storage I/O +
// adapter I/O all happen here. The adapter, object storage, and audit emitter
// are injected so tests can swap them.
//
// Flow:
//   1. Build minimal OPPLAN payload from assessment + scope.
//   2. Compute sha256(JSON.stringify(opplan)) and write to object storage.
//   3. Insert assessment_artifacts row (kind='opplan'). Append-only.
//   4. adapter.start({tenantId, opplan}) → SessionHandle.
//   5. Insert decepticon_sessions row (status='started').
//   6. Emit `decepticon.session.started` audit row.
//   7. Drain status stream:
//      - on 'failed' → mark session row status='failed', mark assessment
//        state='failed', emit `decepticon.session.failed` + `assessment.failed`
//        audits; return early.
//      - on 'completed' → continue.
//   8. Drain candidate stream → insert candidate_findings row per candidate,
//      republish as `decepticon.findings` envelope, emit
//      `decepticon.candidate.observed` audit.
//   9. Mark session row status='completed', completed_at=now, emit
//      `decepticon.session.completed` audit.
//
// Hard invariants honoured:
//   - JSONB pitfall: every jsonb insert wraps the value with JSON.stringify.
//   - Append-only: assessment_artifacts insert never updated, never deleted
//     (resetAuthState in IT respects FK order).
//   - Audit-per-state-change: every state transition emits exactly one row.
//   - Tenant isolation: every row carries tenant_id; adapter sessions are
//     keyed by sessionId and never share state across tenants.

import { emitSignedAudit } from "@cyberstrike/audit";
import type { ServiceActorId } from '@cyberstrike/contracts';
import type { Database } from '@cyberstrike/db';
import {
  type DecepticonAdapter,
  NotImplementedError,
  type Opplan,
  type SessionStatus,
} from '@cyberstrike/decepticon-adapter';
import type { ObjectStorage } from '@cyberstrike/object-storage';
import {
  cleanWorkspace,
  type DecepticonWorkspaceFinding,
  extractWorkspaceFindings,
} from './decepticon-workspace.ts';
import {
  type KgValidatedFinding,
  queryValidatedFindings,
  queryVulnerabilityCount,
} from './decepticon-kg.ts';
import type { JobEnvelope, QueueAdapter } from '@cyberstrike/queue';
import {
  type EffectiveScope,
  type EngineDeps,
  type NormalizedRule,
  decide,
} from '@cyberstrike/scope-engine';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

const COORDINATOR_ACTOR_ID: ServiceActorId = 'coordinator';

// EE-3.B (2026-05-12) — MVP cost cap.
// Generous default (100k actions per scan) sized for XBOW-scale deep
// engagements where a quality scan may emit tens of thousands of audit
// rows across recon → exploit → reporting phases. A runaway loop hits this
// in ~minutes; legitimate scans don't. Tuneable via `SCAN_ACTION_CAP` env.
// No wallclock timeout by design: long deep scans must not be killed by
// time, only by action volume.
const DEFAULT_ACTION_CAP = 100_000;
const getActionCap = (): number => {
  // noPropertyAccessFromIndexSignature requires bracket-access on process.env.
  const raw = (process.env as Record<string, string | undefined>)['SCAN_ACTION_CAP'];
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ACTION_CAP;
};

const countAuditEventsForAssessment = async (
  db: Kysely<Database>,
  tenantId: string,
  assessmentId: string,
): Promise<number> => {
  const row = await db
    .selectFrom('audit_events')
    .where('tenant_id', '=', tenantId)
    .where('assessment_id', '=', assessmentId)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
};

export interface StartDecepticonDeps {
  readonly db: Kysely<Database>;
  readonly adapter: DecepticonAdapter;
  readonly objectStorage: ObjectStorage;
  readonly queueAdapter: QueueAdapter;
  /**
   * Sprint 13 codex P1-A — scope engine deps (DNS, clock, rate-limit) for the
   * per-candidate scope gate. When provided, every candidate's affectedUrl is
   * decided before persistence. When absent (legacy direct callers not using
   * createDecepticonRunner), the gate is skipped for backward-compat.
   */
  readonly scopeDeps?: EngineDeps;
  /** Test seam — defaults to crypto.randomUUID(). */
  readonly randomUUID?: () => string;
  /** Test seam — defaults to () => new Date().toISOString(). */
  readonly clockIso?: () => string;
  /** Sprint 18 test seam — generates 8 hex chars for SSRF token suffix. */
  readonly randomHex8?: () => string;
}

export interface StartDecepticonInput {
  readonly tenantId: string;
  readonly projectId: string | null;
  readonly assessmentId: string;
  readonly scope: EffectiveScope;
  readonly traceId: string;
  /** Parent assessment.start envelope — used to chain idempotency keys. */
  readonly parentEnvelope: JobEnvelope;
  /** Sprint 21 — when true, publish recon.subfinder.run after session completes. */
  readonly triggerRecon?: boolean;
  /** Sprint 21 — primary domain for recon; required when triggerRecon is true. */
  readonly primaryDomain?: string;
  /** 2026-05-12 — drives engagementProfile/foothold/postExploit in OPPLAN.
   *  When omitted, defaults to 'recon-only' (back-compat with legacy callers). */
  readonly tier?: 'light' | 'medium' | 'aggressive';
}

export interface StartDecepticonResult {
  readonly sessionId: string;
  readonly opplanArtifactId: string;
  readonly candidateFindingIds: readonly string[];
  readonly status: 'completed' | 'failed';
  readonly failureReason?: string;
}

const SAFE_NAMESPACE_RE = /^[a-zA-Z0-9-]+$/;

const sanitiseUuidForKey = (id: string): string => {
  if (!SAFE_NAMESPACE_RE.test(id)) {
    throw new Error(`unsafe_uuid_for_object_key:${id}`);
  }
  return id;
};

const summariseRule = (r: NormalizedRule): string => {
  switch (r.kind) {
    case 'domain':
      return `domain:${r.pattern}`;
    case 'subdomain':
      return `subdomain:${r.parent}`;
    case 'url_prefix':
      return `url_prefix:${r.prefix}`;
    case 'ip':
      return `ip:${r.ip}`;
    case 'cidr':
      return `cidr:${r.cidr}`;
    case 'port':
      return `port:${r.port}`;
    case 'protocol':
      return `protocol:${r.protocol}`;
    case 'cloud_account':
      return `cloud:${r.provider}:${r.accountId}`;
    case 'kubernetes_namespace':
      return `k8s:${r.cluster}:${r.namespace}`;
    case 'repository':
      return `repo:${r.vcs}:${r.owner}/${r.name}`;
    case 'time_window':
      return `time:${r.start}:${r.end}`;
    case 'rate_limit':
      return `rate:${r.bucket}:${r.perSecond}:${r.burst}`;
    case 'tool_category':
      return `tool_cat:${r.category}`;
    case 'tool_name':
      return `tool:${r.toolName}`;
    case 'http_method':
      return `http_method:${r.method}`;
    case 'path_pattern':
      return `path:${r.glob}`;
    case 'unknown_rule':
      return `unknown:${r.rawRuleKind}`;
  }
};

/**
 * 2026-05-12 second-smoke bug fix: opplan-engagement profile is now derived
 * from `input.tier` instead of hardcoded `'recon-only'`. Without this,
 * Decepticon always defaulted to recon-only and never emitted candidates,
 * regardless of model or target richness.
 *
 * Tier semantics:
 *   light       → 'recon-only'      (discovery + cataloguing; no exploit)
 *   medium      → 'recon-and-exploit' (recon + web-app probes; no foothold)
 *   aggressive  → 'recon-and-exploit' + foothold=true + postExploit=true
 *                  (full chain construction; XBOW-style)
 */
const engagementForTier = (tier: 'light' | 'medium' | 'aggressive' | undefined) => {
  switch (tier) {
    case 'aggressive':
      return {
        engagementProfile: 'recon-and-exploit',
        foothold: true,
        postExploit: true,
      };
    case 'medium':
      return {
        engagementProfile: 'recon-and-exploit',
        foothold: false,
        postExploit: false,
      };
    default:
      return { engagementProfile: 'recon-only', foothold: false, postExploit: false };
  }
};

const buildOpplan = (input: StartDecepticonInput): Opplan => {
  const targetValues = [...input.scope.allowRules]
    .filter(
      (
        r,
      ): r is Extract<
        NormalizedRule,
        { kind: 'domain' | 'subdomain' | 'url_prefix' | 'ip' | 'cidr' }
      > => ['domain', 'subdomain', 'url_prefix', 'ip', 'cidr'].includes(r.kind),
    )
    .map(summariseRule);
  const exclusionValues = [...input.scope.denyRules].map(summariseRule);
  const allowedTools: string[] = [];
  for (const policy of input.scope.toolCatalog.values()) {
    allowedTools.push(policy.toolName);
  }
  const engagement = engagementForTier(input.tier);
  return {
    assessmentId: input.assessmentId,
    targets: targetValues.length > 0 ? targetValues : ['unspecified'],
    authorizedScope: targetValues,
    exclusions: exclusionValues,
    testingWindow: {
      start: input.scope.timeWindow?.start ?? null,
      end: input.scope.timeWindow?.end ?? null,
    },
    allowedTools,
    unavailableTools: [],
    engagementProfile: engagement.engagementProfile,
    foothold: engagement.foothold,
    postExploit: engagement.postExploit,
    c2: false,
    ad: false,
  };
};

const opplanObjectKey = (tenantId: string, assessmentId: string, sha: string): string =>
  `tenant/${sanitiseUuidForKey(tenantId)}/assessment/${sanitiseUuidForKey(assessmentId)}/opplan-${sha}.json`;

export const startDecepticonSession = async (
  deps: StartDecepticonDeps,
  input: StartDecepticonInput,
): Promise<StartDecepticonResult> => {
  const randomUUID = deps.randomUUID ?? ((): string => crypto.randomUUID());
  const clockIso = deps.clockIso ?? ((): string => new Date().toISOString());
  // Capture timestamp BEFORE Decepticon writes anything — used to filter
  // workspace findings to only this scan's emissions (post-run extractor).
  const sessionStartedAtIso = clockIso();

  // 0. Decepticon workspace lives in /workspace inside decepticon-sandbox
  // container and PERSISTS across runs. Wipe before this scan so prior
  // findings don't leak into our extractor (best-effort; silent on failure
  // when sandbox container isn't reachable, e.g. in unit tests).
  await cleanWorkspace().catch(() => undefined);

  // 1-3. Build OPPLAN, write to object storage, insert assessment_artifacts row.
  const opplan = buildOpplan(input);
  const opplanJson = JSON.stringify(opplan);
  const tempSha = await sha256OfString(opplanJson);
  const key = opplanObjectKey(input.tenantId, input.assessmentId, tempSha);
  const putResult = await deps.objectStorage.put({
    key,
    body: opplanJson,
    contentType: 'application/json',
  });

  const opplanArtifactId = randomUUID();
  // JSONB pitfall (P1): wrap with JSON.stringify so the array/object body
  // round-trips correctly. Empty {} would otherwise be silently written.
  const opplanMetadataObj = {
    opplanVersion: 1,
    engagementProfile: opplan.engagementProfile,
    targetCount: opplan.targets.length,
  };
  // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary needs string.
  const opplanMetadataJson = JSON.stringify(opplanMetadataObj) as any;
  await deps.db
    .insertInto('assessment_artifacts')
    .values({
      id: opplanArtifactId,
      tenant_id: input.tenantId,
      assessment_id: input.assessmentId,
      kind: 'opplan',
      object_storage_key: putResult.key,
      sha256: putResult.sha256,
      size_bytes: String(putResult.sizeBytes),
      metadata: opplanMetadataJson,
    })
    .execute();

  // 4. Start the adapter session.
  let sessionHandle: Awaited<ReturnType<DecepticonAdapter['start']>>;
  try {
    sessionHandle = await deps.adapter.start({ tenantId: input.tenantId, opplan });
  } catch (err) {
    if (err instanceof NotImplementedError) {
      // RealDecepticonAdapter selected but not implemented — surface as a
      // session-failed audit so observability still records the attempt.
      await markAssessmentFailed(deps, input, 'adapter_not_implemented');
      return {
        sessionId: '00000000-0000-0000-0000-000000000000',
        opplanArtifactId,
        candidateFindingIds: [],
        status: 'failed',
        failureReason: 'adapter_not_implemented',
      };
    }
    throw err;
  }

  // 5. Persist decepticon_sessions row.
  await deps.db
    .insertInto('decepticon_sessions')
    .values({
      id: sessionHandle.sessionId,
      tenant_id: input.tenantId,
      assessment_id: input.assessmentId,
      status: 'started',
      opplan_object_key: putResult.key,
      opplan_sha256: putResult.sha256,
      opplan_size_bytes: String(putResult.sizeBytes),
      // Sprint 13: populated by RealDecepticonAdapter; NULL for fake sessions.
      langgraph_thread_id: sessionHandle.langgraphThreadId ?? null,
    })
    .execute();

  // 6. Emit started audit.
  await emitSignedAudit(deps.db, {
      tenantId: input.tenantId,
      action: 'decepticon.session.started',
      outcome: 'success',
      actorType: 'service',
      actorId: COORDINATOR_ACTOR_ID,
      actorName: 'coordinator',
      resourceType: 'decepticon_session',
      resourceId: sessionHandle.sessionId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      assessmentId: input.assessmentId,
      ip: 'coordinator',
      userAgent: null,
      traceId: input.traceId,
      metadata: {
        opplanArtifactId,
        opplanSha256: putResult.sha256,
        opplanSizeBytes: putResult.sizeBytes,
      },
    },
  );

  // 7. Drain status stream + detect failure.
  let finalStatus: SessionStatus = 'started';
  let failureReason: string | null = null;
  for await (const event of deps.adapter.streamStatus(sessionHandle.sessionId)) {
    finalStatus = event.status;
    if (event.status === 'failed') {
      const detail = event.detail as { reason?: string } | undefined;
      const reasonRaw = detail?.reason;
      failureReason = typeof reasonRaw === 'string' ? reasonRaw : 'session_crashed';
      break;
    }
  }

  if (finalStatus === 'failed') {
    await deps.db
      .updateTable('decepticon_sessions')
      .set({
        status: 'failed',
        completed_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', sessionHandle.sessionId)
      .execute();

    await emitSignedAudit(deps.db, {
        tenantId: input.tenantId,
        action: 'decepticon.session.failed',
        outcome: 'failure',
        actorType: 'service',
        actorId: COORDINATOR_ACTOR_ID,
        actorName: 'coordinator',
        resourceType: 'decepticon_session',
        resourceId: sessionHandle.sessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        assessmentId: input.assessmentId,
        ip: 'coordinator',
        userAgent: null,
        traceId: input.traceId,
        metadata: {
          reason: failureReason ?? 'session_crashed',
          opplanArtifactId,
        },
      },
    );

    await markAssessmentFailed(deps, input, failureReason ?? 'session_crashed');

    return {
      sessionId: sessionHandle.sessionId,
      opplanArtifactId,
      candidateFindingIds: [],
      status: 'failed',
      failureReason: failureReason ?? 'session_crashed',
    };
  }

  // 8. Drain candidate stream → scope gate → persist + republish + audit.
  // P1-A: scope gate active when scopeDeps is available (forwarded by the
  // coordinator from its CoordinatorScopeDeps at call time, or pre-bound in
  // deps). When absent (legacy direct callers), the gate is skipped so
  // backward-compat is preserved — but real production paths MUST supply deps.
  const effectiveScopeDeps: EngineDeps | null = deps.scopeDeps ?? null;
  const candidateFindingIds: string[] = [];
  // EE-3.B — read cap once at start of stream drain; tests stub env per-call.
  const actionCap = getActionCap();
  for await (const candidate of deps.adapter.streamCandidates(sessionHandle.sessionId)) {
    // EE-3.B — MVP cost cap. Count all audit rows attributed to this assessment;
    // if the total has reached the cap, halt the Decepticon session, mark the
    // assessment failed with reason='action_cap_exceeded', emit a dedicated
    // audit row, and return early. No wallclock — only action volume.
    const currentActionCount = await countAuditEventsForAssessment(
      deps.db,
      input.tenantId,
      input.assessmentId,
    );
    if (currentActionCount >= actionCap) {
      try {
        await deps.adapter.stop(sessionHandle.sessionId);
      } catch {
        // Best-effort halt; if adapter.stop throws (already terminated etc.)
        // we still proceed to mark assessment failed locally.
      }
      await deps.db
        .updateTable('decepticon_sessions')
        .set({
          status: 'failed',
          completed_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', sessionHandle.sessionId)
        .execute();
      await emitSignedAudit(deps.db, {
        tenantId: input.tenantId,
        action: 'assessment.action_cap_exceeded',
        outcome: 'failure',
        actorType: 'service',
        actorId: COORDINATOR_ACTOR_ID,
        actorName: 'coordinator',
        resourceType: 'assessment',
        resourceId: input.assessmentId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        assessmentId: input.assessmentId,
        ip: 'coordinator',
        userAgent: null,
        traceId: input.traceId,
        metadata: {
          sessionId: sessionHandle.sessionId,
          actionCount: currentActionCount,
          actionCap,
        },
      });
      await markAssessmentFailed(deps, input, 'action_cap_exceeded');
      return {
        sessionId: sessionHandle.sessionId,
        opplanArtifactId,
        candidateFindingIds,
        status: 'failed',
        failureReason: 'action_cap_exceeded',
      };
    }
    // P1-A (codex fix): per-candidate scope gate. Real and compromised adapters
    // can emit any affectedUrl; we must decide() BEFORE persisting or publishing.
    if (effectiveScopeDeps !== null) {
      const scopeDecision = await decide(
        input.scope,
        // Use method:'GET' as the canonical scope-gate action for URL reachability
        // (mirrors targetToActionInput in start-handler). The candidate URL need
        // only be within the allowed domain/IP scope; the actual exploit method
        // is irrelevant to the scope boundary check.
        { kind: 'http_request', url: candidate.affectedUrl, method: 'GET' },
        effectiveScopeDeps,
      );
      if (!scopeDecision.allowed) {
        // Drop candidate silently — emit one denied audit row for observability.
        // metadata is spread into after_state (a Json object) by emitAudit;
        // Kysely handles JSONB serialization natively — no pre-stringify needed.
        // ruleIds is an array; emitAudit spreads it into the after_state object.
        await emitSignedAudit(deps.db, {
            tenantId: input.tenantId,
            action: 'decepticon.candidate.denied',
            outcome: 'denied',
            actorType: 'service',
            actorId: COORDINATOR_ACTOR_ID,
            actorName: 'coordinator',
            resourceType: 'candidate_finding',
            resourceId: null,
            ...(input.projectId ? { projectId: input.projectId } : {}),
            assessmentId: input.assessmentId,
            ip: 'coordinator',
            userAgent: null,
            traceId: input.traceId,
            metadata: {
              reason: 'scope_deny',
              affectedUrl: candidate.affectedUrl,
              ruleIds: [...scopeDecision.matchedDenyRuleIds],
              sessionId: sessionHandle.sessionId,
            },
          },
        );
        continue;
      }
    }

    const candidateFindingId = randomUUID();
    candidateFindingIds.push(candidateFindingId);

    // JSONB pitfall (P1): wrap with JSON.stringify so the payload object
    // round-trips correctly. Without the wrap, Kysely silently writes {}.
    const candidatePayloadObj = {
      ...candidate.payload,
      candidateId: candidate.candidateId,
      sessionId: candidate.sessionId,
    };
    // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary needs string.
    const candidatePayloadJson = JSON.stringify(candidatePayloadObj) as any;
    await deps.db
      .insertInto('candidate_findings')
      .values({
        id: candidateFindingId,
        tenant_id: input.tenantId,
        assessment_id: input.assessmentId,
        type: candidate.type,
        severity: candidate.severity,
        affected_url: candidate.affectedUrl,
        source: candidate.source,
        payload: candidatePayloadJson,
      })
      .execute();

    // Sprint 23 F: decepticon.findings queue kind removed (no subscriber existed).

    // Sprint 10 — publish a `validate.finding` envelope so the
    // validator-worker can replay the candidate and gate findings creation.
    // Only XSS-reflected candidates are wired in Sprint 10; other types
    // skip the publish until later sprints add their validators.
    if (candidate.type === 'xss_reflected') {
      const validateEnvelope: JobEnvelope = {
        jobId: randomUUID(),
        tenantId: input.tenantId,
        projectId: input.projectId ?? null,
        assessmentId: input.assessmentId,
        kind: 'validate.finding',
        idempotencyKey: `${input.parentEnvelope.idempotencyKey}:validate:${candidateFindingId}`,
        createdAt: clockIso(),
        attempt: 0,
        maxAttempts: 3,
        traceId: input.traceId,
        payload: {
          tenantId: input.tenantId,
          projectId: input.projectId ?? null,
          assessmentId: input.assessmentId,
          candidateFindingId,
          candidateType: 'xss_reflected',
          traceId: input.traceId,
        },
      };
      await deps.queueAdapter.publish(validateEnvelope);
    }

    // 2026-05-12 — DEPRECATED — per-type validator dispatch removed.
    // Decepticon's `verifier` agent handles validation universally with ZFP +
    // CVSS + PoC for ALL vulnerability classes (not just SSRF/LFI/RCE/SQLi).
    // See project_tensol_architectural_audit_2026-05-12.md for the audit
    // that surfaced this duplication. validator-worker package retained for
    // historical IT-test coverage but no longer invoked from this hot path —
    // workspace-extractor (step 8.5) is the single source of finding
    // ingestion now, and Decepticon's `assistant_id=verifier` flow (planned
    // Phase 3 of the cleanup) will handle ZFP validation upstream of our
    // extractor, eliminating the candidate→confirmed promotion logic
    // entirely from Tensol-side code.

    await emitSignedAudit(deps.db, {
        tenantId: input.tenantId,
        action: 'decepticon.candidate.observed',
        outcome: 'success',
        actorType: 'service',
        actorId: COORDINATOR_ACTOR_ID,
        actorName: 'coordinator',
        resourceType: 'candidate_finding',
        resourceId: candidateFindingId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        assessmentId: input.assessmentId,
        ip: 'coordinator',
        userAgent: null,
        traceId: input.traceId,
        metadata: {
          sessionId: sessionHandle.sessionId,
          type: candidate.type,
          severity: candidate.severity,
        },
      },
    );
  }

  // 8.5. Workspace findings extraction (2026-05-12) — Decepticon's recon
  // / exploit / postexploit subagents write findings to
  // /workspace/findings/FIND-NNN.md and /workspace/timeline.jsonl rather
  // than emitting subagent_tool_result events through the LangGraph stream.
  // Pull them out of the sandbox container and persist as candidate_findings.
  // Best-effort: silent if extractor returns empty (sandbox unreachable etc.).
  const wsFindings: DecepticonWorkspaceFinding[] = await extractWorkspaceFindings({
    sinceIso: sessionStartedAtIso,
  }).catch(() => []);
  for (const f of wsFindings) {
    const candidateFindingId = randomUUID();
    await deps.db
      .insertInto('candidate_findings')
      .values({
        id: candidateFindingId,
        tenant_id: input.tenantId,
        assessment_id: input.assessmentId,
        type: f.type,
        severity: f.severity,
        affected_url: f.affectedUrl ?? '',
        source: 'decepticon',
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary
        payload: JSON.stringify({
          decepticonFindingId: f.id,
          agent: f.agent,
          ts: f.ts,
          title: f.title,
          description: f.description ?? '',
          cvssScore: f.cvssScore,
          cvssVector: f.cvssVector,
          cwe: f.cwe ?? [],
          mitre: f.mitre ?? [],
          confidence: f.confidence,
          phase: f.phase,
          stepsToReproduce: f.stepsToReproduce ?? '',
          impact: f.impact ?? '',
          remediation: f.remediation ?? '',
          evidencePaths: f.evidencePaths ?? [],
        }) as any,
      })
      .execute();
    candidateFindingIds.push(candidateFindingId);
    await emitSignedAudit(deps.db, {
      tenantId: input.tenantId,
      action: 'decepticon.candidate.observed',
      outcome: 'success',
      actorType: 'service',
      actorId: COORDINATOR_ACTOR_ID,
      actorName: 'coordinator',
      resourceType: 'candidate_finding',
      resourceId: candidateFindingId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      assessmentId: input.assessmentId,
      ip: 'coordinator',
      userAgent: null,
      traceId: input.traceId,
      metadata: {
        sessionId: sessionHandle.sessionId,
        type: f.type,
        severity: f.severity,
        source: 'workspace_extractor',
        decepticonFindingId: f.id,
        ...(f.cvssScore !== undefined ? { cvssScore: f.cvssScore } : {}),
        ...(f.cwe && f.cwe.length > 0 ? { cwe: [...f.cwe] } : {}),
      },
    });
  }

  // 8.7. Verifier dispatch (Phase 3.1 — 2026-05-12).
  //
  // After the primary Decepticon thread (recon/decepticon orchestrator) has
  // written VULNERABILITY nodes to the Neo4j knowledge graph via Rule 4b
  // (infra/decepticon-overrides/recon.md), spawn a SECOND LangGraph thread
  // with assistant_id="verifier". The verifier agent reads VULNERABILITY
  // nodes from the kg, runs Zero-False-Positive validation per node (PoC +
  // negative control + CVSS), and writes FINDING nodes back to the kg on
  // confirmation. Sub-commit 3 (step 8.8) reads those FINDING nodes and
  // promotes them into the Tensol `findings` table.
  //
  // Best-effort: failure here does NOT fail the parent assessment. We still
  // ship candidate_findings from step 8 + 8.5 — verifier just enriches them
  // with kg-based validation when the path works. This keeps the prod path
  // robust during Phase 3.1 rollout.
  //
  // Feature flag: TENSOL_VERIFIER_ENABLED=false disables dispatch entirely.
  // Default ON because verifier is the differentiator (XBOW-style ZFP).
  const verifierEnabled =
    (process.env as Record<string, string | undefined>)['TENSOL_VERIFIER_ENABLED'] !== 'false';
  // Phase 3.1 sub-commit 4 (2026-05-12) — kg-aware gate. Tensol-side
  // `candidateFindingIds` counts what workspace extractor parsed from
  // FIND-*.md, which is schema-fragile (upstream recon emits FIND-NNN.md
  // while older Decepticon dossiers used {severity}-{slug}.md). The
  // canonical signal is "did recon write Vulnerability nodes to the kg
  // via Rule 4b". Dispatch verifier when EITHER candidates exist OR kg
  // has vulnerabilities — covers both schema paths.
  const sessionStartedAtUnixSeconds = Math.floor(
    new Date(sessionStartedAtIso).getTime() / 1000,
  );
  const kgVulnCount = verifierEnabled
    ? await queryVulnerabilityCount({ sinceUnixSeconds: sessionStartedAtUnixSeconds })
    : 0;
  const haveSomethingToValidate = candidateFindingIds.length > 0 || kgVulnCount > 0;
  if (verifierEnabled && haveSomethingToValidate) {
    let verifierSessionId: string | null = null;
    try {
      const verifierInitialMessage = [
        `Validate vulnerabilities in the engagement knowledge graph for assessment ${input.assessmentId}.`,
        '',
        'Procedure:',
        '1. kg_query(kind="vulnerability") to list pending VULNERABILITY nodes.',
        '2. For each node: read props (target_url, vuln_class, parameter, etc.), construct a Proof-of-Concept command + matching success pattern + a negative-control command + negative pattern.',
        '3. Call validate_finding(vuln_id, poc_command, success_patterns, negative_command, negative_patterns, cvss_vector).',
        '4. On success the tool auto-creates a FINDING node with VALIDATES edge.',
        '5. Continue until every VULNERABILITY node has been processed.',
        '',
        'Stop when there are no more unvalidated VULNERABILITY nodes. Do NOT scan or attack targets outside the engagement scope listed in the OPPLAN below.',
        '',
        `OPPLAN\n\n${JSON.stringify(opplan, null, 2)}`,
      ].join('\n');

      const verifierHandle = await deps.adapter.start({
        tenantId: input.tenantId,
        opplan,
        assistantId: 'verifier',
        initialMessage: verifierInitialMessage,
      });
      verifierSessionId = verifierHandle.sessionId;

      await emitSignedAudit(deps.db, {
        tenantId: input.tenantId,
        action: 'verifier.session.started',
        outcome: 'success',
        actorType: 'service',
        actorId: COORDINATOR_ACTOR_ID,
        actorName: 'coordinator',
        resourceType: 'decepticon_session',
        resourceId: verifierHandle.sessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        assessmentId: input.assessmentId,
        ip: 'coordinator',
        userAgent: null,
        traceId: input.traceId,
        metadata: {
          parentSessionId: sessionHandle.sessionId,
          candidateCount: candidateFindingIds.length,
        },
      });

      // Drain verifier status until terminal. Adapter enforces an internal
      // wallclock via DECEPTICON_STREAM_MAX_MS (default 15 min) so this loop
      // cannot hang the parent assessment indefinitely.
      let verifierTerminal: SessionStatus = 'started';
      for await (const evt of deps.adapter.streamStatus(verifierHandle.sessionId)) {
        if (evt.status === 'completed' || evt.status === 'failed') {
          verifierTerminal = evt.status;
          break;
        }
      }

      await emitSignedAudit(deps.db, {
        tenantId: input.tenantId,
        action:
          verifierTerminal === 'completed' ? 'verifier.session.completed' : 'verifier.session.failed',
        outcome: verifierTerminal === 'completed' ? 'success' : 'failure',
        actorType: 'service',
        actorId: COORDINATOR_ACTOR_ID,
        actorName: 'coordinator',
        resourceType: 'decepticon_session',
        resourceId: verifierHandle.sessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        assessmentId: input.assessmentId,
        ip: 'coordinator',
        userAgent: null,
        traceId: input.traceId,
        metadata: {
          parentSessionId: sessionHandle.sessionId,
        },
      });
    } catch (verifierErr) {
      // Verifier dispatch errored before drain or during. Emit a failure
      // audit and continue to step 9 — candidate_findings already persisted.
      await emitSignedAudit(deps.db, {
        tenantId: input.tenantId,
        action: 'verifier.session.failed',
        outcome: 'failure',
        actorType: 'service',
        actorId: COORDINATOR_ACTOR_ID,
        actorName: 'coordinator',
        resourceType: 'decepticon_session',
        resourceId: verifierSessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        assessmentId: input.assessmentId,
        ip: 'coordinator',
        userAgent: null,
        traceId: input.traceId,
        metadata: {
          parentSessionId: sessionHandle.sessionId,
          reason: 'dispatch_error',
          error: verifierErr instanceof Error ? verifierErr.message : String(verifierErr),
        },
      });
    }
  }

  // 8.8. Promote verifier-validated findings to the `findings` table
  // (Phase 3.1 sub-commit 3 — 2026-05-12).
  //
  // The verifier agent (dispatched in step 8.7) wrote FINDING nodes to
  // Neo4j with [:VALIDATES]->VULNERABILITY edges for every bug it
  // confirmed. Pull those back via the HTTP API, match each to a Tensol
  // candidate_finding by affected_url substring heuristic, and INSERT
  // into `findings` with high confidence + ZFP validator_log.
  //
  // The `findings` table has a UNIQUE constraint on
  // created_from_candidate_id — a candidate can only be promoted ONCE.
  // We use ON CONFLICT DO NOTHING so a second verifier pass (rare but
  // possible if the operator re-runs) does not throw.
  //
  // Best-effort: any error promotes 0 rows and continues. The parent
  // assessment still completes successfully — verifier-driven promotion
  // is an enrichment layer on top of candidate_findings, not a hard gate.
  let promotedFindingCount = 0;
  let kgFindingTotal = 0;
  if (verifierEnabled && haveSomethingToValidate) {
    try {
      // Re-uses sessionStartedAtUnixSeconds declared at step 8.7 entry.
      const kgFindings: KgValidatedFinding[] = await queryValidatedFindings({
        sinceUnixSeconds: sessionStartedAtUnixSeconds,
      });
      kgFindingTotal = kgFindings.length;
      if (kgFindings.length > 0) {
        // Load all UNPROMOTED candidates for this assessment. A candidate
        // is "unpromoted" when no row in `findings` references it via
        // created_from_candidate_id. Done in a single query so the inner
        // match loop is O(N*M) over RAM only.
        const unpromotedCandidates = await deps.db
          .selectFrom('candidate_findings')
          .leftJoin('findings', 'findings.created_from_candidate_id', 'candidate_findings.id')
          .where('candidate_findings.tenant_id', '=', input.tenantId)
          .where('candidate_findings.assessment_id', '=', input.assessmentId)
          .where('findings.id', 'is', null)
          .select([
            'candidate_findings.id as id',
            'candidate_findings.type as type',
            'candidate_findings.severity as severity',
            'candidate_findings.affected_url as affected_url',
          ])
          .execute();
        const claimedCandidateIds = new Set<string>();
        for (const kgFinding of kgFindings) {
          // Phase 3.1 sub-commit 7 (2026-05-12) — fix matching heuristic.
          // Rule 4b (infra/decepticon-overrides/recon.md) instructs recon to
          // write `target_url` in vuln props (full URL). We also accept the
          // looser `target` key as fallback. Match BIDIRECTIONALLY: kg
          // `target_url` typically includes the candidate's `affected_url`
          // (e.g. kg "...:3000/api/engagements" vs candidate "...:3000"),
          // but the inverse can hold when candidate is more specific.
          const target =
            stringProp(kgFinding.vulnProps, 'target_url') ??
            stringProp(kgFinding.vulnProps, 'target') ??
            stringProp(kgFinding.findingProps, 'target_url') ??
            stringProp(kgFinding.findingProps, 'target') ??
            '';
          const match = unpromotedCandidates.find(
            (c) =>
              !claimedCandidateIds.has(c.id) &&
              target.length > 0 &&
              (c.affected_url.includes(target) || target.includes(c.affected_url)),
          );
          if (!match) continue;
          claimedCandidateIds.add(match.id);
          const reproObj = {
            verifierFindingKey: kgFinding.findingKey,
            verifierFindingLabel: kgFinding.findingLabel,
            verifierFindingProps: kgFinding.findingProps,
            vulnKey: kgFinding.vulnKey,
            vulnLabel: kgFinding.vulnLabel,
          };
          const validatorLogObj = {
            verified_by: 'decepticon_verifier',
            kg_finding_id: kgFinding.findingId,
            kg_vuln_key: kgFinding.vulnKey,
            kg_validated_at: kgFinding.validatedAt,
            vuln_props: kgFinding.vulnProps,
          };
          // ON CONFLICT DO NOTHING — UNIQUE(created_from_candidate_id)
          // protects against double-promotion if verifier re-runs.
          // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary
          const reproJson = JSON.stringify(reproObj) as any;
          // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary
          const validatorLogJson = JSON.stringify(validatorLogObj) as any;
          const findingId = randomUUID();
          await deps.db
            .insertInto('findings')
            .values({
              id: findingId,
              tenant_id: input.tenantId,
              assessment_id: input.assessmentId,
              created_from_candidate_id: match.id,
              type: match.type,
              severity: severityFromKg(kgFinding) ?? match.severity,
              confidence: 'high',
              status: 'open',
              affected_url: match.affected_url,
              reproduction: reproJson,
              validator_log: validatorLogJson,
              validated_at: sql`now()`,
            })
            .onConflict((oc) => oc.column('created_from_candidate_id').doNothing())
            .execute();
          await emitSignedAudit(deps.db, {
            tenantId: input.tenantId,
            action: 'finding.created',
            outcome: 'success',
            actorType: 'service',
            actorId: COORDINATOR_ACTOR_ID,
            actorName: 'coordinator',
            resourceType: 'finding',
            resourceId: findingId,
            ...(input.projectId ? { projectId: input.projectId } : {}),
            assessmentId: input.assessmentId,
            ip: 'coordinator',
            userAgent: null,
            traceId: input.traceId,
            metadata: {
              sessionId: sessionHandle.sessionId,
              source: 'decepticon_verifier',
              kgFindingId: kgFinding.findingId,
              kgVulnKey: kgFinding.vulnKey,
              candidateFindingId: match.id,
            },
          });
          promotedFindingCount += 1;
        }
      }
    } catch {
      // Best-effort: any extractor error promotes 0 findings.
      // assessment.completed still fires below.
    }
  }

  // 9. Mark session completed + emit completed audit.
  await deps.db
    .updateTable('decepticon_sessions')
    .set({
      status: 'completed',
      completed_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .where('tenant_id', '=', input.tenantId)
    .where('id', '=', sessionHandle.sessionId)
    .execute();

  await emitSignedAudit(deps.db, {
      tenantId: input.tenantId,
      action: 'decepticon.session.completed',
      outcome: 'success',
      actorType: 'service',
      actorId: COORDINATOR_ACTOR_ID,
      actorName: 'coordinator',
      resourceType: 'decepticon_session',
      resourceId: sessionHandle.sessionId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      assessmentId: input.assessmentId,
      ip: 'coordinator',
      userAgent: null,
      traceId: input.traceId,
      metadata: {
        opplanArtifactId,
        candidateCount: candidateFindingIds.length,
        // Phase 3.1 sub-commit 3 — verifier-driven promotion stats.
        kgValidatedFindingCount: kgFindingTotal,
        promotedFindingCount,
      },
    },
  );

  // EE-1 (2026-05-12) — assessment terminal transition: running → completed.
  // Mirror of markAssessmentFailed but on success-path. Without this update,
  // assessments stay in 'running' forever after a successful Decepticon session
  // (root cause Bug B from runtime-readiness-2026-05-12).
  await deps.db
    .updateTable('assessments')
    .set({
      state: 'completed',
      version: sql`version + 1`,
      updated_at: sql`now()`,
    })
    .where('tenant_id', '=', input.tenantId)
    .where('id', '=', input.assessmentId)
    .execute();
  await emitSignedAudit(deps.db, {
      tenantId: input.tenantId,
      action: 'assessment.completed',
      outcome: 'success',
      actorType: 'service',
      actorId: COORDINATOR_ACTOR_ID,
      actorName: 'coordinator',
      resourceType: 'assessment',
      resourceId: input.assessmentId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      assessmentId: input.assessmentId,
      ip: 'coordinator',
      userAgent: null,
      traceId: input.traceId,
      metadata: {
        sessionId: sessionHandle.sessionId,
        opplanArtifactId,
        candidateCount: candidateFindingIds.length,
        // Phase 3.1 sub-commit 3 — verifier-driven promotion stats.
        kgValidatedFindingCount: kgFindingTotal,
        promotedFindingCount,
      },
    },
  );

  // Sprint 21 (C3) — additive recon dispatch. Skipped silently when triggerRecon is falsy,
  // primaryDomain is absent, or projectId is null (null projectId fails schema validation).
  if (input.triggerRecon && input.primaryDomain && input.projectId) {
    const reconEnvelope: JobEnvelope = {
      jobId: randomUUID(),
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      assessmentId: input.assessmentId,
      kind: 'recon.subfinder.run',
      idempotencyKey: `${input.parentEnvelope.idempotencyKey}:recon:${input.assessmentId}`,
      createdAt: clockIso(),
      attempt: 0,
      maxAttempts: 3,
      traceId: input.traceId,
      payload: {
        tenantId: input.tenantId,
        projectId: input.projectId ?? null,
        assessmentId: input.assessmentId,
        primaryDomain: input.primaryDomain,
        traceId: input.traceId,
      },
    };
    await deps.queueAdapter.publish(reconEnvelope);
  }

  return {
    sessionId: sessionHandle.sessionId,
    opplanArtifactId,
    candidateFindingIds,
    status: 'completed',
  };
};

// Phase 3.1 sub-commit 3 — helpers for the kg-finding promote path (step 8.8).
//
// `stringProp` reads a string field from Decepticon's parsed `props` JSON.
// Returns undefined on missing or non-string so the caller can fall back.
const stringProp = (obj: Record<string, unknown>, key: string): string | undefined => {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

// Map verifier's `severity` prop onto the candidate_findings severity
// CHECK constraint set. Decepticon may emit "info" lowercase already,
// but normalize to be safe. Returns undefined when severity is missing
// or unrecognized — caller falls back to the candidate's severity.
const VALID_SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
const severityFromKg = (kgFinding: KgValidatedFinding): string | undefined => {
  const candidates = [
    stringProp(kgFinding.findingProps, 'severity'),
    stringProp(kgFinding.vulnProps, 'severity'),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const lower = c.toLowerCase();
    if (VALID_SEVERITIES.has(lower)) return lower;
  }
  return undefined;
};

const markAssessmentFailed = async (
  deps: StartDecepticonDeps,
  input: StartDecepticonInput,
  reason: string,
): Promise<void> => {
  await deps.db
    .updateTable('assessments')
    .set({
      state: 'failed',
      version: sql`version + 1`,
      updated_at: sql`now()`,
    })
    .where('tenant_id', '=', input.tenantId)
    .where('id', '=', input.assessmentId)
    .execute();
  await emitSignedAudit(deps.db, {
      tenantId: input.tenantId,
      action: 'assessment.failed',
      outcome: 'failure',
      actorType: 'service',
      actorId: COORDINATOR_ACTOR_ID,
      actorName: 'coordinator',
      resourceType: 'assessment',
      resourceId: input.assessmentId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      assessmentId: input.assessmentId,
      ip: 'coordinator',
      userAgent: null,
      traceId: input.traceId,
      metadata: {
        cause: 'decepticon_session_failed',
        reason,
      },
    },
  );
};

const sha256OfString = async (s: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(s, 'utf8').digest('hex');
};
