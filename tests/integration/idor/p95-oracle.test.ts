// Sprint 5 A-IDOR-2 / R9 — p95 latency-flatten oracle test.
//
// Mirrors the Sprint 3 C26 password-reset oracle pattern. For each nested
// route family (projects, targets, assessments), measure end-to-end latency
// of:
//   - 403 cross-tenant
//   - 404 nonexistent
// over N≥30 samples each on a fresh DB. Assert p95(403) and p95(404) are
// within 50ms of each other. A wider gap signals tenant-lookup-before-existence
// (or vice versa) leakage path that an attacker could time-attack.

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
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';

const N_SAMPLES = 30;
const P95_GAP_MS = 50;

const p95 = (samples: ReadonlyArray<number>): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx] ?? 0;
};

const measure = async (req: () => Promise<Response>): Promise<number> => {
  const t0 = performance.now();
  const res = await req();
  // Drain body to ensure we measure end-to-end, not just headers.
  await res.text();
  return performance.now() - t0;
};

describe.skipIf(!hasDatabaseUrl())('integration :: p95 oracle gap ≤ 50ms (A-IDOR-2 / R9)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;

  let t1Cookie: string;
  let t1TenantId: string;
  let t1UserId: string;
  let t2TenantId: string;

  let t1Project: string;
  let t1Target: string;
  let t2Project: string;
  let t2Target: string;
  let t2Assessment: string;

  const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

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
    const t2 = await seedLoggedInUser(auth, {
      tenantSlug: 't2',
      email: 't2@x',
      role: 'security_lead',
    });
    t1Cookie = t1.cookieHeader;
    t1TenantId = t1.tenantId;
    t1UserId = t1.userId;
    t2TenantId = t2.tenantId;

    t1Project = await seedProject(fx, { tenantId: t1TenantId, name: 'P1' });
    t1Target = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1Project,
      value: 'https://t1.example',
    });
    await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId: t1Project,
      createdBy: t1UserId,
      targetIds: [t1Target],
    });

    t2Project = await seedProject(fx, { tenantId: t2TenantId, name: 'P2' });
    t2Target = await seedTarget(fx, {
      tenantId: t2TenantId,
      projectId: t2Project,
      value: 'https://t2.example',
    });
    t2Assessment = await seedAssessment(fx, {
      tenantId: t2TenantId,
      projectId: t2Project,
      createdBy: t1UserId, // FK to a user in T1; OK for the timing test.
      targetIds: [t2Target],
    });
  });

  const oracleCheck = async (
    crossPath: string,
    nonexistentPath: string,
  ): Promise<{ p95Cross: number; p95Nf: number }> => {
    const cross: number[] = [];
    const nf: number[] = [];
    // Warm-up rounds — Hono+Kysely first-request cost would skew results.
    for (let i = 0; i < 5; i += 1) {
      await auth.app.request(crossPath, { headers: { cookie: t1Cookie } });
      await auth.app.request(nonexistentPath, { headers: { cookie: t1Cookie } });
    }
    for (let i = 0; i < N_SAMPLES; i += 1) {
      cross.push(
        await measure(() => auth.app.request(crossPath, { headers: { cookie: t1Cookie } })),
      );
      nf.push(
        await measure(() => auth.app.request(nonexistentPath, { headers: { cookie: t1Cookie } })),
      );
    }
    return { p95Cross: p95(cross), p95Nf: p95(nf) };
  };

  test('projects: p95(403) vs p95(404) within 50ms', async () => {
    const { p95Cross, p95Nf } = await oracleCheck(
      `/api/v1/projects/${t2Project}`,
      `/api/v1/projects/${NONEXISTENT}`,
    );
    expect(Math.abs(p95Cross - p95Nf)).toBeLessThanOrEqual(P95_GAP_MS);
  });

  test('targets: p95(403) vs p95(404) within 50ms', async () => {
    const { p95Cross, p95Nf } = await oracleCheck(
      `/api/v1/targets/${t2Target}`,
      `/api/v1/targets/${NONEXISTENT}`,
    );
    expect(Math.abs(p95Cross - p95Nf)).toBeLessThanOrEqual(P95_GAP_MS);
  });

  test('assessments: p95(403) vs p95(404) within 50ms', async () => {
    const { p95Cross, p95Nf } = await oracleCheck(
      `/api/v1/assessments/${t2Assessment}`,
      `/api/v1/assessments/${NONEXISTENT}`,
    );
    expect(Math.abs(p95Cross - p95Nf)).toBeLessThanOrEqual(P95_GAP_MS);
  });
});
