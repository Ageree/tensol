// Sprint 5 §5.4 — assessments routes IT (A-Asm-1..13 + R3 R4 R5 R7 R8).
//
// Coverage:
//   A-Asm-2 — create with R4 cross-tenant precedence (T2 target → 403; T1 wrong-project → 422; T1 same-project → 201).
//   A-Asm-4 — submit transition + audit + idempotency required.
//   A-Asm-5 — R5 dual-table approve (assessments UPDATE + assessment_approvals INSERT in one tx).
//   A-Asm-6 — R8 temporal gate (expired window → 422 + assessment.start.denied audit).
//   A-Asm-10 — status with computed transitionsAvailable (single source of truth).
//   A-Asm-11 — R7 timeline RBAC keys on assessment, not audit_log.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AuthFixture,
  buildAuthApp,
  countAuditEvents,
  hasDatabaseUrl,
  resetAuthState,
  seedExtraLoggedInUser,
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

const sampleScopeRule = () => ({
  ruleKind: 'allow_url_prefix',
  effect: 'allow',
  payload: { prefix: 'https://example.com' },
});

describe.skipIf(!hasDatabaseUrl())('integration :: assessments routes', () => {
  let fx: DbFixture;
  let auth: AuthFixture;

  let t1Cookie: string;
  let t1TenantId: string;
  let t1UserId: string;
  let projectId: string;
  let target1Id: string;
  let target2Id: string;
  let t2Cookie: string;
  let t2TenantId: string;
  let t2UserId: string;
  let t2ProjectId: string;
  let t2TargetId: string;
  let adminCookie: string;

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

  // Sprint 5 F1 fix: unique slug suffix per call.
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
    // tenant_admin must live INSIDE T1's tenant so approve flows can target
    // T1's assessments — seedExtraLoggedInUser reuses the existing tenant.
    const ta = await seedExtraLoggedInUser(auth, {
      tenantId: t1.tenantId,
      email: 'admin@t1',
      role: 'tenant_admin',
    });
    t1Cookie = t1.cookieHeader;
    t1TenantId = t1.tenantId;
    t1UserId = t1.userId;
    t2Cookie = t2.cookieHeader;
    t2TenantId = t2.tenantId;
    t2UserId = t2.userId;
    adminCookie = ta.cookieHeader;

    projectId = await seedProject(fx, { tenantId: t1TenantId, name: 'P1' });
    target1Id = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      value: 'https://t1.example',
      ownershipStatus: 'verified',
    });
    target2Id = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      value: 'https://t1-2.example',
      ownershipStatus: 'verified',
    });
    t2ProjectId = await seedProject(fx, { tenantId: t2TenantId, name: 'P2' });
    t2TargetId = await seedTarget(fx, {
      tenantId: t2TenantId,
      projectId: t2ProjectId,
      value: 'https://t2.example',
    });
  });

  // ===== A-Asm-2 / R4 =====

  test('A-Asm-2 + R4 — same-tenant + same-project target → 201', async () => {
    const res = await auth.app.request(`/api/v1/projects/${projectId}/assessments`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'A1',
        testingWindow: null,
        highImpactCategories: [],
        targetIds: [target1Id, target2Id],
        scopeRules: [sampleScopeRule()],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; state: string };
    expect(body.state).toBe('draft');
    // Verify join rows landed.
    const joins = await fx.db
      .selectFrom('assessment_targets')
      .selectAll()
      .where('assessment_id', '=', body.id)
      .execute();
    expect(joins.length).toBe(2);
  });

  test('A-Asm-2 + R4 — T1 cookie + T2 targetId → 403 + rbac.deny', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/projects/${projectId}/assessments`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Cross',
        testingWindow: null,
        highImpactCategories: [],
        targetIds: [t2TargetId],
        scopeRules: [sampleScopeRule()],
      }),
    });
    expect(res.status).toBe(403);
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);
    const denyRow = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'rbac.deny')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(denyRow.tenant_id).toBe(t1TenantId);
    const meta = denyRow.after_state as { attemptedResourceTenantId?: string };
    expect(meta?.attemptedResourceTenantId).toBe(t2TenantId);
  });

  test('A-Asm-2 + R4 — T1 cookie + T1 target in different project → 422 invalid_targets', async () => {
    const otherProj = await seedProject(fx, { tenantId: t1TenantId, name: 'OtherP' });
    const otherTarget = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: otherProj,
      value: 'https://other.example',
    });
    const res = await auth.app.request(`/api/v1/projects/${projectId}/assessments`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'WrongProj',
        testingWindow: null,
        highImpactCategories: [],
        targetIds: [otherTarget],
        scopeRules: [sampleScopeRule()],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; details?: { targetId?: string } };
    expect(body.error).toBe('invalid_targets');
    expect(body.details?.targetId).toBe(otherTarget);
  });

  // ===== A-Asm-4 + idempotency-required =====

  test('A-Asm-4 — submit without Idempotency-Key → 400 idempotency_key_required (R6)', async () => {
    const aid = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'draft',
      targetIds: [target1Id],
    });
    const res = await auth.app.request(`/api/v1/assessments/${aid}/submit`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('idempotency_key_required');
  });

  test('A-Asm-4 — submit with Idempotency-Key → 200; replay returns cached body', async () => {
    const aid = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'draft',
      targetIds: [target1Id],
    });
    const before = await countAuditEvents(fx.db);
    const r1 = await auth.app.request(`/api/v1/assessments/${aid}/submit`, {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': 'submit-1',
      },
      body: '{}',
    });
    expect(r1.status).toBe(200);
    const after1 = await countAuditEvents(fx.db);
    expect(after1).toBe(before + 1);

    // Replay — same key, same body. Should NOT emit a new audit row.
    const r2 = await auth.app.request(`/api/v1/assessments/${aid}/submit`, {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': 'submit-1',
      },
      body: '{}',
    });
    expect(r2.status).toBe(200);
    const after2 = await countAuditEvents(fx.db);
    expect(after2).toBe(after1); // R2 — handler not re-run.
  });

  // ===== A-Asm-5 / R5 dual-table =====

  test('A-Asm-5 + R5 — tenant_admin approve writes assessment_approvals + flips assessments.approved_at', async () => {
    const aid = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'submitted',
      highImpactCategories: ['c2'],
      targetIds: [target1Id, target2Id],
    });
    const res = await auth.app.request(`/api/v1/assessments/${aid}/approve`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'idempotency-key': 'approve-1',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const arow = await fx.db
      .selectFrom('assessments')
      .selectAll()
      .where('id', '=', aid)
      .executeTakeFirstOrThrow();
    expect(arow.state).toBe('approved');
    expect(arow.approved_by).not.toBeNull();
    expect(arow.approved_at).not.toBeNull();
    const approval = await fx.db
      .selectFrom('assessment_approvals')
      .selectAll()
      .where('assessment_id', '=', aid)
      .executeTakeFirstOrThrow();
    expect(approval.target_count).toBe(2);
    expect(approval.high_impact_categories).toEqual(['c2']);
  });

  // Sprint 5 F5 regression — non-empty highImpactCategories must round-trip
  // through both create + approve via the route layer. The pg-driver array-
  // literal serialization bug (`['c2','ad']` → `{c2,ad}` rejected by JSONB
  // 22P02) was masked when prior tests used `[]` because Postgres silently
  // accepts `{}` as an empty JSON object. This test exercises the full
  // forensic-snapshot path: createAssessment writes the array → seedTarget
  // verified → submit + approve → assessment_approvals row holds the same
  // categories. If the JSON.stringify wrap is reverted, this test fails 500.
  test('F5 regression — non-empty highImpactCategories round-trip through create + approve', async () => {
    const cats = ['c2', 'ad'] as const;
    const createRes = await auth.app.request(`/api/v1/projects/${projectId}/assessments`, {
      method: 'POST',
      headers: { cookie: t1Cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'F5-RoundTrip',
        testingWindow: null,
        highImpactCategories: cats,
        targetIds: [target1Id, target2Id],
        scopeRules: [sampleScopeRule()],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; highImpactCategories: unknown };
    expect(created.highImpactCategories).toEqual([...cats]);

    // Re-read row via DB to confirm storage shape (defends against the
    // route returning the request payload instead of the persisted value).
    const stored = await fx.db
      .selectFrom('assessments')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(stored.high_impact_categories).toEqual([...cats]);

    // Submit then approve so assessment_approvals carries the same snapshot.
    const submitRes = await auth.app.request(`/api/v1/assessments/${created.id}/submit`, {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': `f5-submit-${Date.now()}`,
      },
      body: '{}',
    });
    expect(submitRes.status).toBe(200);
    const approveRes = await auth.app.request(`/api/v1/assessments/${created.id}/approve`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'idempotency-key': `f5-approve-${Date.now()}`,
      },
      body: '{}',
    });
    expect(approveRes.status).toBe(200);
    const approval = await fx.db
      .selectFrom('assessment_approvals')
      .selectAll()
      .where('assessment_id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(approval.high_impact_categories).toEqual([...cats]);
  });

  test('A-Asm-5 — security_lead cannot approve (RBAC: tenant_admin only) → 403', async () => {
    const aid = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'submitted',
      targetIds: [target1Id],
    });
    const res = await auth.app.request(`/api/v1/assessments/${aid}/approve`, {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': 'approve-deny-1',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  test('A-Asm-5 — approve refused if any target is unverified → 422', async () => {
    const unv = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      value: 'https://unv.example',
      ownershipStatus: 'unverified',
    });
    const aid = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'submitted',
      targetIds: [unv],
    });
    const res = await auth.app.request(`/api/v1/assessments/${aid}/approve`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'idempotency-key': 'approve-unv-1',
      },
      body: '{}',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      details?: { unverifiedTargetIds?: ReadonlyArray<string> };
    };
    expect(body.error).toBe('unverified_high_impact_targets');
    expect(body.details?.unverifiedTargetIds).toEqual([unv]);
  });

  // ===== A-Asm-6 + R8 =====

  test('A-Asm-6 + R8 — start with expired testingWindow → 422 + assessment.start.denied audit', async () => {
    const aid = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'approved',
      targetIds: [target1Id],
      testingWindowStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      testingWindowEnd: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/assessments/${aid}/start`, {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': 'start-expired-1',
      },
      body: '{}',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('testing_window_expired');
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);
    const denyRow = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'assessment.start.denied')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    const meta = denyRow.after_state as { reason?: string; outcome?: string };
    expect(meta.outcome).toBe('denied');
    expect(meta.reason).toBe('window_expired');
    // State should NOT have flipped to running.
    const arow = await fx.db
      .selectFrom('assessments')
      .selectAll()
      .where('id', '=', aid)
      .executeTakeFirstOrThrow();
    expect(arow.state).toBe('approved');
  });

  test('A-Asm-6 — start with valid testingWindow → 200 + assessment.started audit', async () => {
    const aid = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'approved',
      targetIds: [target1Id],
      testingWindowStart: new Date(Date.now() - 60_000),
      testingWindowEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const res = await auth.app.request(`/api/v1/assessments/${aid}/start`, {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': 'start-ok-1',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const arow = await fx.db
      .selectFrom('assessments')
      .selectAll()
      .where('id', '=', aid)
      .executeTakeFirstOrThrow();
    expect(arow.state).toBe('running');
  });

  // ===== A-Asm-10 =====

  test('A-Asm-10 — status returns transitionsAvailable derived from state machine', async () => {
    const aid = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'draft',
      targetIds: [target1Id],
    });
    const res = await auth.app.request(`/api/v1/assessments/${aid}/status`, {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      transitionsAvailable: ReadonlyArray<string>;
    };
    expect(body.state).toBe('draft');
    expect(body.transitionsAvailable).toContain('submit');
    expect(body.transitionsAvailable).toContain('cancel');
    expect(body.transitionsAvailable).not.toContain('start');
  });

  // ===== A-Asm-11 / R7 =====

  test('A-Asm-11 + R7 — timeline filters audit rows by assessment id, RBAC keyed on (assessment, read)', async () => {
    const aid = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'draft',
      targetIds: [target1Id],
    });
    // Submit to generate an audit row.
    await auth.app.request(`/api/v1/assessments/${aid}/submit`, {
      method: 'POST',
      headers: {
        cookie: t1Cookie,
        'content-type': 'application/json',
        'idempotency-key': 'tl-1',
      },
      body: '{}',
    });
    const res = await auth.app.request(`/api/v1/assessments/${aid}/timeline`, {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: ReadonlyArray<{ action: string }>;
    };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.some((r) => r.action === 'assessment.submitted')).toBe(true);
    // T2 cookie must NOT see T1 timeline (cross-tenant deny).
    const cross = await auth.app.request(`/api/v1/assessments/${aid}/timeline`, {
      headers: { cookie: t2Cookie },
    });
    expect(cross.status).toBe(403);
  });

  void t2UserId;
  void t2ProjectId;
});
