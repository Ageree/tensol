// Sprint 10 — handleValidateFinding: the validate.finding envelope handler.
//
// Flow:
//   1. Parse payload (defence in depth).
//   2. Load candidate row + scope + assessment.
//   3. Emit `validation.started` audit.
//   4. Wrap the driver in a recorder that captures every replay result so
//      the worker can persist evidence bytes after the validator completes.
//   5. Run validateXssReflected with the recording driver.
//   6. On `confirmed`: persist evidence (object storage + finding_evidence
//      rows), insert findings row via the DirectInsertForbidden-guarded
//      repo, emit `validation.confirmed` + `finding.created` audits, ack.
//   7. On `rejected` / `inconclusive` / `out_of_scope`: NO findings insert,
//      emit corresponding audit, ack.
//   8. On unique-violation race during findings insert: swallow + ack
//      (idempotent — A-V-Idempotent).
//   9. On non-timeout driver throw: bubble up as transient nack. The xss
//      validator catches BrowserReplayTimeoutError internally and returns
//      `inconclusive` with reason `timeout` (A-V-Hang).

import type { AuditAction, AuditOutcome, ServiceActorId } from '@cyberstrike/contracts';
import type { FindingValidationStatus, ValidatedByLike } from '@cyberstrike/db';
import type { ObjectStorage } from '@cyberstrike/object-storage';
import { type HandlerOutcome, type JobEnvelope, ScopeDenyError } from '@cyberstrike/queue';
import type { EffectiveScope } from '@cyberstrike/scope-engine';
import {
  type ValidationInput,
  type ValidationResult,
  type ValidatorScopeDeps,
  type XssReplayDriver,
  type XssReplayInput,
  type XssReplayResult,
  collectEvidence,
  evidenceObjectKey,
  validateXssReflected,
} from '@cyberstrike/validators';
import type { z } from 'zod';
import type { ValidateFindingPayload } from './payload-schema.ts';
import { validateSsrfCandidate } from './ssrf-validator.ts';

const VALIDATOR_WORKER_ACTOR_ID: ServiceActorId = 'validator-worker';

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

export interface CandidateRow {
  readonly id: string;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly type: string;
  readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  readonly affectedUrl: string;
  readonly source: string;
  readonly payload: unknown;
}

export type CandidateLoader = (input: {
  tenantId: string;
  candidateFindingId: string;
}) => Promise<CandidateRow | null>;

export interface AssessmentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string | null;
}

export type AssessmentLoader = (input: {
  tenantId: string;
  assessmentId: string;
}) => Promise<AssessmentRow | null>;

export interface FindingsWriterInput {
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly candidateFindingId: string;
  readonly type: string;
  readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  readonly confidence: 'low' | 'medium' | 'high';
  readonly affectedUrl: string;
  readonly reproduction: Record<string, unknown>;
  readonly validatorLog: ReadonlyArray<Record<string, unknown>>;
  readonly validatedAt: Date;
  readonly validatedBy: ValidatedByLike;
}

export type FindingsWriter = (input: FindingsWriterInput) => Promise<{ id: string }>;

export interface FindingEvidenceWriterInput {
  readonly tenantId: string;
  readonly findingId: string;
  readonly kind: 'screenshot' | 'har' | 'trace' | 'json' | 'log';
  readonly objectStorageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly metadata: Record<string, unknown>;
}

export type FindingEvidenceWriter = (input: FindingEvidenceWriterInput) => Promise<{ id: string }>;

/**
 * Look up an existing findings row by candidateFindingId. Used by the
 * idempotent-loser repair path (codex iter-2 P1) — when the unique
 * constraint fires, we still need the existing row's id so we can
 * (a) backfill missing finding_evidence rows and (b) decide whether
 * `finding.created` was already audited.
 */
export type FindingByCandidateLoader = (input: {
  tenantId: string;
  candidateFindingId: string;
}) => Promise<{ id: string } | null>;

/**
 * Count finding_evidence rows tied to the given findingId. Used by the
 * idempotent-loser repair path to decide whether bytes need to be
 * (re)persisted.
 */
export type EvidenceCounter = (input: {
  tenantId: string;
  findingId: string;
}) => Promise<number>;

/**
 * Check whether a `finding.created` audit row already exists for the
 * given findingId. Used by the idempotent-loser repair path to avoid
 * double-emitting the audit while still backfilling it when the original
 * winner crashed before emission.
 */
