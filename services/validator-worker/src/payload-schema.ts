// Sprint 10 — defence-in-depth payload schema for `validate.finding`
// envelopes. Mirrors the canonical schema in coordinator/src/payloads.ts.

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
