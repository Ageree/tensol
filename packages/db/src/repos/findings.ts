// Sprint 10 — findings repo. SINGLE writer for the `findings` table.
//
// DirectInsertForbidden invariant — `findings` rows MUST be created via
// `insertConfirmedFinding({validatedBy: ValidationResult, ...})`. The
// function THROWS `ValidationStatusInvariantError` if `validatedBy.status
// !== 'confirmed'`. There is NO raw insert helper. The grep gate (Sprint
// 10 contract A-V-DirectInsertForbidden) verifies this is the only
// `.insertInto('findings')` callsite in the repo + product code.

import type { Kysely } from 'kysely';
import type { Database } from '../schema.ts';

/**
 * Closed-set ValidationStatus values mirrored from packages/validators.
 * Re-declared here so packages/db does not take a runtime dep on the
 * validators package (avoids circular workspace deps and keeps the
 * findings repo callable from any consumer).
 */
export type FindingValidationStatus =
  | 'confirmed'
  | 'rejected'
  | 'inconclusive'
  | 'needs_human_review'
  | 'out_of_scope';

/** Minimal validatedBy shape — the function only consumes the status. */
export interface ValidatedByLike {
  readonly status: FindingValidationStatus;
}

export class ValidationStatusInvariantError extends Error {
  override readonly name = 'ValidationStatusInvariantError';
  readonly attemptedStatus: FindingValidationStatus;
  constructor(attemptedStatus: FindingValidationStatus) {
    super(`findings_insert_requires_confirmed_validation:status=${attemptedStatus}_not_allowed`);
    this.attemptedStatus = attemptedStatus;
  }
}

export interface InsertConfirmedFindingInput {
  readonly db: Kysely<Database>;
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
  /** REQUIRED. Asserted to have `status === 'confirmed'` before insert. */
  readonly validatedBy: ValidatedByLike;
}

export interface InsertConfirmedFindingResult {
  readonly id: string;
}

export const insertConfirmedFinding = async (
  input: InsertConfirmedFindingInput,
): Promise<InsertConfirmedFindingResult> => {
  if (input.validatedBy.status !== 'confirmed') {
    throw new ValidationStatusInvariantError(input.validatedBy.status);
  }
  // P1 JSONB pitfall — wrap object/array writes through JSON.stringify so
  // Kysely doesn't silently persist `{}` for arrays/objects.
  // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary requires string.
  const reproductionJson = JSON.stringify(input.reproduction) as any;
  // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary requires string.
  const validatorLogJson = JSON.stringify([...input.validatorLog]) as any;

  const row = await input.db
    .insertInto('findings')
    .values({
      tenant_id: input.tenantId,
      assessment_id: input.assessmentId,
      created_from_candidate_id: input.candidateFindingId,
      type: input.type,
      status: 'open',
      severity: input.severity,
      confidence: input.confidence,
      affected_url: input.affectedUrl,
      reproduction: reproductionJson,
      validator_log: validatorLogJson,
      validated_at: input.validatedAt,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: String(row.id) };
};

export interface FindFindingByCandidateInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly candidateFindingId: string;
}

export const findFindingByCandidateId = async (
  input: FindFindingByCandidateInput,
): Promise<{ readonly id: string } | null> => {
  const row = await input.db
    .selectFrom('findings')
    .select(['id'])
    .where('tenant_id', '=', input.tenantId)
    .where('created_from_candidate_id', '=', input.candidateFindingId)
    .executeTakeFirst();
  return row ? { id: String(row.id) } : null;
};

export interface ListFindingsByAssessmentInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly assessmentId: string;
}

export const listFindingsByAssessment = async (
  input: ListFindingsByAssessmentInput,
): Promise<ReadonlyArray<{ readonly id: string; readonly status: string }>> => {
  const rows = await input.db
    .selectFrom('findings')
    .select(['id', 'status'])
    .where('tenant_id', '=', input.tenantId)
    .where('assessment_id', '=', input.assessmentId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((r) => ({ id: String(r.id), status: String(r.status) }));
};
