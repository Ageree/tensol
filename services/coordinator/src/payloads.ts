// Sprint 7 §5.1 Per-kind payload validation (defence in depth).
//
// The envelope schema treats `payload` as opaque z.unknown(). Each handler
// validates its own kind's payload BEFORE acting. Unknown shape → terminal
// failure (envelope is well-formed but payload is wrong).

import { z } from 'zod';

/** Payload for `assessment.start` envelopes. */
export const assessmentStartPayloadSchema = z.object({
  assessmentId: z.string().uuid(),
  targetIds: z.array(z.string().uuid()).min(1),
});

export type AssessmentStartPayload = z.infer<typeof assessmentStartPayloadSchema>;

/** Payload for `recon.browser.placeholder` envelopes. */
export const reconPlaceholderPayloadSchema = z.object({
  targetId: z.string().uuid(),
  targetUrl: z.string().min(1),
  parentJobId: z.string().uuid(),
});

export type ReconPlaceholderPayload = z.infer<typeof reconPlaceholderPayloadSchema>;
