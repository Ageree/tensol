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

/**
 * Sprint 8 — Payload for `decepticon.findings` envelopes. Coordinator drains
 * the FakeDecepticonAdapter candidate stream and republishes each candidate
 * as an envelope so a future Sprint 10 validator can subscribe.
 */
export const decepticonFindingsPayloadSchema = z.object({
  sessionId: z.string().uuid(),
  candidateId: z.string().uuid(),
  candidateFindingId: z.string().uuid(),
  type: z.string().min(1),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  affectedUrl: z.string().min(1),
  source: z.string().min(1),
});

export type DecepticonFindingsPayload = z.infer<typeof decepticonFindingsPayloadSchema>;

/**
 * Sprint 9 — Payload for `recon.browser` envelopes. Coordinator publishes
 * one envelope per declared startUrl after scope-validation passes. The
 * browser-worker handler also calls this schema as defence-in-depth.
 */
export const reconBrowserPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  assessmentId: z.string().uuid(),
  targetId: z.string().uuid(),
  startUrl: z.string().url(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
});

export type ReconBrowserPayload = z.infer<typeof reconBrowserPayloadSchema>;