export type FindingCreatedAuditChecker = (input: {
  tenantId: string;
  findingId: string;
}) => Promise<boolean>;

export interface ValidatorWorkerDeps {
  readonly driver: XssReplayDriver;
  readonly objectStorage: ObjectStorage;
  readonly buildScope: (assessmentId: string) => Promise<EffectiveScope | null>;
  readonly scopeDeps: ValidatorScopeDeps;
  readonly auditEmitter: AuditEmitter;
  readonly candidateLoader: CandidateLoader;
  readonly assessmentLoader: AssessmentLoader;
  readonly findingsWriter: FindingsWriter;
  readonly findingEvidenceWriter: FindingEvidenceWriter;
  /** Codex iter-2 P1 — idempotent-loser repair deps. */
  readonly findingByCandidateLoader: FindingByCandidateLoader;
  readonly evidenceCounter: EvidenceCounter;
  readonly findingCreatedAuditChecker: FindingCreatedAuditChecker;
  /** Defence-in-depth payload schema. */
  readonly payloadSchema: z.ZodType<ValidateFindingPayload>;
  /** Test seam — defaults to () => new Date(). */
  readonly clock?: () => Date;
  // Sprint 18 — SSRF replay deps.
  readonly oobCallbackLoader?: (token: string) => Promise<boolean>;
  readonly oobVerifyTimeoutMs?: number;
  readonly ssrfHttpClient?: { get(url: string): Promise<void>; readonly callCount: number };
}

const STATUS_TO_ACTION: Record<string, AuditAction> = {
  confirmed: 'validation.confirmed',
  rejected: 'validation.rejected',
  inconclusive: 'validation.inconclusive',
  out_of_scope: 'validation.out_of_scope',
};
const STATUS_TO_OUTCOME: Record<string, AuditOutcome> = {
  confirmed: 'success',
  rejected: 'success',
  inconclusive: 'success',
  out_of_scope: 'denied',
};

const emitLifecycleAudit = async (
  deps: ValidatorWorkerDeps,
  envelope: JobEnvelope,
  payload: ValidateFindingPayload,
  action: AuditAction,
  outcome: AuditOutcome,
  metadata: Record<string, unknown>,
): Promise<void> => {
  await deps.auditEmitter({
    tenantId: payload.tenantId,
    action,
    outcome,
    actorType: 'service',
    actorId: VALIDATOR_WORKER_ACTOR_ID,
    actorName: 'validator-worker',
    resourceType: 'candidate_finding',
    resourceId: payload.candidateFindingId,
    ...(payload.projectId ? { projectId: payload.projectId } : {}),
    assessmentId: payload.assessmentId,
    ip: 'validator-worker',
    userAgent: null,
    traceId: payload.traceId,
    metadata: { ...metadata, jobId: envelope.jobId },
  });
};

const isUniqueViolation = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const message = String((err as Error).message ?? '');
  return (
    message.includes('duplicate key value violates unique') ||
    message.includes('23505') ||
    message.includes('created_from_candidate')
  );
};

/**
 * Recording wrapper around an XssReplayDriver. The validator calls
 * `replay()` twice; the wrapper passes through to the inner driver and
 * captures every result so the worker can persist evidence bytes after
 * the validator returns its ValidationResult.
 */
class RecordingDriver implements XssReplayDriver {
  readonly results: XssReplayResult[] = [];
  constructor(private readonly inner: XssReplayDriver) {}
  async replay(input: XssReplayInput): Promise<XssReplayResult> {
    const out = await this.inner.replay(input);
    this.results.push(out);
    return out;
  }
}

