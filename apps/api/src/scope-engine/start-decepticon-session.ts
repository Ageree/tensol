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

import { emitAudit } from '@cyberstrike/audit';
import type { ServiceActorId } from '@cyberstrike/contracts';
import type { Database } from '@cyberstrike/db';
import {
  type DecepticonAdapter,
  NotImplementedError,
  type Opplan,
  type SessionStatus,
} from '@cyberstrike/decepticon-adapter';
import type { ObjectStorage } from '@cyberstrike/object-storage';
import type { JobEnvelope, QueueAdapter } from '@cyberstrike/queue';
import type { EffectiveScope, NormalizedRule } from '@cyberstrike/scope-engine';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

const COORDINATOR_ACTOR_ID: ServiceActorId = 'coordinator';

export interface StartDecepticonDeps {
  readonly db: Kysely<Database>;
  readonly adapter: DecepticonAdapter;
  readonly objectStorage: ObjectStorage;
  readonly queueAdapter: QueueAdapter;
  /** Test seam — defaults to crypto.randomUUID(). */
  readonly randomUUID?: () => string;
  /** Test seam — defaults to () => new Date().toISOString(). */
  readonly clockIso?: () => string;
}

export interface StartDecepticonInput {
  readonly tenantId: string;
  readonly projectId: string | null;
  readonly assessmentId: string;
  readonly scope: EffectiveScope;
  readonly traceId: string;
  /** Parent assessment.start envelope — used to chain idempotency keys. */
  readonly parentEnvelope: JobEnvelope;
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
    engagementProfile: 'recon-only',
    foothold: false,
    postExploit: false,
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
    })
    .execute();

  // 6. Emit started audit.
  await emitAudit(
    { db: deps.db },
    {
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

    await emitAudit(
      { db: deps.db },
      {
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

  // 8. Drain candidate stream → persist + republish + audit.
  const candidateFindingIds: string[] = [];
  for await (const candidate of deps.adapter.streamCandidates(sessionHandle.sessionId)) {
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

    // Republish as decepticon.findings envelope (Sprint 10 validator will
    // subscribe). Idempotency key chains parent.envelope.idempotencyKey + the
    // candidateFindingId so retries stay deduped.
    const childEnvelope: JobEnvelope = {
      jobId: randomUUID(),
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      assessmentId: input.assessmentId,
      kind: 'decepticon.findings',
      idempotencyKey: `${input.parentEnvelope.idempotencyKey}:cand:${candidateFindingId}`,
      createdAt: clockIso(),
      attempt: 0,
      maxAttempts: 3,
      traceId: input.traceId,
      payload: {
        sessionId: sessionHandle.sessionId,
        candidateId: candidate.candidateId,
        candidateFindingId,
        type: candidate.type,
        severity: candidate.severity,
        affectedUrl: candidate.affectedUrl,
        source: candidate.source,
      },
    };
    await deps.queueAdapter.publish(childEnvelope);

    // Sprint 10 — also publish a `validate.finding` envelope so the
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

    await emitAudit(
      { db: deps.db },
      {
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

  await emitAudit(
    { db: deps.db },
    {
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
      },
    },
  );

  return {
    sessionId: sessionHandle.sessionId,
    opplanArtifactId,
    candidateFindingIds,
    status: 'completed',
  };
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
  await emitAudit(
    { db: deps.db },
    {
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
