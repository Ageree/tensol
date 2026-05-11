// EE-1 (2026-05-12) — coordinator subscribe loop e2e (Bugs A + B + C).
//
// Verifies that a running coordinator (createCoordinator(...).start()) picks
// up an `assessment.start` envelope from the LocalQueueAdapter, runs the
// fake Decepticon session, and transitions the assessment to 'completed'
// with at least one candidate finding and the required audit row.
//
// This is the smallest test that proves the full worker chain works end-
// to-end: queue subscribe → handler → decepticon-runner → assessment
// terminal transition. fake-flow.test.ts asserts the same outcome but via
// direct call to handleAssessmentStart; this test verifies the subscribe
// loop wiring itself (the Bug A fix).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinator } from '@cyberstrike/coordinator';
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

const POLL_INTERVAL_MS = 50;
const COMPLETION_TIMEOUT_MS = 10_000;

const waitForState = async (
  db: DbFixture['db'],
  tenantId: string,
  assessmentId: string,
  target: 'completed' | 'failed',
  timeoutMs: number,
): Promise<string> => {
  const start = Date.now();
  let lastState = 'running';
  while (Date.now() - start < timeoutMs) {
    const row = await db
      .selectFrom('assessments')
      .select(['state'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', assessmentId)
      .executeTakeFirst();
    lastState = row?.state ?? lastState;
    if (lastState === target) return lastState;
    if (lastState === 'failed' && target !== 'failed') return lastState;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return lastState;
};

describe.skipIf(!hasDatabaseUrl())(
  'EE-1 :: coordinator subscribe loop drives scan to completed (Bugs A+B+C)',
  () => {
    let fx: DbFixture;
    let queueDir: string;
    let storageDir: string;
    let queueAdapter: LocalQueueAdapter;
    let tenantId: string;
    let coordinatorHandle: ReturnType<typeof createCoordinator> | null = null;

    beforeAll(async () => {
      fx = await createFixture();
      await dropAllTables(fx);
      await applyAllMigrations(fx);
    });

    afterAll(async () => {
      if (coordinatorHandle) await coordinatorHandle.stop({ timeoutMs: 5_000 });
      await dropAllTables(fx);
      await fx.db.destroy();
    });

    beforeEach(async () => {
      if (coordinatorHandle) {
        await coordinatorHandle.stop({ timeoutMs: 5_000 });
        coordinatorHandle = null;
      }
      await resetAuthState(fx.db);
      queueDir = mkdtempSync(join(tmpdir(), 'cs-ee1-q-'));
      queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir: queueDir });
      tenantId = uniqUuid();
      await fx.db
        .insertInto('tenants')
        .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
        .execute();
    });

    test('coordinator subscribes, picks up assessment.start, drives to state=completed with finding', async () => {
      // Arrange: tenant + user + project + verified target + running assessment.
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
      const projectId = await seedProject(fx, { tenantId, name: 'EE-1 scan-completion' });
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

      // Wire: fake adapter + local storage + bound runner.
      const adapter = buildFakeAdapter();
      const built = buildLocalObjectStorage();
      storageDir = built.baseDir;
      const runner = (input: Parameters<typeof startDecepticonSession>[1]) =>
        startDecepticonSession(
          {
            db: fx.db,
            adapter,
            objectStorage: built.storage,
            queueAdapter,
          },
          input,
        );

      // Start the coordinator subscribe loop (Bug A fix verification).
      coordinatorHandle = createCoordinator({
        db: fx.db,
        adapter: queueAdapter,
        scopeDeps: stubScopeDeps,
        buildScope: (id) => buildScopeForAssessment(fx.db, id),
        decepticonRunner: runner,
        pollIntervalMs: POLL_INTERVAL_MS,
      });
      coordinatorHandle.start();

      // Act: publish the assessment.start envelope (mirrors what POST /scans does).
      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: `assessment.start:ee1-${assessmentId}`,
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: '0123456789abcdef0123456789abcdef',
        payload: { assessmentId, targetIds: [targetId] },
      };
      await queueAdapter.publish(env);

      // Wait for coordinator to drive the state machine.
      const finalState = await waitForState(
        fx.db,
        tenantId,
        assessmentId,
        'completed',
        COMPLETION_TIMEOUT_MS,
      );

      // Assert Bug B fix: assessment reaches 'completed' state.
      expect(finalState).toBe('completed');

      // Assert: at least one candidate finding row (proves runner ran the session).
      const candidates = await fx.db
        .selectFrom('candidate_findings')
        .select(['id'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(candidates.length).toBeGreaterThanOrEqual(1);

      // Assert Bug C fix: assessment.completed audit row exists.
      const audits = await fx.db
        .selectFrom('audit_events')
        .select(['action'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      const actions = audits.map((a) => a.action);
      expect(actions).toContain('assessment.completed');
      expect(actions).toContain('decepticon.session.completed');
      expect(actions).not.toContain('assessment.failed');

      // Cleanup: stop coordinator before next test or teardown.
      await coordinatorHandle.stop({ timeoutMs: 5_000 });
      coordinatorHandle = null;
      rmSync(queueDir, { recursive: true, force: true });
      rmSync(storageDir, { recursive: true, force: true });
    });
  },
);
