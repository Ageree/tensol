// Sprint 7 — contracts queue-envelope schema unit test.

import { describe, expect, test } from 'bun:test';
import { ENVELOPE_KINDS, JOB_STATUSES, jobEnvelopeContractSchema } from './queue-envelope.ts';

describe('queue-envelope contract', () => {
  test('ENVELOPE_KINDS matches the canonical packages/queue list', () => {
    expect([...ENVELOPE_KINDS]).toEqual([
      'assessment.start',
      'recon.browser.placeholder',
      'decepticon.findings',
    ]);
  });

  test('JOB_STATUSES matches the DB CHECK constraint state-machine', () => {
    expect([...JOB_STATUSES]).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed_transient',
      'failed_terminal',
    ]);
  });

  test('schema accepts a complete valid envelope', () => {
    const env = {
      jobId: '11111111-1111-1111-1111-111111111111',
      tenantId: '22222222-2222-2222-2222-222222222222',
      projectId: '33333333-3333-3333-3333-333333333333',
      assessmentId: '44444444-4444-4444-4444-444444444444',
      kind: 'assessment.start',
      idempotencyKey: 'idem-1',
      createdAt: '2026-04-29T12:00:00.000Z',
      attempt: 0,
      maxAttempts: 3,
      traceId: 'trace',
      payload: { foo: 'bar' },
    };
    expect(jobEnvelopeContractSchema.safeParse(env).success).toBe(true);
  });

  test('schema rejects unknown kind', () => {
    expect(
      jobEnvelopeContractSchema.safeParse({
        jobId: '11111111-1111-1111-1111-111111111111',
        tenantId: '22222222-2222-2222-2222-222222222222',
        assessmentId: '33333333-3333-3333-3333-333333333333',
        kind: 'foo.bar',
        idempotencyKey: 'idem-1',
        createdAt: '2026-04-29T12:00:00.000Z',
        attempt: 0,
        maxAttempts: 3,
        traceId: 'trace',
        payload: null,
      }).success,
    ).toBe(false);
  });
});
