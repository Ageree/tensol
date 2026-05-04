// A-26-1..A-26-10 — scan launch + progress + billing integration tests.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AuthFixture,
  buildAuthApp,
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

describe.skipIf(!hasDatabaseUrl())('integration :: scan launch (A-26-1..A-26-10)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;
  let t1Cookie: string;
  let t1TenantId: string;
  let t2Cookie: string;
  let t1ProjectId: string;

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
    t1ProjectId = await seedProject(fx, { tenantId: t1TenantId, name: 'Test Project' });
  });

  // =========================================================================
  // A-26-1: POST /scans happy path — verified target, light tier
  // =========================================================================

  test('A-26-1 — POST /scans creates assessment and returns scan_id + state=running', async () => {
    const targetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1ProjectId,
      kind: 'domain',
      value: 'example.com',
      ownershipStatus: 'verified',
    });

    const res = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-1-${Date.now()}`,
      },
      body: JSON.stringify({ project_id: t1ProjectId, tier: 'light', target_ids: [targetId] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scan_id: string; state: string };
    expect(body.state).toBe('running');
    expect(typeof body.scan_id).toBe('string');

    // Verify assessment is in running state in DB.
    const row = await fx.db
      .selectFrom('assessments')
      .select(['state', 'metadata'])
      .where('id', '=', body.scan_id)
      .executeTakeFirst();
    expect(row?.state).toBe('running');
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta?.tier).toBe('light');
  });

  // =========================================================================
  // A-26-2: POST /scans — unverified target → 422
  // =========================================================================

  test('A-26-2 — POST /scans with unverified target returns 422 target_unverified', async () => {
    const targetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1ProjectId,
      kind: 'domain',
      value: 'unverified.example.com',
      ownershipStatus: 'unverified',
    });

    const res = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-2-${Date.now()}`,
      },
      body: JSON.stringify({ project_id: t1ProjectId, tier: 'light', target_ids: [targetId] }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; target_id: string };
    expect(body.error).toBe('target_unverified');
    expect(body.target_id).toBe(targetId);
  });

  // =========================================================================
  // A-26-3: POST /scans — cross-tenant target → 403
  // =========================================================================

  test('A-26-3 — POST /scans with cross-tenant target returns 403', async () => {
    // t2 seeds a target in their own project.
    const t2Seed = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t2x'),
      email: 't2x@example.com',
      role: 'security_lead',
    });
    const t2ProjectId = await seedProject(fx, { tenantId: t2Seed.tenantId, name: 'T2 Project' });
    const t2TargetId = await seedTarget(fx, {
      tenantId: t2Seed.tenantId,
      projectId: t2ProjectId,
      kind: 'domain',
      value: 'evil.com',
      ownershipStatus: 'verified',
    });

    const res = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-3-${Date.now()}`,
      },
      body: JSON.stringify({ project_id: t1ProjectId, tier: 'light', target_ids: [t2TargetId] }),
    });
    expect(res.status).toBe(403);
  });

  // =========================================================================
  // A-26-4: GET /scans — returns list for tenant
  // =========================================================================

  test('A-26-4 — GET /scans returns paginated list filtered by tenant', async () => {
    const targetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1ProjectId,
      kind: 'domain',
      value: 'list-test.com',
      ownershipStatus: 'verified',
    });
    await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-4-${Date.now()}`,
      },
      body: JSON.stringify({ project_id: t1ProjectId, tier: 'medium', target_ids: [targetId] }),
    });

    const res = await auth.app.request('/api/v1/scans', {
      method: 'GET',
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items.length).toBeGreaterThanOrEqual(1);

    // t2 should not see t1's scans.
    const res2 = await auth.app.request('/api/v1/scans', {
      method: 'GET',
      headers: { cookie: t2Cookie },
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { items: unknown[] };
    expect(body2.items.length).toBe(0);
  });

  // =========================================================================
  // A-26-5: GET /scans/:id — returns scan detail with tier in metadata
  // =========================================================================

  test('A-26-5 — GET /scans/:id returns assessment detail with tier in metadata', async () => {
    const targetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1ProjectId,
      kind: 'domain',
      value: 'detail-test.com',
      ownershipStatus: 'verified',
    });
    const launchRes = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-5-${Date.now()}`,
      },
      body: JSON.stringify({ project_id: t1ProjectId, tier: 'aggressive', target_ids: [targetId] }),
    });
    const { scan_id } = (await launchRes.json()) as { scan_id: string };

    const res = await auth.app.request(`/api/v1/scans/${scan_id}`, {
      method: 'GET',
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scan_id: string; state: string; tier: string };
    expect(body.scan_id).toBe(scan_id);
    expect(body.state).toBe('running');
    expect(body.tier).toBe('aggressive');
  });

  // =========================================================================
  // A-26-6: GET /scans/:id/progress — returns state + findings_count + events
  // =========================================================================

  test('A-26-6 — GET /scans/:id/progress returns state, findings_count, recent_audit_events', async () => {
    const targetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1ProjectId,
      kind: 'domain',
      value: 'progress-test.com',
      ownershipStatus: 'verified',
    });
    const launchRes = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-6-${Date.now()}`,
      },
      body: JSON.stringify({ project_id: t1ProjectId, tier: 'light', target_ids: [targetId] }),
    });
    const { scan_id } = (await launchRes.json()) as { scan_id: string };

    const res = await auth.app.request(`/api/v1/scans/${scan_id}/progress`, {
      method: 'GET',
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      findings_count: number;
      recent_audit_events: unknown[];
    };
    expect(body.state).toBe('running');
    expect(typeof body.findings_count).toBe('number');
    expect(Array.isArray(body.recent_audit_events)).toBe(true);
  });

  // =========================================================================
  // A-26-7: POST /billing/checkout — sets subscription
  // =========================================================================

  test('A-26-7 — POST /billing/checkout sets subscription tier+status=active', async () => {
    const res = await auth.app.request('/api/v1/billing/checkout', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-7-${Date.now()}`,
      },
      body: JSON.stringify({ tier: 'aggressive' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; tier: string };
    expect(body.success).toBe(true);
    expect(body.tier).toBe('aggressive');

    const sub = await fx.db
      .selectFrom('subscriptions')
      .select(['tier', 'status'])
      .where('tenant_id', '=', t1TenantId)
      .executeTakeFirst();
    expect(sub?.tier).toBe('aggressive');
    expect(sub?.status).toBe('active');
  });

  // =========================================================================
  // A-26-8: GET /billing/subscription — returns current tier+status
  // =========================================================================

  test('A-26-8 — GET /billing/subscription returns tier and status', async () => {
    // Before any checkout.
    const res1 = await auth.app.request('/api/v1/billing/subscription', {
      method: 'GET',
      headers: { cookie: t1Cookie },
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { tier: string | null; status: string };
    expect(body1.tier).toBeNull();
    expect(body1.status).toBe('none');

    // After checkout.
    await auth.app.request('/api/v1/billing/checkout', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-8-${Date.now()}`,
      },
      body: JSON.stringify({ tier: 'medium' }),
    });

    const res2 = await auth.app.request('/api/v1/billing/subscription', {
      method: 'GET',
      headers: { cookie: t1Cookie },
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { tier: string; status: string };
    expect(body2.tier).toBe('medium');
    expect(body2.status).toBe('active');
  });

  // =========================================================================
  // A-26-9: POST /billing/checkout then GET /billing/subscription — round-trip
  // =========================================================================

  test('A-26-9 — billing checkout round-trip: UPSERT updates existing subscription tier', async () => {
    const ts = Date.now();
    await auth.app.request('/api/v1/billing/checkout', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-9a-${ts}`,
      },
      body: JSON.stringify({ tier: 'light' }),
    });
    await auth.app.request('/api/v1/billing/checkout', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-9b-${ts}`,
      },
      body: JSON.stringify({ tier: 'aggressive' }),
    });

    const res = await auth.app.request('/api/v1/billing/subscription', {
      method: 'GET',
      headers: { cookie: t1Cookie },
    });
    const body = (await res.json()) as { tier: string; status: string };
    expect(body.tier).toBe('aggressive');
    expect(body.status).toBe('active');

    // Exactly one subscription row for tenant.
    const count = await fx.db
      .selectFrom('subscriptions')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('tenant_id', '=', t1TenantId)
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(1);
  });

  // =========================================================================
  // A-26-10: Tenant isolation — t1 scan not visible to t2
  // =========================================================================

  test('A-26-10 — tenant isolation: scan from tenantA not accessible by tenantB', async () => {
    const targetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1ProjectId,
      kind: 'domain',
      value: 'isolation-test.com',
      ownershipStatus: 'verified',
    });
    const launchRes = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-10-${Date.now()}`,
      },
      body: JSON.stringify({ project_id: t1ProjectId, tier: 'light', target_ids: [targetId] }),
    });
    const { scan_id } = (await launchRes.json()) as { scan_id: string };

    // t2 tries to access t1's scan detail.
    const res = await auth.app.request(`/api/v1/scans/${scan_id}`, {
      method: 'GET',
      headers: { cookie: t2Cookie },
    });
    expect(res.status).toBe(404);

    // t2 tries to access t1's scan progress.
    const res2 = await auth.app.request(`/api/v1/scans/${scan_id}/progress`, {
      method: 'GET',
      headers: { cookie: t2Cookie },
    });
    expect(res2.status).toBe(404);
  });

  // =========================================================================
  // A-26-11: POST /scans is idempotent under same Idempotency-Key
  // =========================================================================

  test('A-26-11 — POST /scans with same Idempotency-Key returns same scan_id, no duplicate assessment', async () => {
    const targetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1ProjectId,
      kind: 'domain',
      value: 'idem-test.com',
      ownershipStatus: 'verified',
    });

    const idemKey = `idem-test-${Date.now()}`;
    const payload = JSON.stringify({
      project_id: t1ProjectId,
      tier: 'light',
      target_ids: [targetId],
    });

    const res1 = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json', 'idempotency-key': idemKey },
      body: payload,
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { scan_id: string; state: string };
    expect(body1.state).toBe('running');

    // Second request with same key — must return same scan_id without creating new assessment.
    const res2 = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json', 'idempotency-key': idemKey },
      body: payload,
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { scan_id: string; state: string };
    expect(body2.scan_id).toBe(body1.scan_id);

    // Exactly one assessment row must exist.
    const count = await fx.db
      .selectFrom('assessments')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('tenant_id', '=', t1TenantId)
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(1);
  });

  // =========================================================================
  // A-26-12: aggressive tier writes high_impact_categories to assessment row
  // =========================================================================

  test('A-26-12 — POST /scans tier=aggressive writes high_impact_categories=[c2,post_exploit,ad,credential_audit]', async () => {
    const targetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1ProjectId,
      kind: 'domain',
      value: 'hic-test.com',
      ownershipStatus: 'verified',
    });

    const res = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `a26-12-${Date.now()}`,
      },
      body: JSON.stringify({ project_id: t1ProjectId, tier: 'aggressive', target_ids: [targetId] }),
    });
    expect(res.status).toBe(200);
    const { scan_id } = (await res.json()) as { scan_id: string };

    const row = await fx.db
      .selectFrom('assessments')
      .select('high_impact_categories')
      .where('id', '=', scan_id)
      .executeTakeFirstOrThrow();

    const hic = row.high_impact_categories as string[];
    expect(hic).toContain('c2');
    expect(hic).toContain('post_exploit');
    expect(hic).toContain('ad');
    expect(hic).toContain('credential_audit');
    expect(hic.length).toBe(4);
  });
});