export const handleValidateFinding = async (
  deps: ValidatorWorkerDeps,
  envelope: JobEnvelope,
): Promise<HandlerOutcome> => {
  // 1. Parse payload.
  const parsed = deps.payloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('invalid_validate_finding_payload', [
        'validate_finding_payload_schema_mismatch',
      ]),
    };
  }
  const payload = parsed.data;

  // 2. Load candidate + assessment + scope.
  const candidate = await deps.candidateLoader({
    tenantId: payload.tenantId,
    candidateFindingId: payload.candidateFindingId,
  });
  if (!candidate) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('candidate_not_found', ['candidate_not_found']),
    };
  }
  const assessment = await deps.assessmentLoader({
    tenantId: payload.tenantId,
    assessmentId: payload.assessmentId,
  });
  if (!assessment) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('assessment_not_found', ['assessment_not_found']),
    };
  }
  const scope = await deps.buildScope(payload.assessmentId);

  // 3. Lifecycle start audit.
  await emitLifecycleAudit(deps, envelope, payload, 'validation.started', 'success', {
    candidateType: payload.candidateType,
    affectedUrl: candidate.affectedUrl,
  });

  // 4. Run validator with a recording driver wrapper.
  const recordingDriver = new RecordingDriver(deps.driver);
  const input: ValidationInput = {
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    assessmentId: payload.assessmentId,
    candidateFindingId: payload.candidateFindingId,
    candidateType: 'xss_reflected',
    affectedUrl: candidate.affectedUrl,
    payload: candidate.payload,
    traceId: payload.traceId,
  };

  let result: ValidationResult;
  try {
    result = await validateXssReflected(input, {
      driver: recordingDriver,
      scope,
      scopeDeps: deps.scopeDeps,
    });
  } catch (err) {
    return {
      kind: 'nack',
      error: err instanceof Error ? err : new Error('validator_unknown_error'),
    };
  }

  // 5. Branch on status.
  const lifecycleAction = STATUS_TO_ACTION[result.status];
  const lifecycleOutcome = STATUS_TO_OUTCOME[result.status];
  if (!lifecycleAction || !lifecycleOutcome) {
    return {
      kind: 'nack',
      error: new ScopeDenyError(`unknown_validation_status:${result.status}`, []),
    };
  }

  if (result.status !== 'confirmed') {
    await emitLifecycleAudit(deps, envelope, payload, lifecycleAction, lifecycleOutcome, {
      reason: result.reason,
      proofType: result.proofType,
      confidence: result.confidence,
    });
    return { kind: 'ack' };
  }

  // 6. Confirmed path: insert findings via DirectInsertForbidden-guarded repo.
  const validatedByForRepo: { status: FindingValidationStatus } = { status: result.status };
  const reproduction = {
    affectedUrl: candidate.affectedUrl,
    proofType: result.proofType,
    confidence: result.confidence,
    runCount: recordingDriver.results.length,
  };
  const validatedAt = new Date(result.validatedAt);

  let findingId: string;
  try {
    const inserted = await deps.findingsWriter({
      tenantId: payload.tenantId,
      assessmentId: payload.assessmentId,
      candidateFindingId: payload.candidateFindingId,
      type: 'xss_reflected',
      severity: severityFor(candidate.severity),
      confidence: result.confidence,
      affectedUrl: candidate.affectedUrl,
      reproduction,
      validatorLog: result.log,
      validatedAt,
      validatedBy: validatedByForRepo,
    });
    findingId = inserted.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Codex iter-2 P1 — idempotent-loser repair path.
      //
      // Bug it closes: the original winner inserted the findings row but
      // crashed (or hit a transient storage/DB failure) BEFORE persisting
      // evidence and/or emitting `finding.created`. The retry hits this
      // branch. The pre-iter-2 code returned ack here, leaving the
      // confirmed finding without its replay evidence permanently.
      //
      // Repair sequence:
      //   1. Load the existing findings row by candidateFindingId.
      //   2. Count finding_evidence rows. If 0, re-run persistEvidence
      //      with the bytes captured by THIS replay (driver was already
      //      called above; recorder has the runs).
      //   3. Check if `finding.created` was ever audited. If not, emit it
      //      now (so downstream consumers see it exactly once across
      //      all worker replays).
      //   4. Always emit the lifecycle `validation.confirmed` audit with
      //      idempotentLoser=true + repair counters so operators can
      //      diagnose race recovery.
      const existing = await deps.findingByCandidateLoader({
        tenantId: payload.tenantId,
        candidateFindingId: payload.candidateFindingId,
      });
      if (!existing) {
        // Should not happen — unique violation implies the row exists.
        // Surface as transient nack so the queue retries; if the row
        // never materialises, it terminates after maxAttempts.
        return {
          kind: 'nack',
          error: new Error('idempotent_loser_existing_finding_not_found'),
        };
      }
      let evidenceRepaired = false;
      try {
        const existingCount = await deps.evidenceCounter({
          tenantId: payload.tenantId,
          findingId: existing.id,
        });
        if (existingCount === 0) {
          await persistEvidence(deps, {
            tenantId: payload.tenantId,
            findingId: existing.id,
            runs: recordingDriver.results,
          });
          evidenceRepaired = true;
        }
      } catch (evErr) {
        // Repair failed (storage/DB transient) → nack so the queue
        // retries the whole envelope. Next attempt will see evidence
        // count > 0 if the partial repair landed any rows, or zero again
        // and retry the whole batch.
        return {
          kind: 'nack',
          error: evErr instanceof Error ? evErr : new Error('evidence_repair_unknown_error'),
        };
      }

      let findingCreatedAuditEmitted = false;
      try {
        const alreadyAudited = await deps.findingCreatedAuditChecker({
          tenantId: payload.tenantId,
          findingId: existing.id,
        });
        if (!alreadyAudited) {
          await emitLifecycleAudit(deps, envelope, payload, 'finding.created', 'success', {
            findingId: existing.id,
            candidateFindingId: payload.candidateFindingId,
            severity: severityFor(candidate.severity),
            confidence: result.confidence,
            emittedByIdempotentLoser: true,
          });
          findingCreatedAuditEmitted = true;
        }
      } catch (audErr) {
        return {
          kind: 'nack',
          error:
            audErr instanceof Error ? audErr : new Error('finding_created_audit_repair_unknown'),
        };
      }

      await emitLifecycleAudit(deps, envelope, payload, 'validation.confirmed', 'success', {
        reason: result.reason,
        proofType: result.proofType,
        confidence: result.confidence,
        idempotentLoser: true,
        evidenceRepaired,
        findingCreatedAuditEmitted,
        findingId: existing.id,
      });
      return { kind: 'ack' };
    }
    return {
      kind: 'nack',
      error: err instanceof Error ? err : new Error('findings_insert_unknown_error'),
    };
  }

  // 7. Persist evidence — screenshot + trace per replay run.
  try {
    await persistEvidence(deps, {
      tenantId: payload.tenantId,
      findingId,
      runs: recordingDriver.results,
    });
  } catch (err) {
    return {
      kind: 'nack',
      error: err instanceof Error ? err : new Error('evidence_persist_unknown_error'),
    };
  }

  // 8. Confirmed lifecycle + finding.created audits.
  await emitLifecycleAudit(deps, envelope, payload, 'validation.confirmed', 'success', {
    reason: result.reason,
    proofType: result.proofType,
    confidence: result.confidence,
    findingId,
  });
  await emitLifecycleAudit(deps, envelope, payload, 'finding.created', 'success', {
    findingId,
    candidateFindingId: payload.candidateFindingId,
    severity: severityFor(candidate.severity),
    confidence: result.confidence,
  });

  return { kind: 'ack' };
};

