// Sprint 6 — in-process rate-limit counter (OQ-5).
//
// Token bucket per (bucket-key). Lives at process scope; Sprint 7+ may swap to
// Redis-backed without engine changes (the engine consumes a `RateLimitCounter`
// interface — this is one implementation).

import type { RateLimitConsumeResult, RateLimitCounter } from '@cyberstrike/scope-engine';

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  perSecond: number;
  burst: number;
}

const STATE = new Map<string, BucketState>();

const refill = (s: BucketState, nowMs: number): void => {
  const elapsedMs = nowMs - s.lastRefillMs;
  if (elapsedMs <= 0) return;
  const earned = (elapsedMs / 1000) * s.perSecond;
  s.tokens = Math.min(s.burst, s.tokens + earned);
  s.lastRefillMs = nowMs;
};

export const inProcessRateLimitCounter: RateLimitCounter = {
  consume(bucket: string, perSecond: number, burst: number): RateLimitConsumeResult {
    const nowMs = Date.now();
    let s = STATE.get(bucket);
    if (!s || s.perSecond !== perSecond || s.burst !== burst) {
      s = { tokens: burst, lastRefillMs: nowMs, perSecond, burst };
      STATE.set(bucket, s);
    } else {
      refill(s, nowMs);
    }
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return { ok: true };
    }
    const need = 1 - s.tokens;
    const retryAfterMs = Math.ceil((need / perSecond) * 1000);
    return { ok: false, retryAfterMs };
  },
};

/** Test seam: clear all buckets. */
export const resetRateLimitState = (): void => {
  STATE.clear();
};
