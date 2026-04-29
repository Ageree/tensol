// Sprint 7 §5.5 A-Q-Api-1 — POST /assessments/:id/start outbox tx atomicity.

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
  seedAssessment,
  seedAssessmentApproval,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';

describe.skipIf(!hasDatabaseUrl())('queue :: POST /start outbox (A-Q-Api-1)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;

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
  });

  test('successful POST /start inserts assessment.start jobs row in same tx as state transition', async () => {
    const u = await seedLoggedInUser(auth, {
      tenantSlug: `t-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      email: `out-${Date.now()}@example.com`,
      role: 'security_lead',
    });
    const projectId = await seedProject(fx, { tenantId: u.tenantId, name: 'P' });
    const target = await seedTarget(fx, {
      tenantId: u.tenantId,
      projectId,
      kind: 'url',
      value: 'https://example.com/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId: u.tenantId,
      projectId,
      createdBy: u.userId,
      state: 'approved',
      approvedBy: u.userId,
      approvedAt: new Date(),
      targetIds: [target],
    });
    await seedAssessmentApproval(fx, {
      tenantId: u.tenantId,
      assessmentId,
      approvedBy: u.userId,
      targetCount: 1,
    });

    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/start`, {
      method: 'POST',
      headers: {
        Cookie: u.cookieHeader,
        'content-type': 'application/json',
        'idempotency-key': 'start-outbox-1',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    // Assert state transitioned.
    const ass = await fx.db
      .selectFrom('assessments')
      .select(['state'])
      .where('id', '=', assessmentId)
      .executeTakeFirstOrThrow();
    expect(ass.state).toBe('running');

    // Assert exactly one assessment.start jobs row inserted.
    const jobs = await fx.db
      .selectFrom('jobs')
      .selectAll()
      .where('tenant_id', '=', u.tenantId)
      .where('assessment_id', '=', assessmentId)
      .where('kind', '=', 'assessment.start')
      .execute();
    expect(jobs.length).toBe(1);
    const job = jobs[0];
    if (!job) throw new Error('expected job row');
    expect(job.status).toBe('pending');
    expect(job.attempt).toBe(0);
    expect(job.max_attempts).toBe(3);
    expect(typeof job.trace_id).toBe('string');
    expect((job.trace_id as string).length).toBeGreaterThan(0);

    // Payload should round-trip a JobEnvelope.
    const persisted = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    expect(persisted).toMatchObject({
      tenantId: u.tenantId,
      assessmentId,
      kind: 'assessment.start',
    });
  });

  test('GET /assessments/:id/jobs returns the row', async () => {
    const u = await seedLoggedInUser(auth, {
      tenantSlug: `t-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      email: `jobs-${Date.now()}@example.com`,
      role: 'security_lead',
    });
    const projectId = await seedProject(fx, { tenantId: u.tenantId, name: 'P' });
    const target = await seedTarget(fx, {
      tenantId: u.tenantId,
      projectId,
      kind: 'url',
      value: 'https://example.com/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId: u.tenantId,
      projectId,
      createdBy: u.userId,
      state: 'approved',
      approvedBy: u.userId,
      approvedAt: new Date(),
      targetIds: [target],
    });
    await seedAssessmentApproval(fx, {
      tenantId: u.tenantId,
      assessmentId,
      approvedBy: u.userId,
      targetCount: 1,
    });
    await auth.app.request(`/api/v1/assessments/${assessmentId}/start`, {
      method: 'POST',
      headers: {
        Cookie: u.cookieHeader,
        'content-type': 'application/json',
        'idempotency-key': 'start-jobs-1',
      },
      body: JSON.stringify({}),
    });

    const jobsRes = await auth.app.request(`/api/v1/assessments/${assessmentId}/jobs`, {
      method: 'GET',
      headers: { Cookie: u.cookieHeader },
    });
    expect(jobsRes.status).toBe(200);
    const body = (await jobsRes.json()) as { data: Array<{ kind: string; status: string }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.kind).toBe('assessment.start');
    expect(body.data[0]?.status).toBe('pending');
  });

  test('GET /jobs returns 404 for nonexistent assessment', async () => {
    const u = await seedLoggedInUser(auth, {
      tenantSlug: `t-jobs2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      email: `jobs2-${Date.now()}@example.com`,
      role: 'security_lead',
    });
    const res = await auth.app.request(`/api/v1/assessments/${crypto.randomUUID()}/jobs`, {
      method: 'GET',
      headers: { Cookie: u.cookieHeader },
    });
    expect(res.status).toBe(404);
  });

  // codex iter-3 P1 — concurrent-start outbox guard.
  test('concurrent POST /start with different idempotency-keys → ONE job, second returns 409', async () => {
    const u = await seedLoggedInUser(auth, {
      tenantSlug: `t-conc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      email: `conc-${Date.now()}@example.com`,
      role: 'security_lead',
    });
    const projectId = await seedProject(fx, { tenantId: u.tenantId, name: 'P' });
    const target = await seedTarget(fx, {
      tenantId: u.tenantId,
      projectId,
      kind: 'url',
      value: 'https://example.com/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId: u.tenantId,
      projectId,
      createdBy: u.userId,
      state: 'approved',
      approvedBy: u.userId,
      approvedAt: new Date(),
      targetIds: [target],
    });
    await seedAssessmentApproval(fx, {
      tenantId: u.tenantId,
      assessmentId,
      approvedBy: u.userId,
      targetCount: 1,
    });

    // Fire two POST /start requests in parallel with DIFFERENT idempotency
    // keys. Both should pass the version=N check on read; only one wins the
    // optimistic UPDATE. Without the P1 fix, both would insert jobs rows.
    const fire = (idemKey: string): Promise<Response> =>
      auth.app.request(`/api/v1/assessments/${assessmentId}/start`, {
        method: 'POST',
        headers: {
          Cookie: u.cookieHeader,
          'content-type': 'application/json',
          'idempotency-key': idemKey,
        },
        body: JSON.stringify({}),
      });
    const [r1, r2] = await Promise.all([fire('start-conc-A'), fire('start-conc-B')]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    // One winner (200), one loser (409).
    expect(statuses).toEqual([200, 409]);

    // Assert exactly ONE assessment.start job inserted.
    const jobs = await fx.db
      .selectFrom('jobs')
      .selectAll()
      .where('tenant_id', '=', u.tenantId)
      .where('assessment_id', '=', assessmentId)
      .where('kind', '=', 'assessment.start')
      .execute();
    expect(jobs.length).toBe(1);

    // Assert assessment is in 'running' state (winner committed).
    const ass = await fx.db
      .selectFrom('assessments')
      .select(['state'])
      .where('id', '=', assessmentId)
      .executeTakeFirstOrThrow();
    expect(ass.state).toBe('running');
  });
});
