// Sprint 21 — recon-runner worker: pipeline orchestrator.
//
// Envelope: recon.subfinder.run
// Flow:
//   1. Parse payload (zod schema).
//   2. Load assessment from DB (tenant binding — B2).
//   3. Build effective scope via injectable buildScope (matches validator-worker pattern).
//   4. Run subfinder on primaryDomain → discovered hosts.
//   5. Probe httpx on discovered hosts (+ primaryDomain fallback per C1).
//   6. Run nuclei on httpx-alive urls.
//   7. Persist domain targets for every discovered host (best-effort, upsert-safe).
//   8. Terminal-ack on completion; transient nack on unhandled errors.

import type { AuditAction, AuditOutcome, ServiceActorId } from '@cyberstrike/contracts';
import type { HandlerOutcome, JobEnvelope } from '@cyberstrike/queue';
import type { EffectiveScope } from '@cyberstrike/scope-engine';
import type { ValidatorScopeDeps } from '@cyberstrike/validators';
import { probeHttpx } from './httpx.ts';
import { runNuclei } from './nuclei.ts';
import { reconSubfinderRunPayloadSchema } from './payload-schema.ts';
import { runSubfinder } from './subfinder.ts';

const RECON_ACTOR_ID: ServiceActorId = 'recon-runner';

// ============================================================================
// Shared AuditEmitter types — re-exported so subfinder/httpx/nuclei can import
// from './worker.ts' (matches validator-worker pattern).
// ============================================================================

export interface AuditEmitterArgs {
  readonly tenantId: string;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly actorType: 'service';
  readonly actorId: ServiceActorId;
  readonly actorName: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly projectId?: string | null;
  readonly assessmentId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly traceId: string;
  readonly metadata: Record<string, unknown>;
}

export type AuditEmitter = (args: AuditEmitterArgs) => Promise<void>;

// ============================================================================
// Assessment loader — same shape as validator-worker (no scopeRules, scope built
// by injectable buildScope to avoid coupling to DB schema here).
// ============================================================================

export interface AssessmentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string | null;
}

export type AssessmentLoader = (input: {
  tenantId: string;
  assessmentId: string;
}) => Promise<AssessmentRow | null>;

export type TargetWriter = (input: {
  tenantId: string;
  projectId: string;
  kind: 'domain';
  value: string;
}) => Promise<void>;

// ============================================================================
// Worker deps.
// ============================================================================

export interface ReconWorkerDeps {
  readonly subfinderBin?: string;
  readonly httpxBin?: string;
  readonly nucleiBin?: string;
  readonly auditEmitter: AuditEmitter;
  readonly assessmentLoader: AssessmentLoader;
  readonly buildScope: (assessmentId: string) => Promise<EffectiveScope | null>;
  readonly targetWriter?: TargetWriter;
  readonly scopeDeps: ValidatorScopeDeps;
  readonly subfinderTimeoutMs?: number;
  readonly httpxTimeoutMs?: number;
  readonly nucleiTimeoutMs?: number;
}

// ============================================================================
// Handler.
// ============================================================================

const emitAudit = async (
  auditEmitter: AuditEmitter,
  tenantId: string,
  assessmentId: string,
  projectId: string,
  traceId: string,
  action: AuditAction,
  outcome: 'success' | 'denied' | 'failure',
  metadata: Record<string, unknown>,
): Promise<void> => {
  await auditEmitter({
    tenantId,
    action,
    outcome,
    actorType: 'service',
    actorId: RECON_ACTOR_ID,
    actorName: 'recon-runner',
    resourceType: 'assessment',
    resourceId: assessmentId,
    projectId,
    assessmentId,
    ip: null,
    userAgent: null,
    traceId,
    metadata,
  });
};

export const handleReconSubfinderRun = async (
  envelope: JobEnvelope,
  deps: ReconWorkerDeps,
): Promise<HandlerOutcome> => {
  // 1. Parse payload.
  const parseResult = reconSubfinderRunPayloadSchema.safeParse(envelope.payload);
  if (!parseResult.success) {
    return { kind: 'nack', error: new Error(`invalid_payload: ${parseResult.error.message}`) };
  }
  const payload = parseResult.data;
  const { tenantId, assessmentId, projectId, primaryDomain, traceId } = payload;

  // 2. Load assessment + tenant binding (B2 — DB vs envelope cross-source check).
  // Both not-found and tenant-mismatch collapse to denied+ack (not nack) — a forged
  // or stale envelope must not retry, so we ack-and-drop with an audit trail.
  const assessment = await deps.assessmentLoader({ tenantId, assessmentId });
  if (!assessment || assessment.tenantId !== tenantId) {
    await emitAudit(
      deps.auditEmitter,
      tenantId,
      assessmentId,
      projectId,
      traceId,
      'recon.subfinder.denied',
      'denied',
      { reason: 'assessment_mismatch' },
    );
    return { kind: 'ack' };
  }

  // 3. Build effective scope (injectable — matches validator-worker pattern).
  const scope = await deps.buildScope(assessmentId);

  const commonDeps = {
    auditEmitter: deps.auditEmitter,
    tenantId,
    assessmentId,
    projectId,
    traceId,
    scopeDeps: deps.scopeDeps,
    scope,
  };

  // 4. Run subfinder.
  const discoveredHosts = await runSubfinder(primaryDomain, {
    ...commonDeps,
    subfinderBin: deps.subfinderBin,
    timeoutMs: deps.subfinderTimeoutMs,
  });

  // C1 — subfinder absent / no yields: fall back to probing the primary domain.
  const probeUrls =
    discoveredHosts.length > 0
      ? discoveredHosts.map((h) => `https://${h}/`)
      : [`https://${primaryDomain}/`];

  // 5. Run httpx.
  const aliveResults = await probeHttpx(probeUrls, {
    ...commonDeps,
    httpxBin: deps.httpxBin,
    timeoutMs: deps.httpxTimeoutMs,
  });

  // 7. Persist domain targets for every discovered host (best-effort; upsert-safe).
  if (deps.targetWriter && discoveredHosts.length > 0) {
    for (const host of discoveredHosts) {
      try {
        await deps.targetWriter({ tenantId, projectId, kind: 'domain', value: host });
      } catch {
        // best-effort
      }
    }
  }

  // 6. Run nuclei on alive urls.
  const nucleiUrls = aliveResults.map((r) => r.url);
  if (nucleiUrls.length > 0) {
    await runNuclei(nucleiUrls, {
      ...commonDeps,
      nucleiBin: deps.nucleiBin,
      timeoutMs: deps.nucleiTimeoutMs,
    });
  }

  return { kind: 'ack' };
};
