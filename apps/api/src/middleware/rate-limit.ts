// Sprint 3 contract C18b — in-memory token bucket rate limiter.
//
// Slice-only implementation: per-process in-memory map. Sprint 7 will
// replace with a shared store (Redis or PG row). The contract C18b explicitly
// scopes the limiter to failed-login attempts but we expose it as a generic
// bucket so the login route can decide what counts as a failure.
//
// Defaults: 5 events per 60-second window. The 6th event in the window is
// rejected with retry_after_seconds = remaining window time.
//
// Keying: caller-supplied string (login route uses source IP). The limiter
// is purely about counting — the route decides what to do with the verdict.

export interface RateLimiter {
  /**
   * Returns null if the event is permitted, or the retry-after seconds value
   * when the limit is exceeded. Calling check() implicitly counts the event
   * IF the verdict is "allowed" — failed attempts increment the bucket only
   * via `recordFailure(key)`.
   */
  recordFailureAndCheck(key: string): { rejected: false } | { rejected: true; retryAfter: number };
  reset(key: string): void;
  /** Clears every bucket. Used by integration test fixtures between cases. */
  clear(): void;
}

export interface RateLimitConfig {
  readonly maxFailures: number;
  readonly windowSeconds: number;
  readonly nowMs?: () => number;
}

interface BucketState {
  failureTimestamps: number[];
}

export const createRateLimiter = (config: RateLimitConfig): RateLimiter => {
  const now = config.nowMs ?? Date.now;
  const buckets = new Map<string, BucketState>();
  const windowMs = config.windowSeconds * 1000;

  const purge = (state: BucketState, currentMs: number): void => {
    const cutoff = currentMs - windowMs;
    state.failureTimestamps = state.failureTimestamps.filter((t) => t > cutoff);
  };

  const recordFailureAndCheck: RateLimiter['recordFailureAndCheck'] = (key) => {
    const currentMs = now();
    const state = buckets.get(key) ?? { failureTimestamps: [] };
    purge(state, currentMs);
    state.failureTimestamps.push(currentMs);
    buckets.set(key, state);

    if (state.failureTimestamps.length > config.maxFailures) {
      const oldest = state.failureTimestamps[0] ?? currentMs;
      const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - currentMs) / 1000));
      return { rejected: true, retryAfter };
    }
    return { rejected: false };
  };
  const reset = (key: string): void => {
    buckets.delete(key);
  };
  const clear = (): void => {
    buckets.clear();
  };
  return Object.freeze({ recordFailureAndCheck, reset, clear });
};

export const DEFAULT_LOGIN_RATE_LIMIT: RateLimitConfig = {
  maxFailures: 5,
  windowSeconds: 60,
};
