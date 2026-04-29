// Sprint 10 — Validator contract.
//
// `Validator.validate(input) → ValidationResult` is the single shape every
// validator (XSS, SQLi, ...) must satisfy. ValidationStatus is a closed set
// — adding a status requires a code change and a migration of the
// validator-worker decision tree.

import { z } from 'zod';

export const VALIDATION_STATUSES = [
  'confirmed',
  'rejected',
  'inconclusive',
  'needs_human_review',
  'out_of_scope',
] as const;

export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const VALIDATION_PROOF_TYPES = [
  'dom_nonce_echo',
  'console_nonce_echo',
  'network_from_script',
  'alert_only',
  'none',
] as const;

export type ValidationProofType = (typeof VALIDATION_PROOF_TYPES)[number];

export const VALIDATION_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type ValidationConfidence = (typeof VALIDATION_CONFIDENCES)[number];

/**
 * The closed-set decision returned by every validator. The
 * validator-worker dispatches on `status` and only `confirmed` produces a
 * `findings` row (DirectInsertForbidden — see findings repo).
 */
export const validationResultSchema = z
  .object({
    status: z.enum(VALIDATION_STATUSES),
    confidence: z.enum(VALIDATION_CONFIDENCES),
    proofType: z.enum(VALIDATION_PROOF_TYPES),
    requestReplayable: z.boolean(),
    sideEffectRisk: z.enum(['low', 'medium', 'high']),
    evidenceIds: z.array(z.string()).readonly(),
    reason: z.string().min(1),
    validatedAt: z.string().datetime(),
    /** Free-form decision log; used by the findings repo's validator_log column. */
    log: z.array(z.record(z.unknown())).readonly(),
  })
  .strict();

export type ValidationResult = z.infer<typeof validationResultSchema>;

export const validationInputSchema = z
  .object({
    tenantId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    assessmentId: z.string().uuid(),
    candidateFindingId: z.string().uuid(),
    candidateType: z.literal('xss_reflected'),
    affectedUrl: z.string().url(),
    payload: z.unknown(),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

export type ValidationInput = z.infer<typeof validationInputSchema>;

export interface Validator {
  validate(input: ValidationInput): Promise<ValidationResult>;
}
