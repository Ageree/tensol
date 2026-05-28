/**
 * Token-bucket (fixed-window count) rate-limit middleware.
 *
 * Why this exists (T145 security MEDIUM-1)
 *   `/api/auth/request-link` triggers an outbound Resend email + a DB write
 *   per invocation, and `POST /v1/deep-inquiries` is an anonymous endpoint
 *   that writes a row + emits a signed audit per call. Without per-IP
 *   throttling both surfaces invite email-flood / DB-flood abuse from a
 *   single attacker. This middleware caps requests-per-window per (IP, route)
 *   and answers `429` with `Retry-After` once the bucket is exhausted.
 *
 * Algorithm
 *   Fixed-window counter (not strict token bucket): the simplest correct
 *   thing for a single-process MVP. Each key tracks `{count, resetAt}`;
 *   when `now >= resetAt` we recreate the window starting at `now` with
 *   `count = 1`. When `count > max` we short-circuit with 429.
 *
 *   The standard token-bucket "leak per ms" semantics is overkill for the
 *   abuse vector we care about — a single attacker holding open a flood —
 *   and would force every middleware invocation into floating-point math.
 *   A fixed window plus an explicit `Retry-After` header gives the client
 *   enough information to back off without us tracking finer-grained state.
 *
 * Multi-instance caveat
 *   The default `BucketStore` is a plain `Map`, so each backend process
 *   keeps its own counters. The current production deployment is single-
 *   binary (single Bun process behind a single TLS terminator), so this
 *   is acceptable. The `BucketStore` interface is intentionally minimal
 *   so a Redis-backed store can be dropped in without touching callsites
 *   when we horizontally scale (post-MVP).
 *
 * Key derivation
 *   By default we pull the client IP from the leftmost entry in the
 *   `x-forwarded-for` header (the standard convention behind a reverse
 *   proxy / load balancer), falling back to `x-real-ip`, then to the
 *   string `"unknown"`. Callers can pass a custom `keyFn` to scope by
 *   user id, route prefix, or any tuple they like.
 *
 * Constitution
 *   - I (Spec-driven): contracts/openapi.yaml does not yet declare 429
 *     responses on these routes; the security finding (commit 5821bd8)
 *     mandates them as defense-in-depth.
 *   - IX (Validated inputs): the middleware validates its own options at
 *     construction and refuses zero/negative bounds.
 *   - VII (Dependency injection): `now` and `store` are both DI'd so
 *     tests can drive the window deterministically.
 */
import type { Context, MiddlewareHandler } from "hono";

/** One per-key counter entry. */
export interface BucketEntry {
  /** Requests counted in the current window. */
  readonly count: number;
  /** Unix ms when the window resets and a fresh count begins. */
  readonly resetAt: number;
}

/**
 * Storage interface for bucket counters. The default in-memory store is
 * a plain `Map`; production multi-instance deploys can swap in a Redis
 * adapter (INCR + EXPIRE) without touching middleware callsites.
 */
export interface BucketStore {
  get(key: string): BucketEntry | undefined;
  set(key: string, value: BucketEntry): void;
}

/** Map-backed in-memory store. Suitable for single-process deployments. */
export function createMemoryStore(): BucketStore {
  const map = new Map<string, BucketEntry>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

export interface RateLimitOpts {
  /** Window length in ms. Must be > 0. */
  readonly windowMs: number;
  /** Max requests permitted per window per key. Must be > 0. */
  readonly max: number;
  /** Custom key derivation (default: client IP). */
  readonly keyFn?: (c: Context) => string;
  /** Pluggable counter store (default: in-memory `Map`). */
  readonly store?: BucketStore;
  /** Clock injection point (default: `Date.now`). */
  readonly now?: () => number;
}

/**
 * Default key function: extract client IP from forwarding headers.
 * Returns `"unknown"` when neither header is present — every anonymous
 * request still shares a bucket in that case (defensive — we'd rather
 * over-throttle than under-throttle).
 */
export function defaultKeyFn(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff !== undefined && xff.length > 0) {
    const first = xff.split(",")[0];
    if (first !== undefined) {
      const trimmed = first.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  const xri = c.req.header("x-real-ip");
  if (xri !== undefined && xri.length > 0) return xri.trim();
  return "unknown";
}

/**
 * Factory: build a Hono middleware that enforces the supplied opts.
 *
 * Behavior per request:
 *   1. Derive the bucket key via `keyFn`.
 *   2. Read the current entry; if absent or `now >= resetAt`, start a
 *      fresh window (`count = 1`, `resetAt = now + windowMs`).
 *      Otherwise increment `count`.
 *   3. Populate `X-RateLimit-Limit / Remaining / Reset` response headers
 *      so clients can self-pace.
 *   4. If `count > max`, short-circuit with 429
 *      `{ error: "rate_limited", retry_after }` AND set `Retry-After`
 *      (RFC 6585) in seconds.
 *   5. Otherwise call `next()`.
 */
export function createRateLimit(opts: RateLimitOpts): MiddlewareHandler {
  if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
    throw new Error("rate-limit: windowMs must be > 0");
  }
  if (!Number.isFinite(opts.max) || opts.max <= 0) {
    throw new Error("rate-limit: max must be > 0");
  }
  const store = opts.store ?? createMemoryStore();
  const keyFn = opts.keyFn ?? defaultKeyFn;
  const clock = opts.now ?? Date.now;

  return async (c, next) => {
    const key = keyFn(c);
    const ts = clock();

    const existing = store.get(key);
    const entry: BucketEntry =
      existing === undefined || ts >= existing.resetAt
        ? { count: 1, resetAt: ts + opts.windowMs }
        : { count: existing.count + 1, resetAt: existing.resetAt };
    store.set(key, entry);

    const remaining = Math.max(0, opts.max - entry.count);
    const resetSec = Math.ceil(entry.resetAt / 1000);

    c.header("X-RateLimit-Limit", String(opts.max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetSec));

    if (entry.count > opts.max) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((entry.resetAt - ts) / 1000),
      );
      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        { error: "rate_limited", retry_after: retryAfterSec },
        429,
      );
    }

    await next();
  };
}

/**
 * Pre-baked option sets for the two endpoints called out by the T145
 * security review. Exported so callsites (server.ts) stay one-liners and
 * the tuning knobs live in one auditable place.
 *
 *   /api/auth/*           — 10 req/min/IP. Magic-link issuance triggers
 *                           Resend emails; this caps email-flood per IP
 *                           at the level the legitimate "I mistyped"
 *                           retry pattern still passes comfortably.
 *
 *   POST /v1/deep-inquiries — 5 req/min/IP. Anonymous endpoint that
 *                           writes a DB row + audit event per call;
 *                           tighter than auth because there is no
 *                           legitimate retry pattern.
 */
export const RATE_LIMIT_AUTH: RateLimitOpts = {
  windowMs: 60_000,
  max: 10,
};

export const RATE_LIMIT_INQUIRY: RateLimitOpts = {
  windowMs: 60_000,
  max: 5,
};
