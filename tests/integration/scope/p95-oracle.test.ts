// Sprint 6 §5.6 A-SE-Route-4 — p95 latency oracle.
//
// Asserts p95 of 403 (cross-tenant) responses and p95 of 404 (nonexistent)
// responses are within 50ms of each other on the /scope/validate endpoint.
// Mirrors Sprint 5's tests/integration/idor/p95-oracle.test.ts pattern.
//
// Gated by hasDatabaseUrl() per R9 — no-DB CI run skips this suite.

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

const SAMPLES = 30;
const P95_THRESHOLD_MS = 50;

const percentile = (samples: number[], p: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
};

describe.skipIf(!hasDatabaseUrl())(
  'integration :: scope/validate p95 oracle (Sprint 6 A-SE-Route-4)',
  () => {
    let fx: DbFixture;
    let auth: AuthFixture;
    let t1Cookie: string;
    let t2AssessmentId: string;

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
        tenantSlug: `t1-p95-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        email: `t1-p95-${Date.now()}@example.com`,
        role: 'security_lead',
      });
      t1Cookie = t1.cookieHeader;
      const t2 = await seedLoggedInUser(auth, {
        tenantSlug: `t2-p95-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        email: `t2-p95-${Date.now()}@example.com`,
        role: 'security_lead',
      });
      const t2Project = await seedProject(fx, {
        tenantId: t2.tenantId,
        name: 'P-p95-T2',
      });
      const t2Target = await seedTarget(fx, {
        tenantId: t2.tenantId,
        projectId: t2Project,
        kind: 'url',
        value: 'https://t2.example.com/',
        ownershipStatus: 'verified',
      });
      t2AssessmentId = await seedAssessment(fx, {
        tenantId: t2.tenantId,
        projectId: t2Project,
        createdBy: t2.userId,
        state: 'approved',
        targetIds: [t2Target],
        scopeRules: [
          {
            ruleKind: 'domain',
            effect: 'allow',
            payload: { pattern: 't2.example.com', matchSubdomains: false },
          },
        ],
      });
    });

    test('p95(403) and p95(404) are within 50ms of each other', async () => {
      const NONEXISTENT = '00000000-0000-0000-0000-000000000000';
      const measure = async (path: string): Promise<number> => {
        const start = performance.now();
        await auth.app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: t1Cookie },
          body: JSON.stringify({
            action: { kind: 'http_request', url: 'https://example.com/' },
          }),
        });
        return performance.now() - start;
      };
      const fortyThrees: number[] = [];
      const fourOhFours: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        fortyThrees.push(await measure(`/api/v1/assessments/${t2AssessmentId}/scope/validate`));
        fourOhFours.push(await measure(`/api/v1/assessments/${NONEXISTENT}/scope/validate`));
      }
      const p95_403 = percentile(fortyThrees, 0.95);
      const p95_404 = percentile(fourOhFours, 0.95);
      const gap = Math.abs(p95_403 - p95_404);
      // Generous: existence-oracle test asserts the gap is bounded, not absolute
      // latency. Sprint 5 used the same 50ms threshold.
      expect(gap).toBeLessThan(P95_THRESHOLD_MS);
    });
  },
);
