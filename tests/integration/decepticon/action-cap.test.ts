// EE-3.B (2026-05-12) — action-cap (MVP cost cap) IT.
//
// Verifies: when SCAN_ACTION_CAP is set to a small number and the candidate
// stream has already emitted that many audit rows, the next candidate
// iteration triggers `adapter.stop()`, marks the assessment 'failed' with
// reason='action_cap_exceeded', emits the dedicated audit row, and returns
// the failed result shape.
//
// Cap mechanic: count of `audit_events WHERE assessment_id = X` is compared
// to env SCAN_ACTION_CAP at the TOP of each candidate iteration. So we set
// the cap to 3 (something tiny), then count audits emitted up to the first
// candidate iteration — by then there's already scan.launched (1) +
// decepticon.session.started (1) = ≥2 audits. The first candidate
// iteration's check will see count ≥ 3 once we seed an extra row.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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

const ORIGINAL_CAP = process.env.SCAN_ACTION_CAP;

describe.skipIf(!hasDatabaseUrl())('EE-3.B :: action-cap halts session at quota', () => {
  let fx: DbFixture;
  let queueDir: string;
  let storageDir: string;
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
    queueDir = mkdtempSync(join(tmpdir(), 'cs-ee3b-q-'));
    queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir: queueDir });
    tenantId = uniqUuid();
    await fx.db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
      .execute();
  });

  afterEach(() => {
    if (ORIGINAL_CAP === undefined) delete process.env.SCAN_ACTION_CAP;
    else process.env.SCAN_ACTION_CAP = ORIGINAL_CAP;
    rmSync(queueDir, { recursive: true, force: true });
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  test('SCAN_ACTION_CAP=1 → first iteration trips cap → assessment.failed + cap-exceeded audit', async () => {
    process.env.SCAN_ACTION_CAP = '1';

    // Arrange — minimal viable assessment+target.
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
    const projectId = await seedProject(fx, { tenantId, name: 'EE-3.B' });
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
    const built = buildLocalObjectStorage();
    storageDir = built.baseDir;

    const env: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'assessment.start',
      idempotencyKey: `assessment.start:ee3b-${assessmentId}`,
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
              objectStorage: built.storage,
              queueAdapter,
            },
            input,
          ),
      },
      env,
    );
    // handleAssessmentStart returns nack on failure outcome.
    expect(outcome.kind).toBe('nack');

    // Assert: assessment marked failed.
    const finalAssessment = await fx.db
      .selectFrom('assessments')
      .select(['state'])
      .where('id', '=', assessmentId)
      .executeTakeFirstOrThrow();
    expect(finalAssessment.state).toBe('failed');

    // Assert: cap_exceeded audit row present with sane metadata.
    const capAudit = await fx.db
      .selectFrom('audit_events')
      .select(['action', 'after_state'])
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .where('action', '=', 'assessment.action_cap_exceeded')
      .executeTakeFirst();
    expect(capAudit).not.toBeUndefined();
    const meta = capAudit?.after_state as {
      outcome: string;
      actionCount?: number;
      actionCap?: number;
    };
    expect(meta.outcome).toBe('failure');
    expect(meta.actionCap).toBe(1);
    expect(typeof meta.actionCount).toBe('number');
    expect(meta.actionCount).toBeGreaterThanOrEqual(1);

    // Assert: decepticon_session marked failed (cleanup happened).
    const sess = await fx.db
      .selectFrom('decepticon_sessions')
      .select(['status'])
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .executeTakeFirstOrThrow();
    expect(sess.status).toBe('failed');

    // Sanity: assessment.completed audit NOT present (we halted before
    // success path).
    const audits = await fx.db
      .selectFrom('audit_events')
      .select(['action'])
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    const actions = audits.map((r) => r.action);
    expect(actions).not.toContain('assessment.completed');
    expect(actions).toContain('assessment.failed'); // markAssessmentFailed emits this
  });

  test('SCAN_ACTION_CAP unset → default 100_000 → normal scan completes without cap trigger', async () => {
    delete process.env.SCAN_ACTION_CAP;

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
    const projectId = await seedProject(fx, { tenantId, name: 'EE-3.B-default' });
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
    const built = buildLocalObjectStorage();
    storageDir = built.baseDir;

    const env: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'assessment.start',
      idempotencyKey: `assessment.start:ee3b-default-${assessmentId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: 'fedcba9876543210fedcba9876543210',
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
              objectStorage: built.storage,
              queueAdapter,
            },
            input,
          ),
      },
      env,
    );

    const finalAssessment = await fx.db
      .selectFrom('assessments')
      .select(['state'])
      .where('id', '=', assessmentId)
      .executeTakeFirstOrThrow();
    expect(finalAssessment.state).toBe('completed');

    const capAudit = await fx.db
      .selectFrom('audit_events')
      .select(['action'])
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .where('action', '=', 'assessment.action_cap_exceeded')
      .executeTakeFirst();
    expect(capAudit).toBeUndefined();
  });
});