// ============================================================================
// Sprint 18 — SSRF replay handler
// ============================================================================

export const handleSsrfReplay = async (
  deps: ValidatorWorkerDeps,
  envelope: JobEnvelope,
): Promise<HandlerOutcome> => {
  const { validateSsrfReplayPayloadSchema } = await import('./payload-schema.ts');
  const parsed = validateSsrfReplayPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('invalid_ssrf_replay_payload', [
        'ssrf_replay_payload_schema_mismatch',
      ]),
    };
  }
  const payload = parsed.data;

  // MED-2: require ssrf deps — fail-visible on missing config.
  if (!deps.ssrfHttpClient || !deps.oobCallbackLoader) {
    await deps.auditEmitter({
      tenantId: payload.tenantId,
      action: 'validation.inconclusive',
      outcome: 'failure',
      actorType: 'service',
      actorId: VALIDATOR_WORKER_ACTOR_ID,
      actorName: 'validator-worker',
      resourceType: 'candidate_finding',
      resourceId: payload.candidateFindingId,
      ...(payload.projectId ? { projectId: payload.projectId } : {}),
      assessmentId: payload.assessmentId,
      ip: null,
      userAgent: null,
      traceId: payload.traceId,
      metadata: {
        reason: 'config_error',
        missing: !deps.ssrfHttpClient ? 'ssrfHttpClient' : 'oobCallbackLoader',
      },
    });
    return {
      kind: 'nack',
      error: new ScopeDenyError('ssrf_config_error', ['ssrf_deps_not_configured']),
    };
  }

  // HIGH-1: load candidate from DB and verify type.
  const candidate = await deps.candidateLoader({
    tenantId: payload.tenantId,
    candidateFindingId: payload.candidateFindingId,
  });
  if (!candidate || candidate.type !== 'ssrf') {
    return {
      kind: 'nack',
      error: new ScopeDenyError('ssrf_candidate_not_found', ['ssrf_candidate_not_found']),
    };
  }

  const assessment = await deps.assessmentLoader({
    tenantId: payload.tenantId,
    assessmentId: payload.assessmentId,
  });
  if (!assessment) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('ssrf_assessment_not_found', ['ssrf_assessment_not_found']),
    };
  }

  const scope = await deps.buildScope(payload.assessmentId);
  if (!scope) {
    await deps.auditEmitter({
      tenantId: payload.tenantId,
      action: 'validator.ssrf.replay_denied',
      outcome: 'denied',
      actorType: 'service',
      actorId: VALIDATOR_WORKER_ACTOR_ID,
      actorName: 'validator-worker',
      resourceType: 'candidate_finding',
      resourceId: payload.candidateFindingId,
      ...(payload.projectId ? { projectId: payload.projectId } : {}),
      assessmentId: payload.assessmentId,
      ip: null,
      userAgent: null,
      traceId: payload.traceId,
      metadata: { reason: 'no_scope' },
    });
    return { kind: 'ack' };
  }

  const result = await validateSsrfCandidate(
    {
      candidateFindingId: payload.candidateFindingId,
      tenantId: payload.tenantId,
      assessmentId: payload.assessmentId,
      projectId: payload.projectId,
      replayUrl: payload.replayUrl,
      token: payload.token,
      scope: scope as EffectiveScope,
      traceId: payload.traceId,
    },
    {
      scopeDeps: deps.scopeDeps,
      auditEmitter: deps.auditEmitter,
      httpClient: deps.ssrfHttpClient,
      oobCallbackLoader: deps.oobCallbackLoader,
      ...(deps.oobVerifyTimeoutMs !== undefined && { oobVerifyTimeoutMs: deps.oobVerifyTimeoutMs }),
    },
  );

  if (result.status === 'confirmed') {
    // Insert confirmed finding using candidate.affectedUrl from DB.
    try {
      await deps.findingsWriter({
        tenantId: payload.tenantId,
        assessmentId: payload.assessmentId,
        candidateFindingId: payload.candidateFindingId,
        type: 'ssrf',
        severity: 'high',
        confidence: 'high',
        affectedUrl: candidate.affectedUrl,
        reproduction: { token: payload.token, replayUrl: payload.replayUrl },
        validatorLog: [],
        validatedAt: (deps.clock ?? (() => new Date()))(),
        validatedBy: { status: 'confirmed' as const },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        return {
          kind: 'nack',
          error: err instanceof Error ? err : new Error('ssrf_findings_insert_unknown'),
        };
      }
    }
  }

  return { kind: 'ack' };
};

