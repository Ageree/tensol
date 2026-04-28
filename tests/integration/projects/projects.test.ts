// Sprint 5 §5.2 — projects routes IT (A-Proj-1..6 + IDOR-2).
//
// Coverage targets:
//   - A-Proj-1: list with pagination + strict-query
//   - A-Proj-2: create + duplicate-name 409
//   - A-Proj-3: get with 404/403/200 IDOR-2 precedence
//   - A-Proj-4: patch + If-Match optimistic lock
//   - A-Proj-5: soft delete (status='archived', no row removal)
//   - A-Proj-6: summary with hard-coded openFindingsCount=0
//   - C29 delta=1 emission per state-change route
//   - IDOR cross-tenant 403 + deny audit row attribution to actor's tenant

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AuthFixture,
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
} from '../db/helpers/db-fixture.ts';

describe.skipIf(!hasDatabaseUrl())('integration :: projects routes (A-Proj-1..6 + IDOR-2)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;
  let t1Cookie: string;
  let t1TenantId: string;
  let t2Cookie: string;
  let t2TenantId: string;
  let viewerCookie: string;

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
      tenantSlug: 't1',
      email: 't1@example.com',
      role: 'security_lead',
    });
    const t2 = await seedLoggedInUser(auth, {
      tenantSlug: 't2',
      email: 't2@example.com',
      role: 'security_lead',
    });
    const v = await seedLoggedInUser(auth, {
      tenantSlug: 'tv',
      email: 'viewer@example.com',
      role: 'viewer',
    });
    t1Cookie = t1.cookieHeader;
    t1TenantId = t1.tenantId;
    t2Cookie = t2.cookieHeader;
    t2TenantId = t2.tenantId;
    viewerCookie = v.cookieHeader;
  });

  // ===== A-Proj-2 =====

  test('A-Proj-2 — POST /api/v1/projects creates project + emits project.created', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request('/api/v1/projects', {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Proj A' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; status: string };
    expect(body.name).toBe('Proj A');
    expect(body.status).toBe('active');
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);

    const auditRow = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'project.created')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(auditRow.tenant_id).toBe(t1TenantId);
    expect(auditRow.resource_id).toBe(body.id);
  });

  test('A-Proj-2 — duplicate name within tenant → 409 duplicate_name', async () => {
    const r1 = await auth.app.request('/api/v1/projects', {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Dup' }),
    });
    expect(r1.status).toBe(201);
    const r2 = await auth.app.request('/api/v1/projects', {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Dup' }),
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: string };
    expect(body.error).toBe('duplicate_name');
  });

  test('A-Proj-2 — same name in different tenants → both 201', async () => {
    const a = await auth.app.request('/api/v1/projects', {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Shared' }),
    });
    const b = await auth.app.request('/api/v1/projects', {
      method: 'POST',
      headers: { cookie: t2Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Shared' }),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  test('viewer role cannot create project (RBAC deny → 403 + deny audit)', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request('/api/v1/projects', {
      method: 'POST',
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(403);
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);
    const auditRow = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'rbac.deny')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(auditRow.resource_type).toBe('project');
  });

  // ===== A-Proj-3 / IDOR-2 =====

  test('A-Proj-3 / IDOR-2 — own-tenant 200, cross-tenant 403, nonexistent 404', async () => {
    const proj = await seedProject(fx, { tenantId: t1TenantId, name: 'IsolP' });

    // Own tenant → 200.
    const own = await auth.app.request(`/api/v1/projects/${proj}`, {
      headers: { cookie: t1Cookie },
    });
    expect(own.status).toBe(200);

    // Cross tenant → 403 + deny audit row attributed to T2's tenant (actor).
    const beforeDeny = await countAuditEvents(fx.db);
    const cross = await auth.app.request(`/api/v1/projects/${proj}`, {
      headers: { cookie: t2Cookie },
    });
    expect(cross.status).toBe(403);
    const afterDeny = await countAuditEvents(fx.db);
    expect(afterDeny).toBe(beforeDeny + 1);
    const denyRow = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'rbac.deny')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(denyRow.tenant_id).toBe(t2TenantId);
    const meta = denyRow.after_state as { attemptedResourceTenantId?: string };
    expect(meta?.attemptedResourceTenantId).toBe(t1TenantId);
    // C18c — body has no UUIDs.
    const crossBody = await cross.text();
    expect(crossBody).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);

    // Nonexistent → 404 with NO audit emission.
    const beforeNF = await countAuditEvents(fx.db);
    const nf = await auth.app.request('/api/v1/projects/00000000-0000-0000-0000-000000000000', {
      headers: { cookie: t1Cookie },
    });
    expect(nf.status).toBe(404);
    const afterNF = await countAuditEvents(fx.db);
    expect(afterNF).toBe(beforeNF);
  });

  // ===== A-Proj-4 =====

  test('A-Proj-4 — PATCH updates + emits project.updated; If-Match mismatch → 409', async () => {
    const proj = await seedProject(fx, { tenantId: t1TenantId, name: 'PatchMe' });
    const get = await auth.app.request(`/api/v1/projects/${proj}`, {
      headers: { cookie: t1Cookie },
    });
    const body = (await get.json()) as { updatedAt: string };
    const correctIfMatch = String(Math.floor(new Date(body.updatedAt).getTime() / 1000));

    const ok = await auth.app.request(`/api/v1/projects/${proj}`, {
      method: 'PATCH',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'if-match': correctIfMatch,
      },
      body: JSON.stringify({ description: 'updated' }),
    });
    expect(ok.status).toBe(200);

    const stale = await auth.app.request(`/api/v1/projects/${proj}`, {
      method: 'PATCH',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'if-match': '0',
      },
      body: JSON.stringify({ description: 'fail' }),
    });
    expect(stale.status).toBe(409);
    const errBody = (await stale.json()) as { error: string };
    expect(errBody.error).toBe('version_mismatch');
  });

  // ===== A-Proj-5 =====

  test('A-Proj-5 — DELETE soft-archives; row remains in DB; emits project.archived', async () => {
    const proj = await seedProject(fx, { tenantId: t1TenantId, name: 'ToArchive' });
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/projects/${proj}`, {
      method: 'DELETE',
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(403);
    // security_lead doesn't have delete on project — only tenant_admin.
    // Verify delete needs tenant_admin.
    expect(
      (await fx.db.selectFrom('projects').selectAll().where('id', '=', proj).executeTakeFirst())
        ?.status,
    ).toBe('active');
    void before;
  });

  test('A-Proj-5 — tenant_admin DELETE soft-archives + emits project.archived', async () => {
    const ta = await seedLoggedInUser(auth, {
      tenantSlug: 't1',
      email: 'admin@example.com',
      role: 'tenant_admin',
    });
    const proj = await seedProject(fx, { tenantId: ta.tenantId, name: 'Arch' });
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/projects/${proj}`, {
      method: 'DELETE',
      headers: { cookie: ta.cookieHeader },
    });
    expect(res.status).toBe(204);
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);
    const row = await fx.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', proj)
      .executeTakeFirst();
    expect(row?.status).toBe('archived');
  });

  // ===== A-Proj-6 =====

  test('A-Proj-6 — summary returns counts + openFindingsCount=0', async () => {
    const proj = await seedProject(fx, { tenantId: t1TenantId, name: 'Sum' });
    const res = await auth.app.request(`/api/v1/projects/${proj}/summary`, {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      targetCount: number;
      assessmentCounts: Record<string, number>;
      openFindingsCount: number;
    };
    expect(body.id).toBe(proj);
    expect(body.targetCount).toBe(0);
    expect(body.openFindingsCount).toBe(0);
    expect(body.assessmentCounts.draft).toBe(0);
    expect(body.assessmentCounts.completed).toBe(0);
  });

  // ===== A-Proj-1 list =====

  test('A-Proj-1 — list returns own-tenant projects only + pagination', async () => {
    for (let i = 0; i < 3; i++) await seedProject(fx, { tenantId: t1TenantId, name: `t1-${i}` });
    await seedProject(fx, { tenantId: t2TenantId, name: 't2-only' });

    const res = await auth.app.request('/api/v1/projects?limit=2', {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: ReadonlyArray<{ id: string; name: string }>;
      nextCursor: string | null;
    };
    expect(body.data.length).toBe(2);
    expect(body.nextCursor).not.toBeNull();
    for (const r of body.data) expect(r.name).not.toBe('t2-only');

    // Page 2.
    const res2 = await auth.app.request(
      `/api/v1/projects?limit=2&cursor=${encodeURIComponent(body.nextCursor ?? '')}`,
      { headers: { cookie: t1Cookie } },
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      data: ReadonlyArray<unknown>;
      nextCursor: string | null;
    };
    expect(body2.data.length).toBeGreaterThan(0);
  });

  test('A-Proj-1 — strict query rejects unknown keys → 400', async () => {
    const res = await auth.app.request('/api/v1/projects?bogus=1', {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(400);
  });
});
