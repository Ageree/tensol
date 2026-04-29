// Sprint 6 OQ-5 — in-process token-bucket counter coverage.

import { describe, expect, test } from 'bun:test';
import { inProcessRateLimitCounter, resetRateLimitState } from './rate-limit.ts';

describe('apps/api/src/scope-engine/rate-limit — token bucket', () => {
  test('first call within burst → ok=true', () => {
    resetRateLimitState();
    const r = inProcessRateLimitCounter.consume('bucket-A', 5, 10);
    expect(r.ok).toBe(true);
  });

  test('exhausting burst → ok=false with retryAfterMs', () => {
    resetRateLimitState();
    let lastOk = true;
    for (let i = 0; i < 10; i += 1) {
      const r = inProcessRateLimitCounter.consume('bucket-B', 1, 10);
      lastOk = r.ok;
    }
    expect(lastOk).toBe(true); // 10 calls within burst all succeed
    const denied = inProcessRateLimitCounter.consume('bucket-B', 1, 10);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  test('refill recovers tokens after time passes (synthetic)', async () => {
    resetRateLimitState();
    // Drain
    for (let i = 0; i < 5; i += 1) {
      inProcessRateLimitCounter.consume('bucket-C', 100, 5);
    }
    const drained = inProcessRateLimitCounter.consume('bucket-C', 100, 5);
    expect(drained.ok).toBe(false);
    // Wait long enough for refill: 100/sec * 0.05s = 5 tokens.
    await new Promise((r) => setTimeout(r, 60));
    const refilled = inProcessRateLimitCounter.consume('bucket-C', 100, 5);
    expect(refilled.ok).toBe(true);
  });

  test('changing perSecond/burst resets the bucket', () => {
    resetRateLimitState();
    inProcessRateLimitCounter.consume('bucket-D', 5, 10);
    // Different params trigger fresh bucket creation.
    const r = inProcessRateLimitCounter.consume('bucket-D', 50, 100);
    expect(r.ok).toBe(true);
  });

  test('resetRateLimitState clears all buckets', () => {
    inProcessRateLimitCounter.consume('bucket-E', 1, 1);
    const denied = inProcessRateLimitCounter.consume('bucket-E', 1, 1);
    expect(denied.ok).toBe(false);
    resetRateLimitState();
    const fresh = inProcessRateLimitCounter.consume('bucket-E', 1, 1);
    expect(fresh.ok).toBe(true);
  });
});
