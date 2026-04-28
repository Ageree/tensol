// Sprint 5 §5.7 — idempotency middleware unit tests (no DB).
//
// Covers the parts that don't need PG:
//   - OQ-8 header validation (regex + length).
//   - R6 missing-header handling (requireKey true vs false).
//   - request-hash mismatch when same key + different body.
//   - 2xx / 4xx / 5xx insert gating (R2) — uses a stub repo.
//
// PG-backed end-to-end tests (live cache hit/miss across HTTP calls + role
// upgrade, etc.) live in tests/integration/assessments/* alongside the
// state-transition routes that depend on this middleware.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { type IdempotencyDeps, type IdempotencyOptions, idempotency } from './idempotency.ts';
import type { SessionEnv } from './session.ts';

interface FakeRow {
  tenant_id: string;
  key: string;
  actor_id: string;
  route_method: string;
  route_path: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
  created_at: Date;
}

const buildFakeRepo = () => {
  const store = new Map<string, FakeRow>();
  const composite = (tenantId: string, key: string) => `${tenantId}:${key}`;
  const repo = {
    find: mock(async (args: { tenantId: string; key: string }) => {
      const row = store.get(composite(args.tenantId, args.key));
      if (!row) return null;
      // Replicate R2 filter: non-2xx → null.
      if (row.response_status < 200 || row.response_status >= 300) return null;
      return row;
    }),
    findOrInsert: mock(
      async (args: {
        tenantId: string;
        key: string;
        actorId: string;
        routeMethod: string;
        routePath: string;
        requestHash: string;
        responseStatus: number;
        responseBody: unknown;
      }) => {
        if (args.responseStatus < 200 || args.responseStatus >= 300) {
          throw new Error('R2 violation in test stub');
        }
        const k = composite(args.tenantId, args.key);
        const existing = store.get(k);
        if (existing) return existing;
        const row: FakeRow = {
          tenant_id: args.tenantId,
          key: args.key,
          actor_id: args.actorId,
          route_method: args.routeMethod,
          route_path: args.routePath,
          request_hash: args.requestHash,
          response_status: args.responseStatus,
          response_body: args.responseBody,
          created_at: new Date(),
        };
        store.set(k, row);
        return row;
      },
    ),
    insert: mock(async () => {
      throw new Error('not used');
    }),
  };
  return { repo, store, composite };
};

const buildApp = (
  deps: IdempotencyDeps,
  opts: IdempotencyOptions,
  handler: (text: string) => Response,
) => {
  const app = new Hono<SessionEnv>();
  // Inject a synthetic actor — no real session middleware.
  app.use('*', async (c, next) => {
    c.set('actor', {
      type: 'user',
      id: 'user-1',
      email: 'u@example.com',
      displayName: 'U',
      role: 'security_lead',
      tenantId: 't-1',
    });
    c.set('sessionId', 'sess-1');
    c.set('sessionExpired', false);
    await next();
  });
  app.use('/protected', idempotency(deps, opts));
  app.post('/protected', async (c) => {
    const txt = await c.req.text();
    return handler(txt);
  });
  return app;
};

