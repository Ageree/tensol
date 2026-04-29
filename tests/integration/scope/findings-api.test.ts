// Sprint 11 — findings + evidence API IT (A-UI-Visibility, A-UI-StatusAudit,
// A-UI-CrossTenantArtifact).
//
// Covers:
//   A-UI-Visibility: confirmed finding visible for owning tenant; NOT visible from T2 session.
//   A-UI-StatusAudit: PATCH /findings/:id/status emits finding.status_changed audit.
//   A-UI-CrossTenantArtifact: GET /evidence/:id from T2 → 403 + rbac.deny audit.
//   A-UI-FixtureReset: resetAuthState in beforeEach (P27).

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
} from '../db/helpers/db-fixture.ts';

const uniqSlug = (base: string) =>
  `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!hasDatabaseUrl())('integration :: findings + evidence API (Sprint 11)', () => {
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

  // P27 invariant: resetAuthState in beforeEach
  beforeEach(async () => {
    await resetAuthState(fx.db);
  });

  // Helper: seed a confirmed finding in a given tenant/assessment
  const seedFinding = async (tenantId: string, assessmentId: string, candidateId: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary.
    const reproJson = JSON.stringify({ steps: ['nav', 'inject'], nonce: 'a'.repeat(32) }) as any;
    // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary.
    const logJson = JSON.stringify([{ run: 1 }]) as any;
    const row = await fx.db
      .insertInto('findings')
      .values({
        tenant_id: tenantId,
        assessment_id: assessmentId,
        created_from_candidate_id: candidateId,
        type: 'xss_reflected',
        severity: 'high',
        confidence: 'high',
        status: 'open',
        affected_url: 'http://example.com/search',
        reproduction: reproJson,
        validator_log: logJson,
        validated_at: new Date(),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    return String(row.id);
  };

  const seedCandidate = async (tenantId: string, assessmentId: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary.
    const payloadJson = JSON.stringify({ sample: 1 }) as any;
    const row = await fx.db
      .insertInto('candidate_findings')
      .values({
        tenant_id: tenantId,
        assessment_id: assessmentId,
        type: 'xss_reflected',
        severity: 'high',
        affected_url: 'http://example.com/search',
        source: 'fake-decepticon',
        payload: payloadJson,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    return String(row.id);
  };

  const seedEvidence = async (tenantId: string, findingId: string) => {
    const { sql } = await import('kysely');
    await sql.raw('ALTER TABLE finding_evidence DISABLE TRIGGER USER').execute(fx.db);
    const row = await fx.db
      .insertInto('finding_evidence')
      .values({
        tenant_id: tenantId,
        finding_id: findingId,
        kind: 'screenshot',
        object_storage_key: `evidence/${findingId}/screenshot`,
        sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
        size_bytes: '1024',
        // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary.
        metadata: JSON.stringify({}) as any,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await sql.raw('ALTER TABLE finding_evidence ENABLE TRIGGER USER').execute(fx.db);
    return String(row.id);
  };

  test('A-UI-Visibility: confirmed finding visible for owning tenant', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1'),
      email: 'sl@t1.com',
      role: 'security_lead',
    });
    const projectId = await seedProject(fx as DbFixture, {
      tenantId: t1.tenantId,
      name: 'P1',
    });
    const assessmentId = await seedAssessment(fx as DbFixture, {
      tenantId: t1.tenantId,
      projectId,
      createdBy: t1.userId,
    });
    const candidateId = await seedCandidate(t1.tenantId, assessmentId);
    const findingId = await seedFinding(t1.tenantId, assessmentId, candidateId);

    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/findings`, {
      headers: { Cookie: t1.cookieHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].id).toBe(findingId);
  });

  test('A-UI-Visibility: finding NOT visible from second tenant session', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1'),
      email: 'sl@t1vis.com',
      role: 'security_lead',
    });
    const t2 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t2'),
      email: 'sl@t2vis.com',
      role: 'security_lead',
    });
    const projectId = await seedProject(fx as DbFixture, {
      tenantId: t1.tenantId,
      name: 'P1',
    });
    const assessmentId = await seedAssessment(fx as DbFixture, {
      tenantId: t1.tenantId,
      projectId,
      createdBy: t1.userId,
    });
    const candidateId = await seedCandidate(t1.tenantId, assessmentId);
    await seedFinding(t1.tenantId, assessmentId, candidateId);

    // T2 gets empty list — tenant-scoped query returns no rows.
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/findings`, {
      headers: { Cookie: t2.cookieHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.findings).toHaveLength(0);
  });

  test('A-UI-StatusAudit: PATCH status emits finding.status_changed audit', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1'),
      email: 'sl@t1audit.com',
      role: 'security_lead',
    });
    const projectId = await seedProject(fx as DbFixture, {
      tenantId: t1.tenantId,
      name: 'P1',
    });
    const assessmentId = await seedAssessment(fx as DbFixture, {
      tenantId: t1.tenantId,
      projectId,
      createdBy: t1.userId,
    });
    const candidateId = await seedCandidate(t1.tenantId, assessmentId);
    const findingId = await seedFinding(t1.tenantId, assessmentId, candidateId);

    const before = await countAuditEvents(fx.db);

    const res = await auth.app.request(`/api/v1/findings/${findingId}/status`, {
      method: 'PATCH',
      headers: { Cookie: t1.cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'triaged' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.finding.status).toBe('triaged');

    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);

    const auditRow = await fx.db
      .selectFrom('audit_events')
      .select(['action', 'resource_id'])
      .where('action', '=', 'finding.status_changed')
      .where('resource_id', '=', findingId)
      .executeTakeFirst();
    expect(auditRow).toBeTruthy();
    expect(auditRow?.action).toBe('finding.status_changed');
  });

  test('A-UI-CrossTenantArtifact: GET /evidence/:id from T2 → 403 + audit', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1'),
      email: 'sl@t1ct.com',
      role: 'security_lead',
    });
    const t2 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t2'),
      email: 'sl@t2ct.com',
      role: 'security_lead',
    });
    const projectId = await seedProject(fx as DbFixture, {
      tenantId: t1.tenantId,
      name: 'P1',
    });
    const assessmentId = await seedAssessment(fx as DbFixture, {
      tenantId: t1.tenantId,
      projectId,
      createdBy: t1.userId,
    });
    const candidateId = await seedCandidate(t1.tenantId, assessmentId);
    const findingId = await seedFinding(t1.tenantId, assessmentId, candidateId);
    const evidenceId = await seedEvidence(t1.tenantId, findingId);

    const before = await countAuditEvents(fx.db);

    const res = await auth.app.request(`/api/v1/evidence/${evidenceId}`, {
      headers: { Cookie: t2.cookieHeader },
    });
    expect(res.status).toBe(403);

    const after = await countAuditEvents(fx.db);
    expect(after).toBeGreaterThan(before);

    const denyRow = await fx.db
      .selectFrom('audit_events')
      .select(['action', 'resource_id'])
      .where('action', '=', 'rbac.deny')
      .where('resource_id', '=', evidenceId)
      .executeTakeFirst();
    expect(denyRow).toBeTruthy();
  });

  test('GET /findings/:id returns 404 for cross-tenant finding id', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1'),
      email: 'sl@t1find.com',
      role: 'security_lead',
    });
    const t2 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t2'),
      email: 'sl@t2find.com',
      role: 'security_lead',
    });
    const projectId = await seedProject(fx as DbFixture, {
      tenantId: t1.tenantId,
      name: 'P1',
    });
    const assessmentId = await seedAssessment(fx as DbFixture, {
      tenantId: t1.tenantId,
      projectId,
      createdBy: t1.userId,
    });
    const candidateId = await seedCandidate(t1.tenantId, assessmentId);
    const findingId = await seedFinding(t1.tenantId, assessmentId, candidateId);

    const res = await auth.app.request(`/api/v1/findings/${findingId}`, {
      headers: { Cookie: t2.cookieHeader },
    });
    expect(res.status).toBe(404);
  });

  test('PATCH /findings/:id/status — auditor cannot change status (403)', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1'),
      email: 'sl@t1slead.com',
      role: 'security_lead',
    });
    const auditor = await seedExtraLoggedInUser(auth, {
      tenantId: t1.tenantId,
      email: 'auditor@t1.com',
      role: 'auditor',
    });
    const projectId = await seedProject(fx as DbFixture, {
      tenantId: t1.tenantId,
      name: 'P1',
    });
    const assessmentId = await seedAssessment(fx as DbFixture, {
      tenantId: t1.tenantId,
      projectId,
      createdBy: t1.userId,
    });
    const candidateId = await seedCandidate(t1.tenantId, assessmentId);
    const findingId = await seedFinding(t1.tenantId, assessmentId, candidateId);

    const res = await auth.app.request(`/api/v1/findings/${findingId}/status`, {
      method: 'PATCH',
      headers: { Cookie: auditor.cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'triaged' }),
    });
    expect(res.status).toBe(403);
  });
});
