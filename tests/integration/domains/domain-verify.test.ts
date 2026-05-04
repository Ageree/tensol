// Sprint 25 — domain verification integration tests (A-25-5..6).
// DNS lookups use injected mock resolver — no real network calls (P46).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AppOptions,
  type TxtDnsResolver,
  createApp,
  createPreAuthStore,
  createRateLimiter,
} from '@cyberstrike/api';
import { createBcryptHasher, createTotpVerifier } from '@cyberstrike/authz';
import { buildRepositories } from '@cyberstrike/db';
import {
  type AuthFixture,
  TEST_COOKIE_NAME,
  buildAuthApp,
  countAuditEvents,
  hasDatabaseUrl,
  resetAuthState,
  seedLoggedInUser,
} from '../auth/helpers/auth-fixture.ts';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';

// ---------------------------------------------------------------------------
// Mock DNS resolver factory — caller controls what resolveTxt returns.
// ---------------------------------------------------------------------------
const makeMockResolver = (
  behaviour: 'found' | 'not_found' | 'error',
  token?: string,
): TxtDnsResolver => ({
  resolveTxt: async (_hostname: string): Promise<string[][]> => {
    if (behaviour === 'error') throw new Error('ENOTFOUND mock');
    if (behaviour === 'not_found') return [];
    // 'found': return the token in two parts to exercise join logic (M1 fix).
    const t = token ?? '';
    const mid = Math.floor(t.length / 2);
    return [[t.slice(0, mid), t.slice(mid)]];
  },
});

