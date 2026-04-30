// Sprint 17 — Timeline API integration tests (A-17-Timeline*).
//
// Coverage:
//   A-17-TimelineAPIAudit    — no kind param → body.rows present (S11 compat)
//   A-17-TimelineAPIKindAll  — ?kind=all → both body.items and body.rows keys
//   A-17-TimelineAPICursor   — seed 3 events → limit=2 → nextCursor → advance
//   A-17-TimelineAPIUnauth   — no cookie → 401

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { emitAudit } from '@cyberstrike/audit';
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

const skip = !hasDatabaseUrl();

describe.skipIf(skip)('integration :: timeline API (A-17-Timeline*)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;
  let tenantId: string;
  let cookie: string;
  let assessmentId: string;

  const uniqSlug = (base: string) =>
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
    const login = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1'),
      email: 'tl@example.com',
      role: 'security_lead',
    });
    tenantId = login.tenantId;
    cookie = login.cookieHeader;
    const projectId = await seedProject(fx, { tenantId, name: 'TL-Project' });
    const targetId = await seedTarget(fx, { tenantId, projectId, value: 'https://example.com' });
    assessmentId = await seedAssessment(fx, { tenantId, projectId, createdBy: login.userId });
    void targetId;
  });

  test('A-17-TimelineAPIAudit — no kind param → body.rows present (S11 compat)', async () => {
    // Seed one audit event for this assessment.
    await emitAudit(
      { db: fx.db },
      {
        tenantId,
        action: 'assessment.updated',
        outcome: 'success',
        actorType: 'user',
        actorId: '00000000-0000-4000-8000-000000000001',
        actorName: 'test',
        resourceType: 'assessment',
        resourceId: assessmentId,
        projectId: null,
        assessmentId,
        ip: null,
        userAgent: null,
        traceId: '0123456789abcdef0123456789abcdef',
        metadata: {},
      },
    );

    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/timeline`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.rows)).toBe(true);
    expect((body.rows as unknown[]).length).toBeGreaterThan(0);
    expect((body.rows as Array<{ action: string }>)[0]?.action).toBeDefined();
  });

  test('A-17-TimelineAPIKindAll — ?kind=all → both body.items and body.rows keys', async () => {
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/timeline?kind=all`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  test('A-17-TimelineAPICursor — limit=2 → nextCursor → advance', async () => {
    // Seed 3 audit events.
    for (let i = 0; i < 3; i++) {
      await emitAudit(
        { db: fx.db },
        {
          tenantId,
          action: 'assessment.updated',
          outcome: 'success',
          actorType: 'user',
          actorId: '00000000-0000-4000-8000-000000000001',
          actorName: 'test',
          resourceType: 'assessment',
          resourceId: assessmentId,
          projectId: null,
          assessmentId,
          ip: null,
          userAgent: null,
          traceId: `0123456789abcdef0123456789abcde${i}`,
          metadata: { seq: i },
        },
      );
    }

    const res1 = await auth.app.request(
      `/api/v1/assessments/${assessmentId}/timeline?kind=audit&limit=2`,
      { headers: { Cookie: cookie } },
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      rows: unknown[];
      items: unknown[];
      nextCursor: string | null;
    };
    expect(body1.nextCursor).not.toBeNull();

    const res2 = await auth.app.request(
      `/api/v1/assessments/${assessmentId}/timeline?kind=audit&limit=2&cursor=${encodeURIComponent(body1.nextCursor ?? '')}`,
      { headers: { Cookie: cookie } },
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { rows: unknown[]; items: unknown[] };
    expect((body2.rows as unknown[]).length).toBeGreaterThan(0);
  });

  test('A-17-TimelineAPIUnauth — no cookie → 401', async () => {
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/timeline`);
    expect(res.status).toBe(401);
  });
});
