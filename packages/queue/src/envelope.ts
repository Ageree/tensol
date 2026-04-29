// Sprint 7 §5.1 A-Q-Env-1..3 — JobEnvelope zod schema + safe parser.
//
// Per-kind payload validation lives at the consumer/handler boundary
// (services/coordinator/src/payloads.ts); the envelope schema treats
// `payload` as opaque `z.unknown()`.

import { z } from 'zod';
import { ENVELOPE_KINDS } from './types.ts';

const isoDatetime = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid_iso_datetime' });

export const jobEnvelopeSchema = z.object({
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

export type JobEnvelopeShape = z.infer<typeof jobEnvelopeSchema>;

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: JobEnvelopeShape }
  | { readonly ok: false; readonly reason: string };

/**
 * A-Q-Env-2 — single boundary parser. Never throws. Malformed input
 * (including unknown `kind`, A-Q-Env-3) → `{ok: false}`.
 */
export const parseEnvelope = (raw: unknown): EnvelopeParseResult => {
  const result = jobEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      reason: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, envelope: result.data };
};