// Build a fresh Hono app with an overridden DNS resolver.
// Duplicates buildAuthApp config to avoid circular fixture dep.
const buildAppWithResolver = (db: DbFixture['db'], resolver: TxtDnsResolver) => {
  const config: AppOptions['config'] = {
    appEnv: 'local' as const,
    bcryptCost: 4,
    bootstrapToken: undefined,
    cookieName: TEST_COOKIE_NAME,
    cookieSecure: false,
    sessionSecret: 'a'.repeat(64),
    databaseUrl: process.env.DATABASE_URL ?? '',
  };
  const hasher = createBcryptHasher({ cost: 4 });
  const totp = createTotpVerifier();
  const preAuthStore = createPreAuthStore();
  const rateLimiter = createRateLimiter({ maxFailures: 5, windowSeconds: 60 });
  const repos = buildRepositories(db);
  const { app } = createApp({
    config,
    db,
    repos,
    hasher,
    totp,
    preAuthStore,
    rateLimiter,
    dnsResolver: resolver,
  });
  return app;
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe.skipIf(!hasDatabaseUrl())('integration :: domain-verify routes (A-25-5..6)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;
  let t1Cookie: string;
  let t1TenantId: string;
  let t2Cookie: string;
  let projectId: string;
  let domainTargetId: string;
  let urlTargetId: string;

  const uniqSlug = (base: string): string =>
    `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    fx = await createFixture();
    await dropAllTables(fx);
    await applyAllMigrations(fx);
    auth = buildAuthApp(fx.db);
  });

  afterAll(async () => {
    await dropAllTables(fx);
    await fx.db.destroy();
  });

  beforeEach(async () => {
    await resetAuthState(fx.db);

    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1'),
      email: 't1@example.com',
      role: 'security_lead',
    });
    const t2 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t2'),
      email: 't2@example.com',
      role: 'security_lead',
    });
    t1Cookie = t1.cookieHeader;
    t1TenantId = t1.tenantId;
    t2Cookie = t2.cookieHeader;

    projectId = await seedProject(fx, { tenantId: t1TenantId, name: 'proj-dv' });
    domainTargetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      kind: 'domain',
      value: 'example.com',
    });
    urlTargetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      kind: 'url',
      value: 'https://example.com',
    });
  });

  // -----------------------------------------------------------------------
  // A-25-5 — POST /api/v1/domains/verify/start
  // -----------------------------------------------------------------------

  test('A-25-5-a: start returns 201 + token + instructions for a fresh domain target', async () => {
    const res = await auth.app.request('/api/v1/domains/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: t1Cookie },
      body: JSON.stringify({ targetId: domainTargetId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.token).toBe('string');
    expect((body.token as string).startsWith('cs-verify=')).toBe(true);
    expect(typeof body.instructions).toBe('string');
    expect(typeof body.expires_at).toBe('string');
  });

  test('A-25-5-b: start is idempotent — re-posting within TTL returns same token', async () => {
    const r1 = await auth.app.request('/api/v1/domains/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: t1Cookie },
      body: JSON.stringify({ targetId: domainTargetId }),
    });
    const b1 = (await r1.json()) as { token: string };

    const r2 = await auth.app.request('/api/v1/domains/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: t1Cookie },
      body: JSON.stringify({ targetId: domainTargetId }),
    });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { token: string };
    expect(b2.token).toBe(b1.token);
  });

  test('A-25-5-c: start emits domain.verify.requested audit row', async () => {
    const before = await countAuditEvents(fx.db);
    await auth.app.request('/api/v1/domains/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: t1Cookie },
      body: JSON.stringify({ targetId: domainTargetId }),
    });
    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);

    const row = await fx.db
      .selectFrom('audit_events')
      .select(['action'])
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(row.action).toBe('domain.verify.requested');
  });

  test('A-25-5-d: start returns 422 for non-domain target', async () => {
    const res = await auth.app.request('/api/v1/domains/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: t1Cookie },
      body: JSON.stringify({ targetId: urlTargetId }),
    });
    expect(res.status).toBe(422);
  });

  test('A-25-5-e: start returns 404 for unknown targetId', async () => {
    const res = await auth.app.request('/api/v1/domains/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: t1Cookie },
      body: JSON.stringify({ targetId: '00000000-0000-0000-0000-000000000001' }),
    });
    expect(res.status).toBe(404);
  });

  test('A-25-5-f: start returns 403 IDOR when cross-tenant targetId used', async () => {
    const res = await auth.app.request('/api/v1/domains/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: t2Cookie },
      body: JSON.stringify({ targetId: domainTargetId }),
    });
    expect(res.status).toBe(403);
  });

  test('A-25-5-g: start returns 200 alreadyVerified when target already verified', async () => {
    await fx.db
      .insertInto('domain_verifications')
      .values({
        tenant_id: t1TenantId,
        target_id: domainTargetId,
        domain: 'example.com',
        token: 'cs-verify=deadbeef',
        status: 'verified',
        verified_at: new Date(),
        expires_at: new Date(Date.now() + 1000),
      })
      .execute();

    const res = await auth.app.request('/api/v1/domains/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: t1Cookie },
      body: JSON.stringify({ targetId: domainTargetId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyVerified: boolean };
    expect(body.alreadyVerified).toBe(true);
  });

  // -----------------------------------------------------------------------
  // A-25-6 — GET /api/v1/domains/verify/check
  // -----------------------------------------------------------------------

  const startAndGetToken = async (): Promise<string> => {
    const res = await auth.app.request('/api/v1/domains/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: t1Cookie },
      body: JSON.stringify({ targetId: domainTargetId }),
    });
    const body = (await res.json()) as { token: string };
    return body.token;
  };

  test('A-25-6-a: check with matching TXT record returns 200 verified + flips target ownership', async () => {
    const token = await startAndGetToken();
    const app = buildAppWithResolver(fx.db, makeMockResolver('found', token));

    const res = await app.request(`/api/v1/domains/verify/check?targetId=${domainTargetId}`, {
      headers: { Cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('verified');

    const target = await fx.db
      .selectFrom('targets')
      .select('ownership_status')
      .where('id', '=', domainTargetId)
      .executeTakeFirstOrThrow();
    expect(target.ownership_status).toBe('verified');
  });

  test('A-25-6-b: check with token split across parts is joined and matched', async () => {
    const token = await startAndGetToken();
    const splitResolver: TxtDnsResolver = {
      resolveTxt: async () => [[token.slice(0, 30), token.slice(30)]],
    };
    const app = buildAppWithResolver(fx.db, splitResolver);

    const res = await app.request(`/api/v1/domains/verify/check?targetId=${domainTargetId}`, {
      headers: { Cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('verified');
  });

  test('A-25-6-c: check returns 200 pending when TXT record not found', async () => {
    await startAndGetToken();
    const app = buildAppWithResolver(fx.db, makeMockResolver('not_found'));

    const res = await app.request(`/api/v1/domains/verify/check?targetId=${domainTargetId}`, {
      headers: { Cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('pending');
  });

  test('A-25-6-d: check returns 502 on DNS lookup error', async () => {
    await startAndGetToken();
    const app = buildAppWithResolver(fx.db, makeMockResolver('error'));

    const res = await app.request(`/api/v1/domains/verify/check?targetId=${domainTargetId}`, {
      headers: { Cookie: t1Cookie },
    });
    expect(res.status).toBe(502);
  });

  test('A-25-6-e: check returns 404 when no verification row exists', async () => {
    const app = buildAppWithResolver(fx.db, makeMockResolver('not_found'));

    const res = await app.request(`/api/v1/domains/verify/check?targetId=${domainTargetId}`, {
      headers: { Cookie: t1Cookie },
    });
    expect(res.status).toBe(404);
  });

  test('A-25-6-f: check returns 410 gone when token is expired', async () => {
    await fx.db
      .insertInto('domain_verifications')
      .values({
        tenant_id: t1TenantId,
        target_id: domainTargetId,
        domain: 'example.com',
        token: 'cs-verify=expired',
        status: 'pending',
        expires_at: new Date(Date.now() - 1000),
      })
      .execute();

    const app = buildAppWithResolver(fx.db, makeMockResolver('not_found'));
    const res = await app.request(`/api/v1/domains/verify/check?targetId=${domainTargetId}`, {
      headers: { Cookie: t1Cookie },
    });
    expect(res.status).toBe(410);
  });

  test('A-25-6-g: check returns 403 IDOR when cross-tenant targetId used', async () => {
    await startAndGetToken();
    const app = buildAppWithResolver(fx.db, makeMockResolver('not_found'));

    const res = await app.request(`/api/v1/domains/verify/check?targetId=${domainTargetId}`, {
      headers: { Cookie: t2Cookie },
    });
    expect(res.status).toBe(403);
  });

  test('A-25-6-h: check emits checked + confirmed audit rows on success', async () => {
    const token = await startAndGetToken();
    const app = buildAppWithResolver(fx.db, makeMockResolver('found', token));

    const before = await countAuditEvents(fx.db);
    await app.request(`/api/v1/domains/verify/check?targetId=${domainTargetId}`, {
      headers: { Cookie: t1Cookie },
    });
    const after = await countAuditEvents(fx.db);
    expect(after - before).toBeGreaterThanOrEqual(2);

    const rows = await fx.db
      .selectFrom('audit_events')
      .select('action')
      .orderBy('created_at', 'desc')
      .limit(2)
      .execute();
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('domain.verify.confirmed');
    expect(actions).toContain('domain.verify.checked');
  });
});
