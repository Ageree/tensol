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

export interface FindingRow {
  readonly id: string;
  readonly assessmentId: string;
  readonly type: string;
  readonly severity: string;
  readonly confidence: string;
  readonly status: string;
  readonly affectedUrl: string;
  readonly reproduction: unknown;
  readonly validatorLog: unknown;
  readonly validatedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const listFindingsByAssessment = async (
  input: ListFindingsByAssessmentInput,
): Promise<ReadonlyArray<FindingRow>> => {
  const rows = await input.db
    .selectFrom('findings')
    .selectAll()
    .where('tenant_id', '=', input.tenantId)
    .where('assessment_id', '=', input.assessmentId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    assessmentId: String(r.assessment_id),
    type: String(r.type),
    severity: String(r.severity),
    confidence: String(r.confidence),
    status: String(r.status),
    affectedUrl: String(r.affected_url),
    reproduction: r.reproduction,
    validatorLog: r.validator_log,
    validatedAt: r.validated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
};

export interface GetFindingInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly findingId: string;
}

export const getFinding = async (input: GetFindingInput): Promise<FindingRow | null> => {
  const row = await input.db
    .selectFrom('findings')
    .selectAll()
    .where('id', '=', input.findingId)
    .where('tenant_id', '=', input.tenantId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: String(row.id),
    assessmentId: String(row.assessment_id),
    type: String(row.type),
    severity: String(row.severity),
    confidence: String(row.confidence),
    status: String(row.status),
    affectedUrl: String(row.affected_url),
    reproduction: row.reproduction,
    validatorLog: row.validator_log,
    validatedAt: row.validated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export type FindingStatus =
  | 'open'
  | 'triaged'
  | 'accepted_risk'
  | 'false_positive'
  | 'fixed'
  | 'retested'
  | 'closed';

export const FINDING_STATUSES: ReadonlyArray<FindingStatus> = [
  'open',
  'triaged',
  'accepted_risk',
  'false_positive',
  'fixed',
  'retested',
  'closed',
];

export interface UpdateFindingStatusInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly findingId: string;
  readonly status: FindingStatus;
}

export const updateFindingStatus = async (
  input: UpdateFindingStatusInput,
): Promise<{ readonly updated: boolean }> => {
  const result = await input.db
    .updateTable('findings')
    .set({ status: input.status })
    .where('id', '=', input.findingId)
    .where('tenant_id', '=', input.tenantId)
    .executeTakeFirst();
  return { updated: Number(result.numUpdatedRows) > 0 };
};
