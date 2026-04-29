// Sprint 8 §A-FD-Run, A-FD-Opplan-1 — OPPLAN sha256/size/key correctness.
//
// Sanity-check: the assessment_artifacts row matches the bytes actually
// written to LocalObjectStorage; sha256 hex 64-char; size_bytes positive;
// JSON parses + has expected shape.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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

describe.skipIf(!hasDatabaseUrl())(
  'decepticon :: OPPLAN artifact correctness (A-FD-Opplan-1)',
  () => {
    let fx: DbFixture;
    let queueDir: string;
    let queueAdapter: LocalQueueAdapter;
    let tenantId: string;

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
      queueDir = mkdtempSync(join(tmpdir(), 'cs-decepticon-opplan-'));
      queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir: queueDir });
      tenantId = uniqUuid();
      await fx.db
        .insertInto('tenants')
        .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
        .execute();
    });

    test('OPPLAN bytes round-trip via object storage; sha256 matches stored row', async () => {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-opplan' });
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

      const adapter = buildFakeAdapter();
      const { storage, baseDir: storageDir } = buildLocalObjectStorage();

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: 'assessment.start:opplan-1',
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: '0123456789abcdef0123456789abcdef',
        payload: { assessmentId, targetIds: [targetId] },
      };
      await queueAdapter.publish(env);

      await handleAssessmentStart(
        {
          db: fx.db,
          adapter: queueAdapter,
          scopeDeps: stubScopeDeps,
          buildScope: (id) => buildScopeForAssessment(fx.db, id),
          decepticonRunner: (input) =>
            startDecepticonSession(
              {
                db: fx.db,
                adapter,
                objectStorage: storage,
                queueAdapter,
              },
              input,
            ),
        },
        env,
      );

      const artifact = await fx.db
        .selectFrom('assessment_artifacts')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('kind', '=', 'opplan')
        .executeTakeFirstOrThrow();

      // Storage round-trip.
      const bytes = await storage.get(artifact.object_storage_key);
      const computed = createHash('sha256').update(bytes).digest('hex');
      expect(computed).toBe(artifact.sha256);
      expect(Number(artifact.size_bytes)).toBe(bytes.byteLength);

      // R1 — A-FD-OpplanShape: explicit 12-field assertions per spec §Sprint-8.
      // Spec: {assessmentId, targets, authorizedScope, exclusions, testingWindow,
      //  allowedTools, unavailableTools, engagementProfile, foothold:false,
      //  postExploit:false, c2:false, ad:false}.
      const opplan = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      // 1. assessmentId — uuid, equals seeded.
      expect(opplan.assessmentId).toBe(assessmentId);
      // 2. targets — string[].
      expect(Array.isArray(opplan.targets)).toBe(true);
      expect((opplan.targets as unknown[]).every((t) => typeof t === 'string')).toBe(true);
      // 3. authorizedScope — string[].
      expect(Array.isArray(opplan.authorizedScope)).toBe(true);
      expect((opplan.authorizedScope as unknown[]).every((t) => typeof t === 'string')).toBe(true);
      // 4. exclusions — string[].
      expect(Array.isArray(opplan.exclusions)).toBe(true);
      expect((opplan.exclusions as unknown[]).every((t) => typeof t === 'string')).toBe(true);
      // 5. testingWindow — { start: string|null, end: string|null }.
      const tw = opplan.testingWindow as { start: unknown; end: unknown };
      expect(tw).toBeTruthy();
      expect(tw.start === null || typeof tw.start === 'string').toBe(true);
      expect(tw.end === null || typeof tw.end === 'string').toBe(true);
      // 6. allowedTools — string[].
      expect(Array.isArray(opplan.allowedTools)).toBe(true);
      expect((opplan.allowedTools as unknown[]).every((t) => typeof t === 'string')).toBe(true);
      // 7. unavailableTools — string[].
      expect(Array.isArray(opplan.unavailableTools)).toBe(true);
      expect((opplan.unavailableTools as unknown[]).every((t) => typeof t === 'string')).toBe(true);
      // 8. engagementProfile — string.
      expect(typeof opplan.engagementProfile).toBe('string');
      expect(opplan.engagementProfile).toBe('recon-only');
      // 9-12. Defence-in-depth boolean literals.
      expect(opplan.foothold).toBe(false);
      expect(opplan.postExploit).toBe(false);
      expect(opplan.c2).toBe(false);
      expect(opplan.ad).toBe(false);
      // R1 cardinality guard — OPPLAN must be EXACTLY these 12 fields, no extras.
      expect(Object.keys(opplan).sort()).toEqual(
        [
          'ad',
          'allowedTools',
          'assessmentId',
          'authorizedScope',
          'c2',
          'engagementProfile',
          'exclusions',
          'foothold',
          'postExploit',
          'targets',
          'testingWindow',
          'unavailableTools',
        ].sort(),
      );

      // Object key follows the canonical layout.
      expect(artifact.object_storage_key).toContain(`tenant/${tenantId}/`);
      expect(artifact.object_storage_key).toContain(`/assessment/${assessmentId}/`);
      expect(artifact.object_storage_key).toMatch(/opplan-[a-f0-9]{64}\.json$/);

      rmSync(queueDir, { recursive: true, force: true });
      rmSync(storageDir, { recursive: true, force: true });
    });
  },
);
