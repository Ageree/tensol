// Sprint 5 — scope rule DTOs.
//
// Scope rules persist to `assessment_scope_rules` (migration 004) — Sprint 6
// will evaluate them via the scope engine; Sprint 5 just stores them.
//
// `rule_kind` is open-ended (the scope engine will define richer kinds in
// Sprint 6). `effect` is constrained to the allow/deny pair from migration
// 004's CHECK constraint.

import { z } from 'zod';

export const SCOPE_EFFECTS = ['allow', 'deny'] as const;
export type ScopeEffect = (typeof SCOPE_EFFECTS)[number];

/**
 * Payload is intentionally typed as a record of arbitrary JSON values — the
 * scope engine in Sprint 6 will refine per-`rule_kind` schemas.
 */
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const scopeRuleSchema = z
  .object({
    ruleKind: z.string().min(1).max(64),
    effect: z.enum(SCOPE_EFFECTS),
    payload: z.record(jsonValueSchema),
  })
  .strict();

export type ScopeRule = z.infer<typeof scopeRuleSchema>;
