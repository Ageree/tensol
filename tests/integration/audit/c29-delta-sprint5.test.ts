// Sprint 5 A-Audit-1 — C29 delta=1 across the 16 NEW emission points.
//
// Sprint 4 enumerated 10 emission points (auth + deny pipeline). Sprint 5
// adds 16: 3 projects + 4 targets + 8 assessments success + 1 assessment.start.denied.
// Total cumulative: 26 enumerated entries. This file owns the new 16.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { assertExactlyOneAuditRow } from '@cyberstrike/audit';
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
  seedAssessment,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';

const countAction = async (fx: DbFixture, action: string): Promise<number> => {
  const row = await fx.db
    .selectFrom('audit_events')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('action', '=', action)
    .executeTakeFirstOrThrow();
  return Number(row.count);
};

const expectDelta1 = async (
  fx: DbFixture,
  before: number,
  predicate: { action: string; tenantId?: string; resourceId?: string },
): Promise<void> => {
  const after = await countAction(fx, predicate.action);
  expect(after - before).toBe(1);
  await assertExactlyOneAuditRow(fx.db, predicate);
};

describe.skipIf(!hasDatabaseUrl())(
  'audit :: C29 delta=1 across Sprint 5 emission points (A-Audit-1, 16 new)',
  () => {
    let fx: DbFixture;
    let auth: AuthFixture;

    let t1Cookie: string;
    let t1TenantId: string;
    let t1UserId: string;
    let adminCookie: string;
    let projectId: string;
    let targetVerifiedId: string;

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
        email: 't1@x',
        role: 'security_lead',
      });
      const ta = await seedLoggedInUser(auth, {
        tenantSlug: 't1',
        email: 'ta@x',
        role: 'tenant_admin',
      });
      t1Cookie = t1.cookieHeader;
      t1TenantId = t1.tenantId;
      t1UserId = t1.userId;
      adminCookie = ta.cookieHeader;
      projectId = await seedProject(fx, { tenantId: t1TenantId, name: 'P' });
      targetVerifiedId = await seedTarget(fx, {
        tenantId: t1TenantId,
        projectId,
        value: 'https://verified.example',
        ownershipStatus: 'verified',
      });
    });

    // ===== Projects (3) =====

    test('1. project.created — delta=1', async () => {
      const before = await countAction(fx, 'project.created');
      const res = await auth.app.request('/api/v1/projects', {
        method: 'POST',
        headers: { cookie: t1Cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `P-${Date.now()}` }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      await expectDelta1(fx, before, {
        action: 'project.created',
        tenantId: t1TenantId,
        resourceId: body.id,
      });
    });

    test('2. project.updated — delta=1', async () => {
      const proj = await seedProject(fx, { tenantId: t1TenantId, name: 'PU' });
      const get = await auth.app.request(`/api/v1/projects/${proj}`, {
        headers: { cookie: t1Cookie },
      });
      const body = (await get.json()) as { updatedAt: string };
      const ifMatch = String(Math.floor(new Date(body.updatedAt).getTime() / 1000));
      const before = await countAction(fx, 'project.updated');
      const res = await auth.app.request(`/api/v1/projects/${proj}`, {
        method: 'PATCH',
        headers: {
          cookie: t1Cookie,
          'content-type': 'application/json',
          'if-match': ifMatch,
        },
        body: JSON.stringify({ description: 'd' }),
      });
      expect(res.status).toBe(200);
      await expectDelta1(fx, before, {
        action: 'project.updated',
        tenantId: t1TenantId,
        resourceId: proj,
      });
    });

    test('3. project.archived — delta=1', async () => {
      const proj = await seedProject(fx, { tenantId: t1TenantId, name: 'PA' });
      const before = await countAction(fx, 'project.archived');
      const res = await auth.app.request(`/api/v1/projects/${proj}`, {
        method: 'DELETE',
        headers: { cookie: adminCookie },
      });
      expect(res.status).toBe(204);
      await expectDelta1(fx, before, {
        action: 'project.archived',
        tenantId: t1TenantId,
        resourceId: proj,
      });
    });

    // ===== Targets (4) =====

    test('4. target.created — delta=1', async () => {
      const before = await countAction(fx, 'target.created');
      const res = await auth.app.request(`/api/v1/projects/${projectId}/targets`, {
        method: 'POST',
        headers: { cookie: t1Cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'url', value: `https://t-${Date.now()}.example` }),
      });
      expect(res.status).toBe(201);
      const after = await countAction(fx, 'target.created');
      expect(after - before).toBe(1);
    });

    test('5. target.updated — delta=1', async () => {
      const tid = await seedTarget(fx, {
        tenantId: t1TenantId,
        projectId,
        value: 'https://up.example',
      });
      const get = await auth.app.request(`/api/v1/targets/${tid}`, {
        headers: { cookie: t1Cookie },
      });
      const body = (await get.json()) as { version: number };
      const before = await countAction(fx, 'target.updated');
      const res = await auth.app.request(`/api/v1/targets/${tid}`, {
        method: 'PATCH',
        headers: {
          cookie: t1Cookie,
          'content-type': 'application/json',
          'if-match': String(body.version),
        },
        body: JSON.stringify({ value: 'https://up2.example' }),
      });
      expect(res.status).toBe(200);
      await expectDelta1(fx, before, {
        action: 'target.updated',
        tenantId: t1TenantId,
        resourceId: tid,
      });
    });

    test('6. target.deleted — delta=1', async () => {
      const tid = await seedTarget(fx, {
        tenantId: t1TenantId,
        projectId,
        value: 'https://del.example',
      });
      const before = await countAction(fx, 'target.deleted');
      const res = await auth.app.request(`/api/v1/targets/${tid}`, {
        method: 'DELETE',
        headers: { cookie: adminCookie },
      });
      expect(res.status).toBe(204);
      await expectDelta1(fx, before, {
        action: 'target.deleted',
        tenantId: t1TenantId,
        resourceId: tid,
      });
    });

    test('7. target.ownership_proof.submitted — delta=1', async () => {
      const tid = await seedTarget(fx, {
        tenantId: t1TenantId,
        projectId,
        value: 'https://op.example',
      });
      const before = await countAction(fx, 'target.ownership_proof.submitted');
      const res = await auth.app.request(`/api/v1/targets/${tid}/ownership-proof`, {
        method: 'POST',
        headers: { cookie: t1Cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'dns_txt', evidence: 'verification=xyz' }),
      });
      expect(res.status).toBe(202);
      await expectDelta1(fx, before, {
        action: 'target.ownership_proof.submitted',
        tenantId: t1TenantId,
        resourceId: tid,
      });
    });

    // ===== Assessments success (8) =====

    test('8. assessment.created — delta=1', async () => {
      const before = await countAction(fx, 'assessment.created');
      const res = await auth.app.request(`/api/v1/projects/${projectId}/assessments`, {
        method: 'POST',
        headers: { cookie: t1Cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'A',
          testingWindow: null,
          highImpactCategories: [],
          targetIds: [targetVerifiedId],
          scopeRules: [{ ruleKind: 'allow', effect: 'allow', payload: {} }],
        }),
      });
      expect(res.status).toBe(201);
      const after = await countAction(fx, 'assessment.created');
      expect(after - before).toBe(1);
    });

    test('9. assessment.updated — delta=1', async () => {
      const aid = await seedAssessment(fx, {
        tenantId: t1TenantId,
        projectId,
        createdBy: t1UserId,
        state: 'draft',
        targetIds: [targetVerifiedId],
      });
      const get = await auth.app.request(`/api/v1/assessments/${aid}`, {
        headers: { cookie: t1Cookie },
      });
      const body = (await get.json()) as { version: number };
      const before = await countAction(fx, 'assessment.updated');
      const res = await auth.app.request(`/api/v1/assessments/${aid}`, {
        method: 'PATCH',
        headers: {
          cookie: t1Cookie,
          'content-type': 'application/json',
          'if-match': String(body.version),
        },
        body: JSON.stringify({ name: 'updated-name' }),
      });
      expect(res.status).toBe(200);
      await expectDelta1(fx, before, {
        action: 'assessment.updated',
        tenantId: t1TenantId,
        resourceId: aid,
      });
    });

    const transitionTest = (
      label: string,
      seedState: 'draft' | 'submitted' | 'approved' | 'running' | 'paused',
      command: 'submit' | 'approve' | 'start' | 'pause' | 'resume' | 'cancel',
      action: string,
      cookieKind: 't1' | 'admin' = 't1',
      windowOverride?: { start?: Date | null; end?: Date | null },
    ) =>
      test(`${label} — ${action} delta=1`, async () => {
        const aid = await seedAssessment(fx, {
          tenantId: t1TenantId,
          projectId,
          createdBy: t1UserId,
          state: seedState,
          targetIds: [targetVerifiedId],
          ...(seedState === 'approved' || command === 'start'
            ? {
                testingWindowStart: windowOverride?.start ?? new Date(Date.now() - 60_000),
                testingWindowEnd: windowOverride?.end ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
              }
            : {}),
        });
        const before = await countAction(fx, action);
        const res = await auth.app.request(`/api/v1/assessments/${aid}/${command}`, {
          method: 'POST',
          headers: {
            cookie: cookieKind === 'admin' ? adminCookie : t1Cookie,
            'content-type': 'application/json',
            'idempotency-key': `${command}-${aid}`,
          },
          body: '{}',
        });
        expect(res.status).toBe(200);
        await expectDelta1(fx, before, {
          action,
          tenantId: t1TenantId,
          resourceId: aid,
        });
      });

    transitionTest('10', 'draft', 'submit', 'assessment.submitted');
    transitionTest('11', 'submitted', 'approve', 'assessment.approved', 'admin');
    transitionTest('12', 'approved', 'start', 'assessment.started');
    transitionTest('13', 'running', 'pause', 'assessment.paused');
    transitionTest('14', 'paused', 'resume', 'assessment.resumed');
    transitionTest('15', 'draft', 'cancel', 'assessment.cancelled');

    // ===== Assessment deny (1) =====

    test('16. assessment.start.denied — delta=1 (R8 expired window)', async () => {
      const aid = await seedAssessment(fx, {
        tenantId: t1TenantId,
        projectId,
        createdBy: t1UserId,
        state: 'approved',
        targetIds: [targetVerifiedId],
        testingWindowStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        testingWindowEnd: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      });
      const before = await countAction(fx, 'assessment.start.denied');
      const res = await auth.app.request(`/api/v1/assessments/${aid}/start`, {
        method: 'POST',
        headers: {
          cookie: t1Cookie,
          'content-type': 'application/json',
          'idempotency-key': `start-denied-${aid}`,
        },
        body: '{}',
      });
      expect(res.status).toBe(422);
      await expectDelta1(fx, before, {
        action: 'assessment.start.denied',
        tenantId: t1TenantId,
        resourceId: aid,
      });
    });
  },
);
