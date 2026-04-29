// Sprint 7 — JobEnvelope shared schema mirror.
//
// The canonical schema lives in `packages/queue/src/envelope.ts`; this file
// is a parallel definition the API can import without taking a runtime
// dep on `packages/queue` at the contract boundary. Kept in sync via the
// shared ENVELOPE_KINDS list and matching field shape.

import { z } from 'zod';

export const ENVELOPE_KINDS = ['assessment.start', 'recon.browser.placeholder'] as const;
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
