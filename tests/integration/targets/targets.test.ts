// Sprint 5 §5.3 — targets routes IT (A-Tgt-1..7 + IDOR-2 + R1 evidence cap).

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
  seedAssessment,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';

describe.skipIf(!hasDatabaseUrl())('integration :: targets routes (A-Tgt-1..7 + R1)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;
  let t1Cookie: string;
  let t1TenantId: string;
  let t1UserId: string;
  let t2Cookie: string;
  let t2TenantId: string;
  let projectId: string;

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

  // Sprint 5 F1 fix: unique slug suffix per call (see projects.test.ts).
  const uniqSlug = (base: string): string =>
    `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
    t1UserId = t1.userId;
    t2Cookie = t2.cookieHeader;
    t2TenantId = t2.tenantId;
    projectId = await seedProject(fx, { tenantId: t1TenantId, name: 'P1' });
  });

  // ===== A-Tgt-2 =====

  test('A-Tgt-2 — POST /projects/:projectId/targets creates with ownership_status=unverified', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/projects/${projectId}/targets`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'url', value: 'https://example.com' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; ownershipStatus: string; kind: string };
    expect(body.ownershipStatus).toBe('unverified');
    expect(body.kind).toBe('url');
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);
  });

  test('A-Tgt-2 — client-provided ownership_status rejected by .strict() → 400', async () => {
    const res = await auth.app.request(`/api/v1/projects/${projectId}/targets`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'url',
        value: 'https://x.example',
        ownership_status: 'verified',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('A-Tgt-2 — duplicate (tenant, project, kind, value) → 409 duplicate_target', async () => {
    await auth.app.request(`/api/v1/projects/${projectId}/targets`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'domain', value: 'example.com' }),
    });
    const res = await auth.app.request(`/api/v1/projects/${projectId}/targets`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'domain', value: 'example.com' }),
    });
    expect(res.status).toBe(409);
  });

  // ===== A-Tgt-3 / IDOR-2 =====

  test('A-Tgt-3 / IDOR-2 — get: 200 own, 403 cross, 404 nonexistent', async () => {
    const tid = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      value: 'https://t1.example',
    });
    const own = await auth.app.request(`/api/v1/targets/${tid}`, { headers: { cookie: t1Cookie } });
    expect(own.status).toBe(200);
    const cross = await auth.app.request(`/api/v1/targets/${tid}`, {
      headers: { cookie: t2Cookie },
    });
    expect(cross.status).toBe(403);
    const nf = await auth.app.request('/api/v1/targets/00000000-0000-0000-0000-000000000000', {
      headers: { cookie: t1Cookie },
    });
    expect(nf.status).toBe(404);
  });

  // ===== A-Tgt-5 R1 =====

  test('A-Tgt-5 — ownership-proof flips status to pending + records claim + emits audit (no evidence in row)', async () => {
    const tid = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      value: 'https://op.example',
    });
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/targets/${tid}/ownership-proof`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt', evidence: 'verification=abc123' }),
    });
    expect(res.status).toBe(202);
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);
    const target = await fx.db
      .selectFrom('targets')
      .selectAll()
      .where('id', '=', tid)
      .executeTakeFirstOrThrow();
    expect(target.ownership_status).toBe('pending');
    const claim = await fx.db
      .selectFrom('target_ownership_claims')
      .selectAll()
      .where('target_id', '=', tid)
      .executeTakeFirstOrThrow();
    expect(claim.method).toBe('dns_txt');
    expect(claim.submitted_by_user_id).toBe(t1UserId);
    // Audit row metadata MUST NOT include the raw evidence.
    const auditRow = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'target.ownership_proof.submitted')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    const after_state = auditRow.after_state as Record<string, unknown>;
    expect(after_state).not.toHaveProperty('evidence');
    expect(after_state.evidenceLength).toBe('verification=abc123'.length);
  });

  test('A-Tgt-5 R1 — evidence > 8192 chars rejected by zod → 400', async () => {
    const tid = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      value: 'https://big.example',
    });
    const huge = 'x'.repeat(8193);
    const res = await auth.app.request(`/api/v1/targets/${tid}/ownership-proof`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'manual_attestation', evidence: huge }),
    });
    expect(res.status).toBe(400);
  });

  // ===== A-Tgt-6 =====

  test('A-Tgt-6 — DELETE refuses when target is referenced by an assessment → 409', async () => {
    // tenant_admin to delete.
    const ta = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1-admin'),
      email: 'admin@t1',
      role: 'tenant_admin',
    });
    const tid = await seedTarget(fx, {
      tenantId: ta.tenantId,
      projectId,
      value: 'https://ref.example',
    });
    const aId = await seedAssessment(fx, {
      tenantId: ta.tenantId,
      projectId,
      createdBy: ta.userId,
      targetIds: [tid],
    });
    void aId;
    const res = await auth.app.request(`/api/v1/targets/${tid}`, {
      method: 'DELETE',
      headers: { cookie: ta.cookieHeader },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('target_referenced');
  });

  test('A-Tgt-6 — DELETE allowed when no references; emits target.deleted', async () => {
    const ta = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1-admin2'),
      email: 'admin2@t1',
      role: 'tenant_admin',
    });
    const tid = await seedTarget(fx, {
      tenantId: ta.tenantId,
      projectId,
      value: 'https://del.example',
    });
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/targets/${tid}`, {
      method: 'DELETE',
      headers: { cookie: ta.cookieHeader },
    });
    expect(res.status).toBe(204);
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);
    const row = await fx.db
      .selectFrom('targets')
      .selectAll()
      .where('id', '=', tid)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  // ===== A-Tgt-7 =====

  test('A-Tgt-7 — observations placeholder returns empty list', async () => {
    const tid = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      value: 'https://obs.example',
    });
    const res = await auth.app.request(`/api/v1/targets/${tid}/observations`, {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ReadonlyArray<unknown>; nextCursor: string | null };
    expect(body.data).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  void t2TenantId;
});
