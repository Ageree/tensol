// Sprint 7 §5.4 A-Q-Coord-1, A-Q-Coord-2 — assessment.start envelope handler.
//
// Flow:
//   1. Validate payload (defence in depth; envelope already passed schema).
//   2. Load assessment + scope via Sprint 6 helpers.
//   3. Load assessment_targets.
//   4. For each target → build ScopeActionInput → decide(scope, action).
//      Any deny → ScopeDenyError (terminal). Audit `scope.validate.denied`
//      + `assessment.failed`. Mark assessment state='failed' in same tx as
//      the jobs row update (OQ-7).
//   5. Allow → publish per-target recon.browser.placeholder child jobs.
//   6. Return ack/nack.

import { emitAudit } from '@cyberstrike/audit';
import type { ScopeActionInput } from '@cyberstrike/contracts';
import type { Database } from '@cyberstrike/db';
import {
  type HandlerOutcome,
  type JobEnvelope,
  type QueueAdapter,
  ScopeDenyError,
} from '@cyberstrike/queue';
import type {
  Clock,
  DnsResolver,
  EffectiveScope,
  RateLimitCounter,
} from '@cyberstrike/scope-engine';
import { decide } from '@cyberstrike/scope-engine';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { type BrowserChildTargetSpec, publishReconBrowserChildJobs } from './browser-child-job.ts';
import { type ChildTargetSpec, publishReconChildJobs } from './child-job.ts';
import { assessmentStartPayloadSchema } from './payloads.ts';

/**
 * Sprint 8 — orchestrate the fake-decepticon session for a scope-validated
 * assessment. Provided by apps/api/src/scope-engine/start-decepticon-session.ts;
 * passed in as a function to keep services/coordinator free of a hard
 * dependency on the API package.
 */
export interface DecepticonRunnerInput {
  readonly tenantId: string;
  readonly projectId: string | null;
  readonly assessmentId: string;
  readonly scope: EffectiveScope;
  readonly traceId: string;
  readonly parentEnvelope: JobEnvelope;
}

export interface DecepticonRunnerResult {
  readonly status: 'completed' | 'failed';
  readonly failureReason?: string;
}

export type DecepticonRunner = (input: DecepticonRunnerInput) => Promise<DecepticonRunnerResult>;

export interface CoordinatorScopeDeps {
  readonly dns: DnsResolver;
  readonly clock: Clock;
  readonly rateLimit: RateLimitCounter;
}

export interface StartHandlerDeps {
  readonly db: Kysely<Database>;
  readonly adapter: QueueAdapter;
  readonly scopeDeps: CoordinatorScopeDeps;
  /**
   * Build the scope for a given assessment id. Defaults to
   * `apps/api/src/scope-engine/build-scope.ts#buildScopeForAssessment` —
   * passed in by API process at coordinator setup. Tests inject mocks.
   */
  readonly buildScope: (assessmentId: string) => Promise<EffectiveScope | null>;
  /**
   * Sprint 8 — fake decepticon orchestration runner. When provided, the
   * coordinator runs the session AFTER scope-validation passes. Optional so
   * Sprint 7 ITs that don't supply one keep working.
   */
  readonly decepticonRunner?: DecepticonRunner;
  /** Test seam — defaults to crypto.randomUUID(). */
  readonly randomUUID?: () => string;
  /** Test seam — defaults to () => new Date().toISOString(). */
  readonly clockIso?: () => string;
}

interface AssessmentTargetRow {
  readonly target_id: string;
  readonly kind: string;
  readonly value: string;
}

const loadTargetsForAssessment = async (
  db: Kysely<Database>,
  tenantId: string,
  assessmentId: string,
): Promise<AssessmentTargetRow[]> => {
  const rows = await db
    .selectFrom('assessment_targets as at')
    .innerJoin('targets as t', (join) =>
      join.onRef('t.id', '=', 'at.target_id').onRef('t.tenant_id', '=', 'at.tenant_id'),
    )
    .select(['t.id as target_id', 't.kind', 't.value'])
    .where('at.tenant_id', '=', tenantId)
    .where('at.assessment_id', '=', assessmentId)
    .execute();
  return rows.map((r) => ({
    target_id: String(r.target_id),
    kind: String(r.kind),
    value: String(r.value),
  }));
};

const targetToActionInput = (target: AssessmentTargetRow): ScopeActionInput => {
  const kind = target.kind;
  const value = target.value;
  // Default to http_request for url/domain targets — Sprint 9 will refine
  // by introspecting target.kind. For now, this matches Sprint 6 build-scope
  // semantics (canonical URL or host derived from value).
  if (kind === 'url' || value.startsWith('http://') || value.startsWith('https://')) {
    return { kind: 'http_request', url: value, method: 'GET' };
  }
  if (kind === 'ip') {
    return { kind: 'tcp_connect', host: value, port: 80 };
  }
  // domain / fallback
  return { kind: 'http_request', url: `https://${value}`, method: 'GET' };
};

const targetUrlForChild = (target: AssessmentTargetRow): string => {
  if (target.kind === 'url') return target.value;
  // B6 (Sprint 13): bare IPs are not valid URLs; wrap as http://<ip>/ so the
  // recon.browser payload passes zod's z.string().url() validation. IP-kind
  // targets go through the network/recon path, not full browser crawl, but
  // the envelope schema still requires a URL-shaped string.
  if (target.kind === 'ip') return `http://${target.value}/`;
  return `https://${target.value}`;
};

/**
 * A-Q-Coord-2 — assessment.start handler.
 *
 * Returns HandlerOutcome consumed by the subscribe-loop's auto-ack/nack.
 */
