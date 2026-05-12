// Sprint 10 — defence-in-depth payload schema for `validate.finding`
// envelopes. Mirrors the canonical schema in coordinator/src/payloads.ts.
//
// Sprint 18 — additive export for `validator.ssrf.replay` envelopes.
// Sprint 19 — additive export for `validator.lfi.replay` envelopes.
// Sprint 20 — additive export for `validator.rce.replay` envelopes.
// coordinator/src/payloads.ts stays frozen per M2; schemas live here only.

import { z } from 'zod';

export const validateFindingPayloadSchema = z
  .object({
    tenantId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    assessmentId: z.string().uuid(),
    candidateFindingId: z.string().uuid(),
    candidateType: z.literal('xss_reflected'),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

export type ValidateFindingPayload = z.infer<typeof validateFindingPayloadSchema>;

// Sprint 18 — SSRF replay envelope payload schema (additive, does not modify
// existing exports). Consumed by the validator-worker SSRF handler.
export const validateSsrfReplayPayloadSchema = z
  .object({
    tenantId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    assessmentId: z.string().uuid(),
    candidateFindingId: z.string().uuid(),
    candidateType: z.literal('ssrf'),
    replayUrl: z.string().url(),
    token: z.string().min(1),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

export type ValidateSsrfReplayPayload = z.infer<typeof validateSsrfReplayPayloadSchema>;

// Sprint 19 — LFI replay envelope payload schema (additive).
// affectedUrl intentionally absent — loaded from DB by worker (HIGH-1 S18 lesson).
export const validateLfiReplayPayloadSchema = z
  .object({
    tenantId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    assessmentId: z.string().uuid(),
    candidateFindingId: z.string().uuid(),
    candidateType: z.literal('lfi'),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

export type ValidateLfiReplayPayload = z.infer<typeof validateLfiReplayPayloadSchema>;

// Sprint 20 — RCE replay envelope payload schema (additive).
// affectedUrl IS in payload (OOB-token-embedded URL — mirrors SSRF replayUrl+token).
// token is the OOB correlation token embedded in the affectedUrl shell payload.
export const validateRceReplayPayloadSchema = z
  .object({
    tenantId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    assessmentId: z.string().uuid(),
    candidateFindingId: z.string().uuid(),
    candidateType: z.literal('rce'),
    affectedUrl: z.string().url(),
    token: z.string().min(1),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

export type ValidateRceReplayPayload = z.infer<typeof validateRceReplayPayloadSchema>;
