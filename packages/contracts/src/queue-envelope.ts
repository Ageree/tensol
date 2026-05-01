// Sprint 7 — JobEnvelope shared schema mirror.
//
// The canonical schema lives in `packages/queue/src/envelope.ts`; this file
// is a parallel definition the API can import without taking a runtime
// dep on `packages/queue` at the contract boundary. Kept in sync via the
// shared ENVELOPE_KINDS list and matching field shape.

import { z } from 'zod';

export const ENVELOPE_KINDS = [
  'assessment.start',
  /**
   * @deprecated Sprint 7 placeholder. Sprint 9 replaces with `recon.browser`.
   */
  'recon.browser.placeholder',
  // Sprint 8 — fake decepticon adapter publishes one envelope per observed
  // candidate. Sprint 10 validator-worker will subscribe and gate them.
  'decepticon.findings',
  // Sprint 9 — coordinator publishes one envelope per declared startUrl
  // after scope-validation passes. Browser-worker subscribes.
  'recon.browser',
  // Sprint 10 — coordinator publishes one envelope per candidate after
  // decepticon emits it. Validator-worker subscribes and runs deterministic
  // XSS replay.
  'validate.finding',
  // Sprint 14 — API enqueues one envelope per report build request.
  // Report-builder worker subscribes and renders HTML+JSON+ZIP.
  'report.build',
  // Sprint 15 — browser-worker auth flow. Payload carries credentialId +
  // recipe JSON. Browser-worker decrypts, logs in, persists storageState.
  'browser.auth',
  // Sprint 18 — validator-worker subscribes to replay SSRF candidates.
  'validator.ssrf.replay',
  // Sprint 19 — validator-worker subscribes to replay LFI candidates.
  'validator.lfi.replay',
  // Sprint 20 — validator-worker subscribes to replay RCE candidates.
  'validator.rce.replay',
  // Sprint 21 — coordinator publishes one envelope per recon job.
  // Recon-runner worker subscribes and orchestrates subfinder+httpx+nuclei.
  'recon.subfinder.run',
] as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

const isoDatetime = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid_iso_datetime' });

export const jobEnvelopeContractSchema = z.object({
  jobId: z.string().uuid(),
  tenantId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  assessmentId: z.string().uuid(),
  kind: z.enum(ENVELOPE_KINDS),
  idempotencyKey: z.string().min(1).max(255),
  createdAt: isoDatetime,
  notBefore: isoDatetime.optional(),
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).max(10),
  traceId: z.string().min(1),
  payload: z.unknown(),
});

export type JobEnvelopeContract = z.infer<typeof jobEnvelopeContractSchema>;

export const JOB_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed_transient',
  'failed_terminal',
] as const;

export type JobStatusContract = (typeof JOB_STATUSES)[number];