const severityFor = (
  candidate: 'info' | 'low' | 'medium' | 'high' | 'critical',
): 'info' | 'low' | 'medium' | 'high' | 'critical' => {
  // Sprint 10 promotes any reflected-XSS confirmation to high (or critical
  // if the candidate already carried that). Future sprints derive from
  // candidate severity + impact context.
  return candidate === 'critical' ? 'critical' : 'high';
};

interface PersistEvidenceInput {
  readonly tenantId: string;
  readonly findingId: string;
  readonly runs: ReadonlyArray<XssReplayResult>;
}

const persistEvidence = async (
  deps: ValidatorWorkerDeps,
  input: PersistEvidenceInput,
): Promise<void> => {
  const blobs = collectEvidence(input.runs);
  for (const blob of blobs) {
    const key = evidenceObjectKey({
      tenantId: input.tenantId,
      findingId: input.findingId,
      kind: blob.kind,
      attempt: blob.attempt,
      sha256: blob.sha256,
    });
    const put = await deps.objectStorage.put({
      key,
      body: blob.body,
      contentType: blob.contentType,
    });
    await deps.findingEvidenceWriter({
      tenantId: input.tenantId,
      findingId: input.findingId,
      kind: blob.kind,
      objectStorageKey: put.key,
      sha256: put.sha256,
      sizeBytes: put.sizeBytes,
      metadata: { attempt: blob.attempt, contentType: blob.contentType },
    });
  }
};
