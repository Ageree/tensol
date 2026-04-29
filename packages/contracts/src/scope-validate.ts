// Sprint 6 — POST /api/v1/assessments/:id/scope/validate request/response DTOs.
//
// Request: { action: ScopeActionInput }.
// Response: Decision = the engine's verdict on the candidate action.
//
// `reason` is a closed set (R6 / OQ-6) — the reason field IS the diagnostic
// code; no separate `code` field. This keeps callers' assertion paths terse.

import { z } from 'zod';
import { scopeActionInputSchema } from './scope-action.ts';

// ============================================================================
// Closed-set decision reasons (A-SE-Type-3)
// ============================================================================

export const DECISION_REASONS = [
  'allowed',
  'no_matching_allow_rule',
  'denied_by_rule',
  'metadata_ip_blocked',
  'private_ip_blocked',
  'loopback_blocked',
  'link_local_blocked',
  'time_window_closed',
  'rate_limit_exceeded',
  'tool_not_in_catalog',
  'tool_category_high_impact_unverified_targets',
  'http_method_not_allowed',
  'path_pattern_no_match',
  'unknown_rule_default_deny',
  'normalization_error',
  'mixed_script_host_blocked',
  // codex P1 — catalog-driven high-impact + per-target ownership invariants.
  'tool_category_mismatch',
  'high_impact_unverified_ownership',
  'high_impact_target_unverified',
  // codex iter-4 P1 — DNS resolution attempted but returned empty (NXDOMAIN-like).
  'dns_resolution_failed',
] as const;

export type DecisionReason = (typeof DECISION_REASONS)[number];

export const decisionReasonSchema = z.enum(DECISION_REASONS);

// ============================================================================
// Decision shape (response body)
// ============================================================================
//
// `normalizedTarget` / `toolPolicyResult` / `timeWindowResult` are loose
// records here so the engine can populate diagnostics without a tight zod
// roundtrip. The engine's TypeScript types are tighter; the wire schema is
// permissive on read so future fields don't break old clients.

const looseRecord = z.record(z.unknown());

export const decisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: decisionReasonSchema,
    matchedAllowRuleIds: z.array(z.string()),
    matchedDenyRuleIds: z.array(z.string()),
    normalizedTarget: looseRecord.optional(),
    toolPolicyResult: looseRecord.optional(),
    timeWindowResult: looseRecord.optional(),
  })
  .strict();

export type Decision = z.infer<typeof decisionSchema>;

// ============================================================================
// Request body
// ============================================================================

export const scopeValidateRequestSchema = z
  .object({
    action: scopeActionInputSchema,
  })
  .strict();

export type ScopeValidateRequest = z.infer<typeof scopeValidateRequestSchema>;

// ============================================================================
// Response body alias for clarity
// ============================================================================

export const scopeValidateResponseSchema = decisionSchema;
export type ScopeValidateResponse = Decision;
