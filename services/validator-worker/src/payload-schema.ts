// Sprint 10 — defence-in-depth payload schema for `validate.finding`
// envelopes. Mirrors the canonical schema in coordinator/src/payloads.ts.
//
// Sprint 18 — additive export for `validator.ssrf.replay` envelopes.
// coordinator/src/payloads.ts stays frozen per M2; schema lives here only.

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
