// Sprint 8 §A-FD-Tenant-Iso — two parallel assessments in different tenants.
//
// Confirms that fixture sessions don't cross-talk and per-tenant rows stay
// isolated.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAssessmentStart } from '@cyberstrike/coordinator';
import { type JobEnvelope, LocalQueueAdapter } from '@cyberstrike/queue';
import { buildScopeForAssessment } from '../../../apps/api/src/scope-engine/build-scope.ts';
import { startDecepticonSession } from '../../../apps/api/src/scope-engine/start-decepticon-session.ts';
import { hasDatabaseUrl, resetAuthState } from '../auth/helpers/auth-fixture.ts';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedAssessment,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';
import {
  allowExampleComScopeRules,
  buildFakeAdapter,
  buildLocalObjectStorage,
  stubScopeDeps,
  uniqUuid,
} from './helpers.ts';

interface TenantSetup {
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly userId: string;
}

const setupTenantWithAssessment = async (fx: DbFixture): Promise<TenantSetup> => {
  const tenantId = uniqUuid();
  await fx.db
    .insertInto('tenants')
    .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
    .execute();
  const userId = uniqUuid();
  await fx.db
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
  const projectId = await seedProject(fx, { tenantId, name: 'P-iso' });
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
    scopeRules: allowExampleComScopeRules,
  });
  return { tenantId, assessmentId, projectId, targetId, userId };
};

const buildEnv = (s: TenantSetup, idemSuffix: string): JobEnvelope => ({
  jobId: uniqUuid(),
  tenantId: s.tenantId,
  projectId: s.projectId,
  assessmentId: s.assessmentId,
  kind: 'assessment.start',
  idempotencyKey: `assessment.start:iso-${idemSuffix}`,
  createdAt: new Date().toISOString(),
  attempt: 0,
  maxAttempts: 3,
  traceId: '0123456789abcdef0123456789abcdef',
  payload: { assessmentId: s.assessmentId, targetIds: [s.targetId] },
});

describe.skipIf(!hasDatabaseUrl())(
  'decepticon :: session isolation across tenants (A-FD-Tenant-Iso)',
  () => {
    let fx: DbFixture;
    let queueDir: string;
    let queueAdapter: LocalQueueAdapter;

    beforeAll(async () => {
      fx = await createFixture();
      await dropAllTables(fx);
      await applyAllMigrations(fx);
    });

    afterAll(async () => {
      await dropAllTables(fx);
      await fx.db.destroy();
    });

    beforeEach(async () => {
      await resetAuthState(fx.db);
      queueDir = mkdtempSync(join(tmpdir(), 'cs-decepticon-iso-'));
      queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir: queueDir });
    });

    test('two parallel sessions in different tenants → 2 sessions, 2 candidates, no cross-talk', async () => {
      const s1 = await setupTenantWithAssessment(fx);
      const s2 = await setupTenantWithAssessment(fx);
      // R4 — A-FD-Tenant-Iso teeth: T1 → xss-reflected fixture (xss_reflected
      // candidate), T2 → sqli-demo fixture (sqli candidate). Distinct types
      // make cross-talk binary-detectable.
      const adapter = buildFakeAdapter({
        scenarioForAssessment: (assessmentId: string) =>
          assessmentId === s2.assessmentId ? 'sqli-demo' : 'xss-reflected',
      });
      const { storage, baseDir: storageDir } = buildLocalObjectStorage();

      const env1 = buildEnv(s1, 'a');
      const env2 = buildEnv(s2, 'b');
      await queueAdapter.publish(env1);
      await queueAdapter.publish(env2);

      const runner = (input: Parameters<typeof startDecepticonSession>[1]) =>
        startDecepticonSession(
          {
            db: fx.db,
            adapter,
            objectStorage: storage,
            queueAdapter,
          },
          input,
        );

      const [o1, o2] = await Promise.all([
        handleAssessmentStart(
          {
            db: fx.db,
            adapter: queueAdapter,
            scopeDeps: stubScopeDeps,
            buildScope: (id) => buildScopeForAssessment(fx.db, id),
            decepticonRunner: runner,
          },
          env1,
        ),
        handleAssessmentStart(
          {
            db: fx.db,
            adapter: queueAdapter,
            scopeDeps: stubScopeDeps,
            buildScope: (id) => buildScopeForAssessment(fx.db, id),
            decepticonRunner: runner,
          },
          env2,
        ),
      ]);
      expect(o1.kind).toBe('ack');
      expect(o2.kind).toBe('ack');

      // Each tenant has exactly one session row, scoped to its own tenant_id.
      for (const s of [s1, s2]) {
        const sessions = await fx.db
          .selectFrom('decepticon_sessions')
          .selectAll()
          .where('tenant_id', '=', s.tenantId)
          .execute();
        expect(sessions.length).toBe(1);
        expect(sessions[0]?.assessment_id).toBe(s.assessmentId);
        expect(sessions[0]?.status).toBe('completed');
      }

      // R4 — distinct candidate types per tenant proves no fixture cross-talk.
      const t1Candidates = await fx.db
        .selectFrom('candidate_findings')
        .selectAll()
        .where('tenant_id', '=', s1.tenantId)
        .execute();
      expect(t1Candidates.length).toBe(1);
      expect(t1Candidates[0]?.assessment_id).toBe(s1.assessmentId);
      expect(t1Candidates.map((r) => r.type)).toEqual(['xss_reflected']);

      const t2Candidates = await fx.db
        .selectFrom('candidate_findings')
        .selectAll()
        .where('tenant_id', '=', s2.tenantId)
        .execute();
      expect(t2Candidates.length).toBe(1);
      expect(t2Candidates[0]?.assessment_id).toBe(s2.assessmentId);
      expect(t2Candidates.map((r) => r.type)).toEqual(['sqli']);

      // Cross-tenant SELECT — no T2 row visible under T1 tenant scope.
      const t1ScopedT2 = await fx.db
        .selectFrom('candidate_findings')
        .select(['assessment_id'])
        .where('tenant_id', '=', s1.tenantId)
        .where('assessment_id', '=', s2.assessmentId)
        .execute();
      expect(t1ScopedT2.length).toBe(0);

      rmSync(queueDir, { recursive: true, force: true });
      rmSync(storageDir, { recursive: true, force: true });
    });
  },
);
