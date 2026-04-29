// Sprint 7 §5.4 A-Q-Coord-4 (trace propagation), OQ-4 (idem key derivation).

import { describe, expect, test } from 'bun:test';
import type { JobEnvelope, PublishResult, QueueAdapter } from '@cyberstrike/queue';
import { publishReconChildJobs } from './child-job.ts';

const parentEnv = (): JobEnvelope => ({
  jobId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  projectId: '33333333-3333-3333-3333-333333333333',
  assessmentId: '44444444-4444-4444-4444-444444444444',
  kind: 'assessment.start',
  idempotencyKey: 'parent-idem',
  createdAt: '2026-04-29T12:00:00.000Z',
  attempt: 0,
  maxAttempts: 3,
  traceId: 'parent-trace-id',
  payload: { ignored: true },
});

const stubAdapter = (capture: JobEnvelope[], randomUUID: () => string): QueueAdapter => ({
  publish: async (env): Promise<PublishResult> => {
    capture.push(env);
    return { deduped: false, jobId: randomUUID() };
  },
  subscribe: () => ({ stop: async () => {} }),
  ack: async () => {},
  nack: async () => {},
});

describe('publishReconChildJobs', () => {
  test('inherits traceId from parent (A-Q-Coord-4)', async () => {
    const captured: JobEnvelope[] = [];
    let n = 0;
    const adapter = stubAdapter(
      captured,
      () => `00000000-0000-0000-0000-${String(n++).padStart(12, '0')}`,
    );
    await publishReconChildJobs({
      adapter,
      parent: parentEnv(),
      targets: [
        { targetId: 'a1111111-1111-1111-1111-111111111111', targetUrl: 'https://a.example' },
      ],
      randomUUID: () => 'b2222222-2222-2222-2222-222222222222',
      clockIso: () => '2026-04-29T13:00:00.000Z',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.traceId).toBe('parent-trace-id');
    expect(captured[0]?.tenantId).toBe(parentEnv().tenantId);
    expect(captured[0]?.projectId).toBe(parentEnv().projectId);
    expect(captured[0]?.assessmentId).toBe(parentEnv().assessmentId);
    expect(captured[0]?.kind).toBe('recon.browser.placeholder');
  });

  test('idempotencyKey derived as ${parent.idempotencyKey}:${targetId} (OQ-4)', async () => {
    const captured: JobEnvelope[] = [];
    const adapter = stubAdapter(captured, () => 'b2222222-2222-2222-2222-222222222222');
    await publishReconChildJobs({
      adapter,
      parent: parentEnv(),
      targets: [
        { targetId: 'a1111111-1111-1111-1111-111111111111', targetUrl: 'https://a.example' },
        { targetId: 'a2222222-2222-2222-2222-222222222222', targetUrl: 'https://b.example' },
      ],
      randomUUID: () => 'b2222222-2222-2222-2222-222222222222',
      clockIso: () => '2026-04-29T13:00:00.000Z',
    });
    expect(captured).toHaveLength(2);
    expect(captured[0]?.idempotencyKey).toBe('parent-idem:a1111111-1111-1111-1111-111111111111');
    expect(captured[1]?.idempotencyKey).toBe('parent-idem:a2222222-2222-2222-2222-222222222222');
  });

  test('sets attempt=0, maxAttempts=3 on every child', async () => {
    const captured: JobEnvelope[] = [];
    const adapter = stubAdapter(captured, () => 'b2222222-2222-2222-2222-222222222222');
    await publishReconChildJobs({
      adapter,
      parent: parentEnv(),
      targets: [
        { targetId: 'a1111111-1111-1111-1111-111111111111', targetUrl: 'https://a.example' },
      ],
      randomUUID: () => 'b2222222-2222-2222-2222-222222222222',
      clockIso: () => '2026-04-29T13:00:00.000Z',
    });
    expect(captured[0]?.attempt).toBe(0);
    expect(captured[0]?.maxAttempts).toBe(3);
  });

  test('payload contains targetId, targetUrl, parentJobId', async () => {
    const captured: JobEnvelope[] = [];
    const adapter = stubAdapter(captured, () => 'b2222222-2222-2222-2222-222222222222');
    await publishReconChildJobs({
      adapter,
      parent: parentEnv(),
      targets: [
        { targetId: 'a1111111-1111-1111-1111-111111111111', targetUrl: 'https://example.com/path' },
      ],
      randomUUID: () => 'b2222222-2222-2222-2222-222222222222',
      clockIso: () => '2026-04-29T13:00:00.000Z',
    });
    const payload = captured[0]?.payload as Record<string, unknown>;
    expect(payload.targetId).toBe('a1111111-1111-1111-1111-111111111111');
    expect(payload.targetUrl).toBe('https://example.com/path');
    expect(payload.parentJobId).toBe(parentEnv().jobId);
  });

  test('returns one PublishResult per target', async () => {
    const captured: JobEnvelope[] = [];
    let n = 0;
    const adapter = stubAdapter(
      captured,
      () => `b2222222-2222-2222-2222-${String(n++).padStart(12, '0')}`,
    );
    const out = await publishReconChildJobs({
      adapter,
      parent: parentEnv(),
      targets: [
        { targetId: 'a1111111-1111-1111-1111-111111111111', targetUrl: 'https://a.example' },
        { targetId: 'a2222222-2222-2222-2222-222222222222', targetUrl: 'https://b.example' },
      ],
      randomUUID: () => 'b2222222-2222-2222-2222-222222222222',
      clockIso: () => '2026-04-29T13:00:00.000Z',
    });
    expect(out).toHaveLength(2);
  });
});
