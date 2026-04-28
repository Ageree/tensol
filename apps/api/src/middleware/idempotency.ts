// Sprint 5 §5.7 — Idempotency-Key middleware (A-Idem-1, R2, R6, OQ-8).
//
// Behaviour:
//   - Header validation (OQ-8): zod string.min(1).max(200).regex(/^[\x21-\x7E]+$/).
//     ASCII printable, no whitespace. Invalid → 400 invalid_idempotency_key.
//   - request_hash = sha256(method + '\n' + path + '\n' + canonical_body_json).
//     `canonical_body_json` is the request body as text (read-once); for
//     content-type application/json this is already canonical-enough for the
//     dedup contract (clients sending different formattings of the same
//     payload risk a 422 conflict — that's the documented price of strict
//     idempotency).
//   - Lookup `(tenant_id, key)` via IdempotencyKeysRepo.find — already gates
//     on age < 24h AND response_status ∈ [200, 300) (R2 defence-in-depth).
//     Hit + same hash → return cached body bytes-for-bytes with the cached
//     status. Hit + different hash → 422 idempotency_conflict.
//   - Miss → run handler. Capture status + body. Cache ONLY if status ∈ [200,300).
//
// `requireKey` mode (R6): for state-transition POSTs, missing header →
// 400 idempotency_key_required. Create POSTs use the optional mode.

import type { IdempotencyKeysRepo, IdempotencyRow } from '@cyberstrike/db';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from './session.ts';

export interface IdempotencyDeps {
  readonly repos: { readonly idempotencyKeys: IdempotencyKeysRepo };
  readonly nowMs?: () => number;
}

export interface IdempotencyOptions {
  /**
   * If true (default for state-transition POSTs), missing header → 400.
   * If false (create POSTs), missing header skips the middleware entirely
   * and lets the handler run.
   */
  readonly requireKey: boolean;
}

// OQ-8 regex: ASCII printable (0x21-0x7E), 1-200 chars. No whitespace allowed.
const headerSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7E]+$/);

const sha256 = (s: string): string => {
  // Bun: globalThis.crypto.subtle works; for sync hash use createHash.
  // Use Node's createHash via dynamic import for sync hashing — simpler.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import boundary.
  const { createHash } = require('node:crypto') as any;
  return createHash('sha256').update(s).digest('hex');
};

const isCacheable = (status: number): boolean => status >= 200 && status < 300;

export const idempotency = (
  deps: IdempotencyDeps,
  opts: IdempotencyOptions = { requireKey: true },
): MiddlewareHandler<SessionEnv> => {
  return async (c: Context<SessionEnv>, next) => {
    const headerRaw = c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key');

    if (!headerRaw) {
      if (opts.requireKey) {
        return c.json({ error: 'idempotency_key_required' }, 400);
      }
      // Optional mode — pass through without caching.
      await next();
      return;
    }

    const parsed = headerSchema.safeParse(headerRaw);
    if (!parsed.success) {
      return c.json({ error: 'invalid_idempotency_key' }, 400);
    }
    const key = parsed.data;

    const actor = c.get('actor');
    if (!actor) {
      // tenantGuard runs before this; defensive.
      return c.json({ error: 'unauthenticated' }, 401);
    }

    // Read body text ONCE. Re-attach the parsed body to the context via a
    // header — Hono's c.req.json() reads the underlying request stream, so
    // we must consume it here and replay for the handler. The simplest path
    // is to monkey-patch c.req.json() on this context.
    const bodyText = await c.req.text();
    const requestHash = sha256(`${c.req.method}\n${c.req.path}\n${bodyText}`);

    const nowMs = deps.nowMs?.() ?? Date.now();

    // Lookup cached row.
    const cached: IdempotencyRow | null = await deps.repos.idempotencyKeys.find(
      { tenantId: actor.tenantId, key },
      nowMs,
    );

    if (cached) {
      if (cached.request_hash !== requestHash) {
        return c.json({ error: 'idempotency_conflict' }, 422);
      }
      // R2 defence-in-depth — repo.find already filtered non-2xx, so cached
      // is guaranteed cacheable. Replay byte-equivalently. Hono types the
      // status as a literal union; the runtime accepts any number, and the
      // repo guarantees 200..299 (R2).
      return c.json(
        cached.response_body as Record<string, unknown>,
        // biome-ignore lint/suspicious/noExplicitAny: see comment above.
        cached.response_status as any,
      );
    }

    // Replay body for downstream handler. Hono's c.req.json() reads from
    // the underlying Request; once consumed it can't be re-read. Replace
    // the reader with a closure that returns the parsed JSON.
    let parsedBody: unknown;
    try {
      parsedBody = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      parsedBody = undefined;
    }
    // biome-ignore lint/suspicious/noExplicitAny: Hono c.req shape.
    (c.req as any).json = async () => parsedBody;
    // biome-ignore lint/suspicious/noExplicitAny: Hono c.req shape.
    (c.req as any).text = async () => bodyText;

    await next();

    // After handler — capture status + body.
    const res = c.res;
    if (!res) return;
    const status = res.status;
    if (!isCacheable(status)) {
      // R2: never cache non-2xx.
      return;
    }
    // Read response body. We must clone first so the original response can
    // still be sent to the client.
    const cloned = res.clone();
    let responseBody: unknown;
    try {
      const txt = await cloned.text();
      responseBody = txt.length > 0 ? JSON.parse(txt) : null;
    } catch {
      responseBody = null;
    }

    try {
      await deps.repos.idempotencyKeys.findOrInsert({
        tenantId: actor.tenantId,
        key,
        actorId: actor.id,
        routeMethod: c.req.method,
        routePath: c.req.path,
        requestHash,
        responseStatus: status,
        responseBody,
      });
    } catch {
      // Concurrent-duplicate race or transient DB error — the response was
      // already 2xx, so we DO NOT mutate the response. The retry will either
      // hit the row (winner cached the 2xx) or re-run the handler (still safe
      // since the action was idempotent server-side at the resource level).
    }
  };
};
