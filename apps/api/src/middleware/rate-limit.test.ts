import { describe, expect, test } from 'bun:test';
import { DEFAULT_LOGIN_RATE_LIMIT, createRateLimiter } from './rate-limit.ts';

describe('apps/api :: rate-limit (C18b)', () => {
  test('5 failures within 60s allowed; 6th rejected', () => {
    let now = 0;
    const limiter = createRateLimiter({
      maxFailures: 5,
      windowSeconds: 60,
      nowMs: () => now,
    });
    for (let i = 0; i < 5; i++) {
      now += 1000;
      const verdict = limiter.recordFailureAndCheck('1.2.3.4');
      expect(verdict.rejected).toBe(false);
    }
    now += 1000;
    const sixth = limiter.recordFailureAndCheck('1.2.3.4');
    expect(sixth.rejected).toBe(true);
    if (sixth.rejected) {
      expect(sixth.retryAfter).toBeGreaterThan(0);
    }
  });

  test('failures from different keys are independent', () => {
    let now = 0;
    const limiter = createRateLimiter({
      maxFailures: 5,
      windowSeconds: 60,
      nowMs: () => now,
    });
    for (let i = 0; i < 5; i++) {
      now += 1000;
      limiter.recordFailureAndCheck('1.2.3.4');
    }
    now += 1000;
    expect(limiter.recordFailureAndCheck('5.6.7.8').rejected).toBe(false);
  });

  test('window slides — old failures eventually drop out', () => {
    let now = 1000;
    const limiter = createRateLimiter({
      maxFailures: 5,
      windowSeconds: 60,
      nowMs: () => now,
    });
    for (let i = 0; i < 5; i++) {
      limiter.recordFailureAndCheck('ip');
      now += 1000;
    }
    // Move outside the window.
    now += 60_000;
    expect(limiter.recordFailureAndCheck('ip').rejected).toBe(false);
  });

  test('reset() drops the bucket', () => {
    let now = 0;
    const limiter = createRateLimiter({
      maxFailures: 1,
      windowSeconds: 60,
      nowMs: () => now,
    });
    limiter.recordFailureAndCheck('ip');
    now += 1;
    expect(limiter.recordFailureAndCheck('ip').rejected).toBe(true);
    limiter.reset('ip');
    expect(limiter.recordFailureAndCheck('ip').rejected).toBe(false);
  });

  test('DEFAULT_LOGIN_RATE_LIMIT is 5 per 60 seconds', () => {
    expect(DEFAULT_LOGIN_RATE_LIMIT.maxFailures).toBe(5);
    expect(DEFAULT_LOGIN_RATE_LIMIT.windowSeconds).toBe(60);
  });
});
