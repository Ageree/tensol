// Sprint 7 §5.1 A-Q-Env-1..3 — envelope schema unit tests.

import { describe, expect, it } from 'bun:test';
import { parseEnvelope } from './envelope.ts';
import type { JobEnvelope } from './types.ts';

const validEnvelope = (): JobEnvelope => ({
  jobId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  projectId: '33333333-3333-3333-3333-333333333333',
  assessmentId: '44444444-4444-4444-4444-444444444444',
  kind: 'assessment.start',
  idempotencyKey: 'idem-key-1',
  createdAt: '2026-04-29T12:00:00.000Z',
  attempt: 0,
  maxAttempts: 3,
  traceId: 'abc-trace-id',
  payload: {
    assessmentId: '44444444-4444-4444-4444-444444444444',
    targetIds: ['55555555-5555-5555-5555-555555555555'],
  },
});

describe('parseEnvelope (A-Q-Env-1, A-Q-Env-2)', () => {
  it('accepts a complete valid envelope', () => {
    const result = parseEnvelope(validEnvelope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.kind).toBe('assessment.start');
      expect(result.envelope.attempt).toBe(0);
    }
  });

  it('accepts the recon.browser.placeholder kind', () => {
    const env = { ...validEnvelope(), kind: 'recon.browser.placeholder' };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(true);
  });

  it('accepts envelope with optional notBefore', () => {
    const env = { ...validEnvelope(), notBefore: '2026-04-29T13:00:00.000Z' };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(true);
  });

  it('accepts null projectId', () => {
    const env = { ...validEnvelope(), projectId: null };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(true);
  });

  it('rejects malformed jobId', () => {
    const env = { ...validEnvelope(), jobId: 'not-a-uuid' };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('jobId');
  });

  it('rejects malformed tenantId', () => {
    const env = { ...validEnvelope(), tenantId: 'tenant-1' };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed assessmentId', () => {
    const env = { ...validEnvelope(), assessmentId: 'not-a-uuid' };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown kind (A-Q-Env-3)', () => {
    const env = { ...validEnvelope(), kind: 'unknown.kind' };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('kind');
  });

  it('rejects empty idempotencyKey', () => {
    const env = { ...validEnvelope(), idempotencyKey: '' };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
  });

  it('rejects idempotencyKey > 255 chars', () => {
    const env = { ...validEnvelope(), idempotencyKey: 'x'.repeat(256) };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed createdAt', () => {
    const env = { ...validEnvelope(), createdAt: 'not-a-date' };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
  });

  it('rejects negative attempt', () => {
    const env = { ...validEnvelope(), attempt: -1 };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
  });

  it('rejects maxAttempts < 1', () => {
    const env = { ...validEnvelope(), maxAttempts: 0 };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
  });

  it('rejects maxAttempts > 10', () => {
    const env = { ...validEnvelope(), maxAttempts: 11 };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
  });

  it('rejects empty traceId', () => {
    const env = { ...validEnvelope(), traceId: '' };
    const result = parseEnvelope(env);
    expect(result.ok).toBe(false);
  });

  it('does not throw on null/undefined input', () => {
    expect(parseEnvelope(null).ok).toBe(false);
    expect(parseEnvelope(undefined).ok).toBe(false);
    expect(parseEnvelope({}).ok).toBe(false);
    expect(parseEnvelope('string').ok).toBe(false);
    expect(parseEnvelope(42).ok).toBe(false);
  });

  it('treats payload as opaque z.unknown (per-kind validation at handler)', () => {
    const envWithStringPayload = { ...validEnvelope(), payload: 'opaque-string' };
    expect(parseEnvelope(envWithStringPayload).ok).toBe(true);

    const envWithNumberPayload = { ...validEnvelope(), payload: 42 };
    expect(parseEnvelope(envWithNumberPayload).ok).toBe(true);

    const envWithNullPayload = { ...validEnvelope(), payload: null };
    expect(parseEnvelope(envWithNullPayload).ok).toBe(true);
  });
});