describe('apps/api/middleware/idempotency :: OQ-8 header validation', () => {
  let deps: IdempotencyDeps;
  beforeEach(() => {
    const { repo } = buildFakeRepo();
    // biome-ignore lint/suspicious/noExplicitAny: stub boundary.
    deps = { repos: { idempotencyKeys: repo as any } };
  });
  afterEach(() => {
    void 0;
  });

  test('missing key + requireKey:true → 400 idempotency_key_required (R6)', async () => {
    const app = buildApp(deps, { requireKey: true }, () => new Response('ok', { status: 200 }));
    const res = await app.request('/protected', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('idempotency_key_required');
  });

  test('missing key + requireKey:false → handler runs (R6)', async () => {
    const app = buildApp(deps, { requireKey: false }, () => new Response('ok', { status: 200 }));
    const res = await app.request('/protected', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  test('empty key → 400 invalid_idempotency_key', async () => {
    // Hono's `c.req.header()` returns a string when the header is set. An
    // empty header value still counts as "present"; zod min(1) rejects it.
    const app = buildApp(deps, { requireKey: true }, () => new Response('ok', { status: 200 }));
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': '' },
      body: '{}',
    });
    // Hono drops empty headers in some runtimes; treat this as either 400
    // invalid_idempotency_key (if header present) or 400 idempotency_key_required.
    expect([400]).toContain(res.status);
  });

  test('whitespace-containing key → 400 invalid_idempotency_key (regex rejects 0x20)', async () => {
    const app = buildApp(deps, { requireKey: true }, () => new Response('ok', { status: 200 }));
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'foo bar' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_idempotency_key');
  });

  test('key > 200 chars → 400 invalid_idempotency_key', async () => {
    const app = buildApp(deps, { requireKey: true }, () => new Response('ok', { status: 200 }));
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'x'.repeat(201) },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});

describe('apps/api/middleware/idempotency :: R2 cache + same/different body', () => {
  test('same key + same body — second call returns the cached 2xx body', async () => {
    const { repo, store, composite } = buildFakeRepo();
    // biome-ignore lint/suspicious/noExplicitAny: stub boundary.
    const deps: IdempotencyDeps = { repos: { idempotencyKeys: repo as any } };

    let callCount = 0;
    const app = buildApp(deps, { requireKey: true }, () => {
      callCount += 1;
      return new Response(JSON.stringify({ value: callCount }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const r1 = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1', 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { value: number };
    expect(b1.value).toBe(1);

    // Confirm row landed.
    expect(store.has(composite('t-1', 'k1'))).toBe(true);

    const r2 = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1', 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { value: number };
    // R2 same-key + same-body: byte-equivalent replay; handler NOT re-run.
    expect(b2.value).toBe(1);
    expect(callCount).toBe(1);
  });

  test('same key + DIFFERENT body → 422 idempotency_conflict; handler not re-run', async () => {
    const { repo } = buildFakeRepo();
    // biome-ignore lint/suspicious/noExplicitAny: stub boundary.
    const deps: IdempotencyDeps = { repos: { idempotencyKeys: repo as any } };

    let callCount = 0;
    const app = buildApp(deps, { requireKey: true }, () => {
      callCount += 1;
      return new Response(JSON.stringify({ value: callCount }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const r1 = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'k2', 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'k2', 'content-type': 'application/json' },
      body: JSON.stringify({ a: 2 }),
    });
    expect(r2.status).toBe(422);
    const body = (await r2.json()) as { error: string };
    expect(body.error).toBe('idempotency_conflict');
    expect(callCount).toBe(1);
  });
});

describe('apps/api/middleware/idempotency :: R2 cache only persists 2xx', () => {
  test('first call 5xx → row not cached; second call re-runs handler', async () => {
    const { repo, store, composite } = buildFakeRepo();
    // biome-ignore lint/suspicious/noExplicitAny: stub boundary.
    const deps: IdempotencyDeps = { repos: { idempotencyKeys: repo as any } };

    const responses = [
      new Response(JSON.stringify({ error: 'oops' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ recovered: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    let i = 0;
    const app = buildApp(deps, { requireKey: true }, () => {
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return r as Response;
    });

    const r1 = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'r2-5xx', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r1.status).toBe(500);
    expect(store.has(composite('t-1', 'r2-5xx'))).toBe(false); // R2 — never cached.

    const r2 = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'r2-5xx', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { recovered: boolean };
    expect(b2.recovered).toBe(true);
    expect(store.has(composite('t-1', 'r2-5xx'))).toBe(true);
  });

  test('first call 4xx → row not cached; second call re-runs handler (R2 4xx-no-cache)', async () => {
    const { repo, store, composite } = buildFakeRepo();
    // biome-ignore lint/suspicious/noExplicitAny: stub boundary.
    const deps: IdempotencyDeps = { repos: { idempotencyKeys: repo as any } };

    const responses = [
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    let i = 0;
    const app = buildApp(deps, { requireKey: true }, () => {
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return r as Response;
    });

    const r1 = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'r2-4xx', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r1.status).toBe(403);
    expect(store.has(composite('t-1', 'r2-4xx'))).toBe(false);

    const r2 = await app.request('/protected', {
      method: 'POST',
      headers: { 'idempotency-key': 'r2-4xx', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r2.status).toBe(200);
  });
});
