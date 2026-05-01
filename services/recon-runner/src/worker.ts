// Sprint 21 — recon-runner worker: pipeline orchestrator.
//
// Envelope: recon.subfinder.run
// Flow:
//   1. Parse payload (zod schema).
//   2. Load assessment from DB (tenant + project binding — B2/HIGH-2).
//   3. Build effective scope via injectable buildScope (matches validator-worker pattern).
//   4. Run subfinder on primaryDomain → discovered hosts.
//   5. Probe httpx on discovered hosts (+ primaryDomain fallback per C1).
//   6. Run nuclei on httpx-alive urls.
//   7. Persist domain targets for SCOPE-APPROVED hosts only (HIGH-1 fix).
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

const extractHost = (url: string): string | null => {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
};

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
  assessmentId: string | null,
  projectId: string | null,
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
    // Null-safe: denied path passes null to avoid FK throw on ghost assessmentIds.
    resourceId: assessmentId,
    projectId,
    assessmentId: assessmentId ?? '',
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

  // 2. Load assessment + tenant + project binding (B2/HIGH-2 — DB vs envelope cross-source).
  // Not-found, tenant-mismatch, and project-mismatch all collapse to denied+ack.
  // Audit uses null resourceId/assessmentId to avoid FK throw on ghost assessmentIds.
  // After binding, use DB-sourced projectId as sole source of truth (ignore payload.projectId).
  const assessment = await deps.assessmentLoader({ tenantId, assessmentId });
  if (!assessment || assessment.tenantId !== tenantId) {
    await emitAudit(
      deps.auditEmitter,
      tenantId,
      null,
      null,
      traceId,
      'recon.subfinder.denied',
      'denied',
      { reason: 'assessment_mismatch' },
    );
    return { kind: 'ack' };
  }
  if (assessment.projectId !== projectId) {
    await emitAudit(
      deps.auditEmitter,
      tenantId,
      null,
      null,
      traceId,
      'recon.subfinder.denied',
      'denied',
      { reason: 'project_mismatch' },
    );
    return { kind: 'ack' };
  }

  // boundProjectId: DB-verified match to payload projectId; use payload value (non-null UUID)
  // as the authoritative projectId downstream — safe because the equality check above confirms
  // assessment.projectId === projectId (both refer to the same project).
  const boundProjectId = projectId;

  // 3. Build effective scope (injectable — matches validator-worker pattern).
  const scope = await deps.buildScope(assessmentId);

  const commonDeps = {
    auditEmitter: deps.auditEmitter,
    tenantId,
    assessmentId,
    projectId: boundProjectId,
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

  // 7. Persist domain targets for SCOPE-APPROVED hosts only (HIGH-1 fix).
  // aliveResults are already scope-gated by probeHttpx — reuse that approved set
  // rather than persisting every raw subfinder yield (which may include OOS hosts).
  if (deps.targetWriter && aliveResults.length > 0) {
    for (const result of aliveResults) {
      const host = extractHost(result.url);
      if (!host) continue;
      try {
        await deps.targetWriter({
          tenantId,
          projectId: boundProjectId,
          kind: 'domain',
          value: host,
        });
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
