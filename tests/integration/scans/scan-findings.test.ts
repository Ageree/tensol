// A-27-1..A-27-7 — scan findings endpoint integration tests.
// A-27-8..A-27-12 removed: api_tokens deferred to S28 (B-27-tokenuiS28).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Json } from '@cyberstrike/db';
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

describe.skipIf(!hasDatabaseUrl())('integration :: scan findings (A-27-1..A-27-7)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;
  let t1Cookie: string;
  let t1TenantId: string;
  let _t1UserId: string;
  let t2Cookie: string;
  let t1ProjectId: string;
  let t1ScanId: string;

  const uniqSlug = (base: string): string =>
    `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const launchScan = async (
    cookie: string,
    projectId: string,
    targetIds: string[],
    tier = 'light',
  ): Promise<string> => {
    const res = await auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'idempotency-key': `a27-scan-${Date.now()}-${Math.random()}`,
      },
      body: JSON.stringify({ project_id: projectId, tier, target_ids: targetIds }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { scan_id: string };
    return data.scan_id;
  };

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
    _t1UserId = t1.userId;
    t2Cookie = t2.cookieHeader;
    t1ProjectId = await seedProject(fx, { tenantId: t1TenantId, name: 'Test Project' });

    const targetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId: t1ProjectId,
      kind: 'domain',
      value: 'example.com',
      ownershipStatus: 'verified',
    });
    t1ScanId = await launchScan(t1Cookie, t1ProjectId, [targetId]);
  });

  // =========================================================================
  // A-27-1: GET /scans/:id/findings — empty scan returns empty array
  // =========================================================================

  test('A-27-1 — GET /scans/:id/findings returns empty findings for new scan', async () => {
    const res = await auth.app.request(`/api/v1/scans/${t1ScanId}/findings`, {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      findings: unknown[];
      total: number;
      page: number;
      limit: number;
    };
    expect(data.findings).toEqual([]);
    expect(data.total).toBe(0);
    expect(data.page).toBe(1);
    expect(data.limit).toBe(20);
  });

  // =========================================================================
  // A-27-2: Severity filter
  // =========================================================================

  test('A-27-2 — severity filter returns only matching findings', async () => {
    // Seed 2 findings directly: 1 high + 1 low
    const candidateHighId = await seedCandidateFinding(fx, t1TenantId, t1ScanId, 'xss', 'high');
    const candidateLowId = await seedCandidateFinding(fx, t1TenantId, t1ScanId, 'sqli', 'low');
    await seedFinding(fx, t1TenantId, t1ScanId, candidateHighId, 'xss', 'high');
    await seedFinding(fx, t1TenantId, t1ScanId, candidateLowId, 'sqli', 'low');

    const res = await auth.app.request(`/api/v1/scans/${t1ScanId}/findings?severity=high`, {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { findings: Array<{ severity: string }>; total: number };
    expect(data.total).toBe(1);
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]?.severity).toBe('high');
  });

  // =========================================================================
  // A-27-3: Kind/type filter
  // =========================================================================

  test('A-27-3 — kind filter returns only findings with matching type', async () => {
    const candXssId = await seedCandidateFinding(fx, t1TenantId, t1ScanId, 'xss', 'high');
    const candSqliId = await seedCandidateFinding(fx, t1TenantId, t1ScanId, 'sqli', 'medium');
    await seedFinding(fx, t1TenantId, t1ScanId, candXssId, 'xss', 'high');
    await seedFinding(fx, t1TenantId, t1ScanId, candSqliId, 'sqli', 'medium');

    const res = await auth.app.request(`/api/v1/scans/${t1ScanId}/findings?kind=xss`, {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { findings: Array<{ type: string }>; total: number };
    expect(data.total).toBe(1);
    expect(data.findings[0]?.type).toBe('xss');
  });

  // =========================================================================
  // A-27-4: Pagination
  // =========================================================================

  test('A-27-4 — pagination: page=1&limit=1 with 3 findings returns 1, total=3', async () => {
    for (let i = 0; i < 3; i++) {
      const candId = await seedCandidateFinding(fx, t1TenantId, t1ScanId, `xss${i}`, 'low');
      await seedFinding(fx, t1TenantId, t1ScanId, candId, `xss${i}`, 'low');
    }

    const res = await auth.app.request(`/api/v1/scans/${t1ScanId}/findings?page=1&limit=1`, {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      findings: unknown[];
      total: number;
      page: number;
      limit: number;
    };
    expect(data.total).toBe(3);
    expect(data.findings).toHaveLength(1);
    expect(data.page).toBe(1);
    expect(data.limit).toBe(1);
  });

  // =========================================================================
  // A-27-5: Cross-tenant 404 (closes B-26-progress-leak-test)
  // =========================================================================

  test('A-27-5 — cross-tenant GET /scans/:id/findings returns 404', async () => {
    // t2 tries to read t1's scan findings
    const res = await auth.app.request(`/api/v1/scans/${t1ScanId}/findings`, {
      headers: { cookie: t2Cookie },
    });
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('not_found');
  });

  // =========================================================================
  // A-27-6: GET /scans/:id/report/html with no ready report → 409
  // =========================================================================

  test('A-27-6 — GET /scans/:id/report/html with no ready report returns 409 report_not_ready', async () => {
    const res = await auth.app.request(`/api/v1/scans/${t1ScanId}/report/html`, {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('report_not_ready');
  });

  // =========================================================================
  // A-27-7: Bad UUID → 404
  // =========================================================================

  test('A-27-7 — GET /scans/not-uuid/findings returns 404', async () => {
    const res = await auth.app.request('/api/v1/scans/not-a-uuid/findings', {
      headers: { cookie: t1Cookie },
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Helpers — seed candidate_findings + findings directly in DB
// ===========================================================================

const seedCandidateFinding = async (
  fx: DbFixture,
  tenantId: string,
  assessmentId: string,
  type: string,
  severity: string,
): Promise<string> => {
  const row = await fx.db
    .insertInto('candidate_findings')
    .values({
      tenant_id: tenantId,
      assessment_id: assessmentId,
      type,
      severity,
      affected_url: `https://example.com/${type}`,
      source: 'test',
      payload: JSON.stringify({ test: true }) as unknown as Json,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

const seedFinding = async (
  fx: DbFixture,
  tenantId: string,
  assessmentId: string,
  candidateId: string,
  type: string,
  severity: string,
): Promise<string> => {
  const row = await fx.db
    .insertInto('findings')
    .values({
      tenant_id: tenantId,
      assessment_id: assessmentId,
      created_from_candidate_id: candidateId,
      type,
      severity,
      confidence: 'high',
      status: 'open',
      affected_url: `https://example.com/${type}`,
      reproduction: JSON.stringify({ steps: [] }) as unknown as Json,
      validator_log: JSON.stringify({ decision: 'confirmed' }) as unknown as Json,
      validated_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};
