// Sprint 8 §A-FD-Crash — adapter session crash mid-stream.
//
// Drive the same coordinator path against the `xss-reflected-crash` fixture
// (simulateCrashAt: 'recon'). Assert: assessments.state='failed',
// decepticon_sessions.status='failed', `decepticon.session.failed` and
// `assessment.failed` audit rows present, no candidate_findings rows
// inserted.

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

describe.skipIf(!hasDatabaseUrl())('decepticon :: crash mid-stream (A-FD-Crash)', () => {
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
    queueDir = mkdtempSync(join(tmpdir(), 'cs-decepticon-crash-'));
    queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir: queueDir });
    tenantId = uniqUuid();
    await fx.db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
      .execute();
  });

  test('session crash → assessments.state=failed + 0 candidates + 2 failure audit rows', async () => {
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
    const projectId = await seedProject(fx, { tenantId, name: 'P-crash' });
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

    const adapter = buildFakeAdapter({ defaultScenario: 'xss-reflected-crash' });
    const { storage, baseDir: storageDir } = buildLocalObjectStorage();

    const env: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'assessment.start',
      idempotencyKey: 'assessment.start:crash-1',
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: '0123456789abcdef0123456789abcdef',
      payload: { assessmentId, targetIds: [targetId] },
    };
    await queueAdapter.publish(env);

    const outcome = await handleAssessmentStart(
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
    expect(outcome.kind).toBe('nack');

    // assessments.state = 'failed'.
    const ass = await fx.db
      .selectFrom('assessments')
      .select(['state'])
      .where('id', '=', assessmentId)
      .executeTakeFirstOrThrow();
    expect(ass.state).toBe('failed');

    // decepticon_sessions row marked failed.
    const session = await fx.db
      .selectFrom('decepticon_sessions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .executeTakeFirstOrThrow();
    expect(session.status).toBe('failed');
    expect(session.completed_at).not.toBeNull();

    // No candidates inserted.
    const candidates = await fx.db
      .selectFrom('candidate_findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(candidates.length).toBe(0);

    // R2 — A-FD-Crash teeth: assert audit ORDER is
    // (`decepticon.session.failed` → `assessment.failed`).
    // occurred_at may collide at sub-ms within the same tx, so add `id` ASC
    // tiebreak for determinism.
    const auditRows = await fx.db
      .selectFrom('audit_events')
      .select(['action', 'id', 'occurred_at'])
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain('decepticon.session.failed');
    expect(actions).toContain('assessment.failed');
    expect(actions).toContain('decepticon.session.started');
    expect(actions).not.toContain('decepticon.session.completed');
    const sessionFailedIdx = actions.indexOf('decepticon.session.failed');
    const assessmentFailedIdx = actions.indexOf('assessment.failed');
    expect(sessionFailedIdx).toBeGreaterThanOrEqual(0);
    expect(assessmentFailedIdx).toBeGreaterThanOrEqual(0);
    // R4 mitigation binding: session.failed precedes assessment.failed.
    expect(sessionFailedIdx).toBeLessThan(assessmentFailedIdx);

    rmSync(queueDir, { recursive: true, force: true });
    rmSync(storageDir, { recursive: true, force: true });
  });
});
