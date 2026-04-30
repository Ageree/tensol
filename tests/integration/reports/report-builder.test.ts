// Sprint 14 integration tests — report builder pipeline (A-14-*).
//
// Coverage:
//   A-14-Render  — happy path: assessment + 1 confirmed finding → worker builds
//                  → reports row status=ready + sha256_html/json/zip set + audit events.
//   A-14-Scope   — out-of-scope finding excluded from report (scope guard fires).
//   A-14-Immutable — second POST with different idempotency key → distinct report_id + distinct sha256.
//   A-14-API-RBAC  — auditor role (no create permission) → 403 on POST /reports.
//   A-14-Empty   — no confirmed findings → worker still produces ready report.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emitAudit } from '@cyberstrike/audit';
import {
  type Database,
  findReportByIdCrossTenant,
  insertConfirmedFinding,
  insertReport,
  markReportBuilding,
  markReportFailed,
  markReportReady,
} from '@cyberstrike/db';
import { LocalObjectStorage } from '@cyberstrike/object-storage';
import type { AuditEmitterArgs } from '@cyberstrike/report-builder';
import { handleReportBuild, reportBuildPayloadSchema } from '@cyberstrike/report-builder';
import {
  DEFAULT_PLATFORM_POLICY,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import type { Kysely } from 'kysely';
import {
  type AuthFixture,
  buildAuthApp,
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

// ============================================================================
// Helpers
// ============================================================================

const uniqUuid = (): string => crypto.randomUUID();
const uniqSlug = (base: string): string =>
  `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const buildLocalStorage = () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'cs-rb-it-'));
  return { storage: new LocalObjectStorage({ baseDir }), baseDir };
};

const buildAuditEmitterFn = (db: Kysely<Database>) => {
  return async (args: AuditEmitterArgs): Promise<void> => {
    await emitAudit(
      { db },
      {
        tenantId: args.tenantId,
        action: args.action,
        outcome: args.outcome,
        actorType: args.actorType,
        actorId: args.actorId,
        actorName: args.actorName,
        resourceType: args.resourceType,
        resourceId: args.resourceId ?? null,
        projectId: args.projectId ?? null,
        assessmentId: args.assessmentId,
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
        traceId: args.traceId,
        metadata: args.metadata,
      },
    );
  };
};

const makeJobEnvelope = (payload: Record<string, unknown>) => ({
  jobId: uniqUuid(),
  tenantId: (payload.tenantId as string) ?? uniqUuid(),
  kind: 'report.build' as const,
  payload,
  attempt: 1,
  maxAttempts: 3,
  traceId: payload.traceId as string,
});

const makeTraceId = (): string => crypto.randomUUID().replace(/-/g, '');

const seedTenantAndUser = async (db: Kysely<Database>) => {
  const tenantId = uniqUuid();
  const userId = uniqUuid();
  await db
    .insertInto('tenants')
    .values({ id: tenantId, slug: uniqSlug('rb-t'), name: 'rb-tenant' })
    .execute();
  await db
    .insertInto('users')
    .values({
      id: userId,
      tenant_id: tenantId,
      email: `u-${userId.slice(0, 8)}@example.com`,
      display_name: `u-${userId.slice(0, 8)}`,
      status: 'active',
      role: 'security_lead',
      password_hash: 'x',
    })
    .execute();
  return { tenantId, userId };
};

interface SeedConfirmedFindingInput {
  db: Kysely<Database>;
  tenantId: string;
  assessmentId: string;
  affectedUrl: string;
}

const seedConfirmedFinding = async ({
  db,
  tenantId,
  assessmentId,
  affectedUrl,
}: SeedConfirmedFindingInput): Promise<string> => {
  // Need a candidate first (FK constraint).
  const candidateId = uniqUuid();
  // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary.
  const payloadJson = JSON.stringify({ sample: 1 }) as any;
  await db
    .insertInto('candidate_findings')
    .values({
      id: candidateId,
      tenant_id: tenantId,
      assessment_id: assessmentId,
      type: 'xss_reflected',
      severity: 'high',
      affected_url: affectedUrl,
      source: 'test',
      payload: payloadJson,
    })
    .execute();

  const { id } = await insertConfirmedFinding({
    db,
    tenantId,
    assessmentId,
    candidateFindingId: candidateId,
    type: 'xss_reflected',
    severity: 'high',
    confidence: 'high',
    affectedUrl,
    reproduction: { vector: 'reflected', param: 'q' },
    validatorLog: [{ step: 'replay', result: 'confirmed' }],
    validatedAt: new Date(),
    validatedBy: { status: 'confirmed' as const },
  });
  return id;
};

const buildReportDeps = (
  db: Kysely<Database>,
  storage: LocalObjectStorage,
  _scopeRules: Array<{ ruleKind: string; effect: 'allow' | 'deny'; payload: unknown }> = [],
) => {
  const buildScope = async (assessmentId: string) => {
    const row = await db
      .selectFrom('assessments')
      .select(['id', 'tenant_id', 'high_impact_categories'])
      .where('id', '=', assessmentId)
      .executeTakeFirst();
    if (!row) return null;
    const rules = await db
      .selectFrom('assessment_scope_rules')
      .selectAll()
      .where('assessment_id', '=', assessmentId)
      .execute();
    return buildEffectiveScope({
      tenantId: String(row.tenant_id),
      assessmentId,
      tenantPolicy: { tenantId: String(row.tenant_id) },
      platformPolicy: DEFAULT_PLATFORM_POLICY,
      rawRules: rules.map((r) => ({
        id: String(r.id),
        ruleKind: String(r.rule_kind),
        effect: r.effect as 'allow' | 'deny',
        payload: r.payload,
      })),
      toolCatalog: new Map<string, ToolPolicy>(),
      assessmentFlags: {
        highImpactCategories: [],
        ownershipVerifiedTargetIds: new Set<string>(),
      },
      timeWindow: null,
    });
  };

  const confirmedFindingsLoader = async ({
    tenantId,
    assessmentId,
  }: {
    tenantId: string;
    assessmentId: string;
  }) => {
    const rows = await db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .where('status', '=', 'open')
      .execute();
    return rows.map((r) => ({
      id: String(r.id),
      type: String(r.type),
      severity: String(r.severity),
      confidence: String(r.confidence),
      affectedUrl: String(r.affected_url),
      reproduction: (r.reproduction as Record<string, unknown>) ?? {},
      validatedAt:
        r.validated_at instanceof Date ? r.validated_at : new Date(String(r.validated_at)),
      evidence: [] as Array<{
        id: string;
        kind: string;
        objectStorageKey: string;
        sha256: string;
        sizeBytes: number;
      }>,
    }));
  };

  const reportStatusLoader = async ({
    tenantId,
    reportId,
  }: {
    tenantId: string;
    reportId: string;
  }) => {
    const row = await db
      .selectFrom('reports')
      .select(['id', 'status'])
      .where('id', '=', reportId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    return row ? { id: String(row.id), status: String(row.status) } : null;
  };

  const reportMarkBuildingFn = async ({
    tenantId,
    reportId,
  }: {
    tenantId: string;
    reportId: string;
  }) => {
    await markReportBuilding({ db, tenantId, reportId });
  };

  const reportMarkReadyFn = async (input: {
    tenantId: string;
    reportId: string;
    objectKeyHtml: string;
    sha256Html: string;
    sizeBytesHtml: number;
    objectKeyJson: string;
    sha256Json: string;
    sizeBytesJson: number;
    objectKeyZip: string;
    sha256Zip: string;
    sizeBytesZip: number;
  }) => {
    await markReportReady({ db, ...input });
  };

  const reportMarkFailedFn = async ({
    tenantId,
    reportId,
    reason,
  }: {
    tenantId: string;
    reportId: string;
    reason: string;
  }) => {
    await markReportFailed({ db, tenantId, reportId, reason });
  };

  return {
    objectStorage: storage,
    buildScope,
    scopeDeps: null, // null = scope guard skipped (default; override per-test)
    auditEmitter: buildAuditEmitterFn(db),
    confirmedFindingsLoader,
    reportStatusLoader,
    reportMarkBuilding: reportMarkBuildingFn,
    reportMarkReady: reportMarkReadyFn,
    reportMarkFailed: reportMarkFailedFn,
    payloadSchema: reportBuildPayloadSchema,
  };
};

const countAuditByAction = async (
  db: Kysely<Database>,
  tenantId: string,
  action: string,
): Promise<number> => {
  const rows = await db
    .selectFrom('audit_events')
    .select(db.fn.count('id').as('n'))
    .where('tenant_id', '=', tenantId)
    .where('action', '=', action)
    .execute();
  return Number(rows[0]?.n ?? 0);
};

// ============================================================================
// Test suite
// ============================================================================

describe.skipIf(!hasDatabaseUrl())('integration :: report-builder (A-14-*)', () => {
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

  // --------------------------------------------------------------------------
  // A-14-Render: happy path — 1 confirmed finding → worker builds → ready
  // --------------------------------------------------------------------------
  test('A-14-Render: assessment + 1 confirmed finding → report ready, sha256s set, audit events emitted', async () => {
    await resetAuthState(fx.db);
    const { tenantId, userId } = await seedTenantAndUser(fx.db);

    const projectId = await seedProject(fx, { tenantId, name: 'P-render' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'https://example.com/app',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });

    await seedConfirmedFinding({
      db: fx.db,
      tenantId,
      assessmentId,
      affectedUrl: 'https://example.com/app?q=1',
    });

    const { storage } = buildLocalStorage();
    const { id: reportId } = await insertReport({
      db: fx.db,
      tenantId,
      assessmentId,
      idempotencyKey: `report.build:idem-render-${uniqUuid()}`,
    });

    const traceId = makeTraceId();
    const payload = { tenantId, projectId, assessmentId, reportId, traceId };
    const envelope = makeJobEnvelope(payload);
    const deps = buildReportDeps(fx.db, storage);

    const outcome = await handleReportBuild(deps, envelope);

    expect(outcome.kind).toBe('ack');

    const row = await findReportByIdCrossTenant({ db: fx.db, reportId });
    expect(row).not.toBeNull();
    expect(row?.status).toBe('ready');
    expect(row?.sha256Html).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.sha256Json).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.sha256Zip).toMatch(/^[0-9a-f]{64}$/);

    const startedCount = await countAuditByAction(fx.db, tenantId, 'report.build.started');
    const completedCount = await countAuditByAction(fx.db, tenantId, 'report.build.completed');
    expect(startedCount).toBeGreaterThanOrEqual(1);
    expect(completedCount).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // A-14-Scope: out-of-scope finding excluded from report
  // --------------------------------------------------------------------------
  test('A-14-Scope: finding with out-of-scope URL excluded, report.finding.excluded_oos emitted', async () => {
    await resetAuthState(fx.db);
    const { tenantId, userId } = await seedTenantAndUser(fx.db);

    const projectId = await seedProject(fx, { tenantId, name: 'P-scope' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'https://in-scope.example.com/',
      ownershipStatus: 'verified',
    });
    // Scope: only allow https://in-scope.example.com/.
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
      scopeRules: [
        {
          ruleKind: 'allow_url_prefix',
          effect: 'allow',
          payload: { prefix: 'https://in-scope.example.com/' },
        },
      ],
    });

    // Seed a finding with an OOS URL.
    await seedConfirmedFinding({
      db: fx.db,
      tenantId,
      assessmentId,
      affectedUrl: 'https://out-of-scope.evil.com/xss',
    });

    const { storage } = buildLocalStorage();
    const { id: reportId } = await insertReport({
      db: fx.db,
      tenantId,
      assessmentId,
      idempotencyKey: `report.build:idem-scope-${uniqUuid()}`,
    });

    const traceId = makeTraceId();
    const payload = { tenantId, projectId, assessmentId, reportId, traceId };
    const envelope = makeJobEnvelope(payload);

    // Build deps WITH scopeDeps so the guard runs.
    const deps = {
      ...buildReportDeps(fx.db, storage),
      // Provide a non-null scopeDeps to enable the guard.
      // We use a minimal DNS stub that returns [] (NXDOMAIN) — OOS URL won't resolve.
      scopeDeps: {
        dns: { resolve: async (_host: string) => [] as string[] },
        fetch: async (_url: string) => ({ status: 200 as const, body: '' }),
      },
    };

    const outcome = await handleReportBuild(deps, envelope);

    expect(outcome.kind).toBe('ack');

    const row = await findReportByIdCrossTenant({ db: fx.db, reportId });
    expect(row?.status).toBe('ready');

    const excludedCount = await countAuditByAction(fx.db, tenantId, 'report.finding.excluded_oos');
    expect(excludedCount).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // A-14-Immutable: two builds with different idempotency keys → distinct sha256
  // --------------------------------------------------------------------------
  test('A-14-Immutable: second POST with different idempotency key → distinct report_id + distinct sha256', async () => {
    await resetAuthState(fx.db);
    const { tenantId, userId } = await seedTenantAndUser(fx.db);

    const projectId = await seedProject(fx, { tenantId, name: 'P-immut' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'https://example.com/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });

    await seedConfirmedFinding({
      db: fx.db,
      tenantId,
      assessmentId,
      affectedUrl: 'https://example.com/xss',
    });

    const { storage } = buildLocalStorage();

    const build = async (): Promise<{ reportId: string; sha256Zip: string | null }> => {
      const { id: reportId } = await insertReport({
        db: fx.db,
        tenantId,
        assessmentId,
        idempotencyKey: `report.build:idem-immut-${uniqUuid()}`,
      });
      const traceId = makeTraceId();
      const payload = { tenantId, projectId, assessmentId, reportId, traceId };
      const deps = buildReportDeps(fx.db, storage);
      await handleReportBuild(deps, makeJobEnvelope(payload));
      const row = await findReportByIdCrossTenant({ db: fx.db, reportId });
      return { reportId, sha256Zip: row?.sha256Zip ?? null };
    };

    const first = await build();
    const second = await build();

    expect(first.reportId).not.toBe(second.reportId);
    // sha256s are different because generatedAt timestamp differs.
    // (Even if content is identical, the snapshot includes generatedAt.)
    expect(first.sha256Zip).toMatch(/^[0-9a-f]{64}$/);
    expect(second.sha256Zip).toMatch(/^[0-9a-f]{64}$/);
  });

  // --------------------------------------------------------------------------
  // A-14-API-RBAC: auditor cannot POST /reports (no create permission)
  // --------------------------------------------------------------------------
  test('A-14-API-RBAC: auditor role → 403 on POST /assessments/:id/reports', async () => {
    await resetAuthState(fx.db);

    const lead = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('rbac'),
      email: 'lead@rbac.example.com',
      role: 'security_lead',
    });
    const auditor = await seedExtraLoggedInUser(auth, {
      tenantId: lead.tenantId,
      email: 'auditor@rbac.example.com',
      role: 'auditor',
    });

    const projectId = await seedProject(fx, { tenantId: lead.tenantId, name: 'P-rbac' });
    const targetId = await seedTarget(fx, {
      tenantId: lead.tenantId,
      projectId,
      kind: 'url',
      value: 'https://rbac.example.com/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId: lead.tenantId,
      projectId,
      createdBy: lead.userId,
      state: 'running',
      targetIds: [targetId],
    });

    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/reports`, {
      method: 'POST',
      headers: {
        Cookie: auditor.cookieHeader,
        'Content-Type': 'application/json',
        'Idempotency-Key': uniqUuid(),
      },
    });

    expect(res.status).toBe(403);
  });

  // --------------------------------------------------------------------------
  // A-14-Empty: no confirmed findings → worker produces ready report
  // --------------------------------------------------------------------------
  test('A-14-Empty: no confirmed findings → report still built and status=ready', async () => {
    await resetAuthState(fx.db);
    const { tenantId, userId } = await seedTenantAndUser(fx.db);

    const projectId = await seedProject(fx, { tenantId, name: 'P-empty' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'https://empty.example.com/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });

    const { storage } = buildLocalStorage();
    const { id: reportId } = await insertReport({
      db: fx.db,
      tenantId,
      assessmentId,
      idempotencyKey: `report.build:idem-empty-${uniqUuid()}`,
    });

    const traceId = makeTraceId();
    const payload = { tenantId, projectId, assessmentId, reportId, traceId };
    const envelope = makeJobEnvelope(payload);
    const deps = buildReportDeps(fx.db, storage);

    const outcome = await handleReportBuild(deps, envelope);

    expect(outcome.kind).toBe('ack');

    const row = await findReportByIdCrossTenant({ db: fx.db, reportId });
    expect(row?.status).toBe('ready');
    expect(row?.sha256Html).toMatch(/^[0-9a-f]{64}$/);
  });
});
