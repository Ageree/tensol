// Sprint 5 — assessment DTOs (A-Asm-1..13).
//
// State enum re-exported from assessment-state.ts to keep the import surface
// minimal; commands ship with the state machine.

import { z } from 'zod';
import { ASSESSMENT_STATES, type AssessmentState } from './assessment-state.ts';
import { scopeRuleSchema } from './scope-rules.ts';

export const HIGH_IMPACT_CATEGORIES = ['c2', 'post_exploit', 'ad', 'credential_audit'] as const;
export type HighImpactCategory = (typeof HIGH_IMPACT_CATEGORIES)[number];

const testingWindowSchema = z
  .object({
    start: z.string().datetime(),
    end: z.string().datetime(),
  })
  .strict();
export type TestingWindow = z.infer<typeof testingWindowSchema>;

/**
 * A-Asm-2 — POST body. DoS caps `targetIds.length ≤ 1000` and
 * `scopeRules.length ≤ 1000` per Evaluator's optional notes.
 *
 * R3 / R4 enforcement happens at the route layer (cross-tenant precedence,
 * scope-rule replacement semantics) not the schema.
 */
export const assessmentCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    testingWindow: testingWindowSchema.nullable(),
    highImpactCategories: z.array(z.enum(HIGH_IMPACT_CATEGORIES)).max(4),
    targetIds: z.array(z.string().uuid()).min(1).max(1000),
    scopeRules: z.array(scopeRuleSchema).min(1).max(1000),
  })
  .strict();
export type AssessmentCreate = z.infer<typeof assessmentCreateSchema>;

/**
 * A-Asm-3 — PATCH body, draft-only at the route layer. R3 atomic
 * delete-then-insert semantics for `targetIds` and `scopeRules` enforced by
 * the route in a single tx with the parent UPDATE.
 */
export const assessmentPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    testingWindow: testingWindowSchema.nullable().optional(),
    highImpactCategories: z.array(z.enum(HIGH_IMPACT_CATEGORIES)).max(4).optional(),
    targetIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
    scopeRules: z.array(scopeRuleSchema).min(1).max(1000).optional(),
  })
  .strict();
export type AssessmentPatch = z.infer<typeof assessmentPatchSchema>;

export const assessmentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9+/=]+$/)
      .optional(),
  })
  .strict();

export { ASSESSMENT_STATES, type AssessmentState };
