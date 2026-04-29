// Sprint 7 §5.4 A-Q-Coord-3 — placeholder consumer unit test.

import { describe, expect, test } from 'bun:test';
import type { JobEnvelope } from '@cyberstrike/queue';
import { reconPlaceholderHandler } from './placeholder-consumer.ts';

const validEnv = (payload: unknown): JobEnvelope => ({
  jobId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  projectId: null,
  assessmentId: '33333333-3333-3333-3333-333333333333',
  kind: 'recon.browser.placeholder',
  idempotencyKey: 'idem',
  createdAt: '2026-04-29T12:00:00.000Z',
  attempt: 0,
  maxAttempts: 3,
  traceId: 'trace',
  payload,
});

describe('reconPlaceholderHandler', () => {
  test('acks valid payload (no-op)', async () => {
    const out = await reconPlaceholderHandler(
      validEnv({
        targetId: '44444444-4444-4444-4444-444444444444',
        targetUrl: 'https://example.com',
        parentJobId: '55555555-5555-5555-5555-555555555555',
      }),
    );
    expect(out.kind).toBe('ack');
  });

  test('nacks with terminal error on malformed payload', async () => {
    const out = await reconPlaceholderHandler(validEnv({ wrong: 'shape' }));
    expect(out.kind).toBe('nack');
    if (out.kind === 'nack') {
      expect(out.error.name).toBe('ScopeDenyError');
    }
  });

  test('nacks on null payload', async () => {
    const out = await reconPlaceholderHandler(validEnv(null));
    expect(out.kind).toBe('nack');
  });
});