export const handleAssessmentStart = async (
  deps: StartHandlerDeps,
  envelope: JobEnvelope,
): Promise<HandlerOutcome> => {
  // Step 1 — payload validation (defence in depth).
  const payloadResult = assessmentStartPayloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('invalid_payload', ['envelope_payload_schema_mismatch']),
    };
  }

  // Step 2 — load scope.
  const scope = await deps.buildScope(envelope.assessmentId);
  if (!scope) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('assessment_not_found', ['assessment_not_found']),
    };
  }

  // Step 3 — load assessment_targets.
  const targets = await loadTargetsForAssessment(deps.db, envelope.tenantId, envelope.assessmentId);

  if (targets.length === 0) {
    return await markFailedAndNack(deps, envelope, 'no_targets', ['no_targets']);
  }

  // Step 4 — per-target scope decisions. First deny terminates.
  for (const target of targets) {
    const action = targetToActionInput(target);
    const decision = await decide(scope, action, deps.scopeDeps);
    if (!decision.allowed) {
      return await markFailedAndNack(deps, envelope, decision.reason, [
        ...decision.matchedDenyRuleIds,
      ]);
    }
  }

  // Sprint 8 — start the decepticon session BEFORE publishing recon child
  // jobs. If the session fails (crash mid-stream), the runner has already
  // marked the assessment as `failed` and emitted audits; we surface a
  // terminal nack so the queue stops retrying.
  if (deps.decepticonRunner) {
    const runResult = await deps.decepticonRunner({
      tenantId: envelope.tenantId,
      projectId: envelope.projectId ?? null,
      assessmentId: envelope.assessmentId,
      scope,
      traceId: envelope.traceId,
      parentEnvelope: envelope,
    });
    if (runResult.status === 'failed') {
      return {
        kind: 'nack',
        error: new ScopeDenyError(runResult.failureReason ?? 'decepticon_session_failed', []),
      };
    }
  }

  // Step 5 — allow path: publish per-target child jobs.
  const childTargets: ChildTargetSpec[] = targets.map((t) => ({
    targetId: t.target_id,
    targetUrl: targetUrlForChild(t),
  }));
  await publishReconChildJobs({
    adapter: deps.adapter,
    parent: envelope,
    targets: childTargets,
    ...(deps.randomUUID ? { randomUUID: deps.randomUUID } : {}),
    ...(deps.clockIso ? { clockIso: deps.clockIso } : {}),
  });

  // Sprint 9 — also publish `recon.browser` envelopes per target so the
  // browser-worker can run the scope-guarded crawl. Placeholder envelopes
  // above are retained for Sprint 7 IT back-compat (deprecated; remove in
  // Sprint 10+ once those tests migrate).
  const browserTargets: BrowserChildTargetSpec[] = targets.map((t) => ({
    targetId: t.target_id,
    startUrl: targetUrlForChild(t),
  }));
  await publishReconBrowserChildJobs({
    adapter: deps.adapter,
    parent: envelope,
    targets: browserTargets,
    ...(deps.randomUUID ? { randomUUID: deps.randomUUID } : {}),
    ...(deps.clockIso ? { clockIso: deps.clockIso } : {}),
  });

  // A-Q-Audit-2 inline-note — NO additional audit on allow path. The route's
  // `assessment.started` (Sprint 5) is the single audit row for a successful
  // start. Per-target child publishes do NOT drip audit rows. Sprint 8 adds
  // session lifecycle audits via the decepticonRunner above.
  return { kind: 'ack' };
};

/**
 * Coordinator deny path (OQ-7 + A-Q-Scope-1):
 *   - update assessment.state='failed' AND emit `scope.validate.denied`
 *     + `assessment.failed` audit rows.
 *   - the `jobs.status='failed_terminal'` mutation is done by the subscribe
 *     loop (it reacts to ScopeDenyError via the retry-classifier).
 *   - audit emission happens AFTER the assessment-state UPDATE commits.
 */
const markFailedAndNack = async (
  deps: StartHandlerDeps,
  envelope: JobEnvelope,
  reason: string,
  matchedDenyRuleIds: readonly string[],
): Promise<HandlerOutcome> => {
  await deps.db
    .updateTable('assessments')
    .set({
      state: 'failed',
      version: sql`version + 1`,
      updated_at: sql`now()`,
    })
    .where('tenant_id', '=', envelope.tenantId)
    .where('id', '=', envelope.assessmentId)
    .execute();

  const traceId = envelope.traceId;
  await emitAudit(
    { db: deps.db },
    {
      tenantId: envelope.tenantId,
      action: 'scope.validate.denied',
      outcome: 'denied',
      actorType: 'service',
      actorId: 'coordinator',
      actorName: 'coordinator',
      resourceType: 'assessment',
      resourceId: envelope.assessmentId,
      ...(envelope.projectId ? { projectId: envelope.projectId } : {}),
      assessmentId: envelope.assessmentId,
      ip: 'coordinator',
      userAgent: null,
      traceId,
      metadata: {
        reason,
        matchedDenyRuleIds: [...matchedDenyRuleIds],
        cause: 'coordinator_pre_dispatch',
        jobId: envelope.jobId,
      },
    },
  );
  await emitAudit(
    { db: deps.db },
    {
      tenantId: envelope.tenantId,
      action: 'assessment.failed',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'coordinator',
      actorName: 'coordinator',
      resourceType: 'assessment',
      resourceId: envelope.assessmentId,
      ...(envelope.projectId ? { projectId: envelope.projectId } : {}),
      assessmentId: envelope.assessmentId,
      ip: 'coordinator',
      userAgent: null,
      traceId,
      metadata: {
        cause: 'scope_deny',
        matchedDenyRuleIds: [...matchedDenyRuleIds],
        jobId: envelope.jobId,
      },
    },
  );

  return {
    kind: 'nack',
    error: new ScopeDenyError(reason, matchedDenyRuleIds),
  };
};
