// A-27-1..A-27-7 — scan findings endpoint + api-tokens integration tests.

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

describe.skipIf(!hasDatabaseUrl())(
  'integration :: scan findings + api-tokens (A-27-1..A-27-12)',
  () => {
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
    // A-27-6: GET /scans/:id/report.html with no ready report → 404
    // =========================================================================

    test('A-27-6 — GET /scans/:id/report.html with no ready report returns report_not_ready', async () => {
      const res = await auth.app.request(`/api/v1/scans/${t1ScanId}/report.html`, {
        headers: { cookie: t1Cookie },
      });
      // object storage is null in test env → 503, OR no ready report → 404
      expect([404, 503]).toContain(res.status);
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

    // =========================================================================
    // A-27-8: POST /auth/api-tokens — returns plaintext token
    // =========================================================================

    test('A-27-8 — POST /auth/api-tokens returns plaintext 64-char hex token', async () => {
      const res = await auth.app.request('/api/v1/auth/api-tokens', {
        method: 'POST',
        headers: { cookie: t1Cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'my-cli-token' }),
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as { token: string; id: string; name: string };
      expect(typeof data.token).toBe('string');
      expect(data.token).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(data.token)).toBe(true);
      expect(data.name).toBe('my-cli-token');

      // Verify DB stores sha256, not plaintext
      const row = await fx.db
        .selectFrom('api_tokens')
        .select(['token_hash'])
        .where('id', '=', data.id)
        .executeTakeFirstOrThrow();
      expect(row.token_hash).not.toBe(data.token);
      expect(row.token_hash).toHaveLength(64); // sha256 hex = 64 chars
    });

    // =========================================================================
    // A-27-9: GET /auth/api-tokens — no token_hash in response
    // =========================================================================

    test('A-27-9 — GET /auth/api-tokens lists tokens without token_hash', async () => {
      // Create a token first
      await auth.app.request('/api/v1/auth/api-tokens', {
        method: 'POST',
        headers: { cookie: t1Cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'test-token' }),
      });

      const res = await auth.app.request('/api/v1/auth/api-tokens', {
        headers: { cookie: t1Cookie },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { tokens: Array<Record<string, unknown>> };
      expect(data.tokens.length).toBeGreaterThanOrEqual(1);

      // token_hash must NOT be in any token row
      for (const t of data.tokens) {
        expect(t).not.toHaveProperty('token_hash');
        expect(t).toHaveProperty('id');
        expect(t).toHaveProperty('name');
        expect(t).toHaveProperty('created_at');
      }
    });

    // =========================================================================
    // A-27-10: DELETE /auth/api-tokens/:id — revoke token
    // =========================================================================

    test('A-27-10 — DELETE /auth/api-tokens/:id revokes token', async () => {
      const createRes = await auth.app.request('/api/v1/auth/api-tokens', {
        method: 'POST',
        headers: { cookie: t1Cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'to-revoke' }),
      });
      const created = (await createRes.json()) as { id: string };

      const delRes = await auth.app.request(`/api/v1/auth/api-tokens/${created.id}`, {
        method: 'DELETE',
        headers: { cookie: t1Cookie },
      });
      expect(delRes.status).toBe(200);

      // Token should no longer appear in list
      const listRes = await auth.app.request('/api/v1/auth/api-tokens', {
        headers: { cookie: t1Cookie },
      });
      const listData = (await listRes.json()) as { tokens: Array<{ id: string }> };
      const ids = listData.tokens.map((t) => t.id);
      expect(ids).not.toContain(created.id);
    });

    // =========================================================================
    // A-27-11: Cross-tenant DELETE → 404
    // =========================================================================

    test('A-27-11 — cross-tenant DELETE /auth/api-tokens/:id returns 404', async () => {
      const createRes = await auth.app.request('/api/v1/auth/api-tokens', {
        method: 'POST',
        headers: { cookie: t1Cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 't1-token' }),
      });
      const created = (await createRes.json()) as { id: string };

      // t2 tries to delete t1's token
      const delRes = await auth.app.request(`/api/v1/auth/api-tokens/${created.id}`, {
        method: 'DELETE',
        headers: { cookie: t2Cookie },
      });
      expect(delRes.status).toBe(404);
    });

    // =========================================================================
    // A-27-12: POST with invalid body → 400
    // =========================================================================

    test('A-27-12 — POST /auth/api-tokens with missing name returns 400', async () => {
      const res = await auth.app.request('/api/v1/auth/api-tokens', {
        method: 'POST',
        headers: { cookie: t1Cookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  },
);

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
