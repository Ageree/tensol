// Sprint 8 §A-FD-Run, A-FD-NoConfirm, A-FD-Timeline — happy-path flow.
//
// Drive coordinator's start handler with a scope-validated assessment and a
// fake decepticon adapter. Assert exactly one decepticon_sessions row, one
// OPPLAN artifact, one candidate_findings row, lifecycle audit events on
// the timeline, and no findings table rows.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
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
  'decepticon :: fake-flow happy path (A-FD-Run, A-FD-NoConfirm, A-FD-Timeline)',
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
      queueDir = mkdtempSync(join(tmpdir(), 'cs-decepticon-q-'));
      queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir: queueDir });
      tenantId = uniqUuid();
      await fx.db
        .insertInto('tenants')
        .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
        .execute();
    });

    test('produces exactly ONE decepticon_sessions row + ONE opplan artifact + ONE candidate_findings row', async () => {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-fake' });
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
        idempotencyKey: 'assessment.start:fake-1',
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
      expect(outcome.kind).toBe('ack');

      // A-FD-Run: ONE decepticon_sessions row.
      const sessions = await fx.db
        .selectFrom('decepticon_sessions')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(sessions.length).toBe(1);
      const session = sessions[0];
      if (!session) throw new Error('expected session');
      expect(session.status).toBe('completed');
      expect(session.opplan_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Number(session.opplan_size_bytes)).toBeGreaterThan(0);
      expect(session.completed_at).not.toBeNull();

      // A-FD-Run: ONE assessment_artifacts row of kind='opplan'.
      const artifacts = await fx.db
        .selectFrom('assessment_artifacts')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('kind', '=', 'opplan')
        .execute();
      expect(artifacts.length).toBe(1);
      const artifact = artifacts[0];
      if (!artifact) throw new Error('expected artifact');
      expect(artifact.sha256).toBe(session.opplan_sha256);
      expect(artifact.object_storage_key).toBe(session.opplan_object_key);
      // A-FD-Pitfall-JSONB: metadata JSONB round-trips a non-empty object.
      const md = artifact.metadata as { opplanVersion?: number };
      expect(md.opplanVersion).toBe(1);

      // A-FD-Run: ONE candidate_findings row of type='xss_reflected'.
      const candidates = await fx.db
        .selectFrom('candidate_findings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(candidates.length).toBe(1);
      const candidate = candidates[0];
      if (!candidate) throw new Error('expected candidate');
      expect(candidate.type).toBe('xss_reflected');
      expect(candidate.severity).toBe('high');
      expect(candidate.affected_url).toBe('http://localhost:9999/xss?q=');
      expect(candidate.source).toBe('decepticon');
      // A-FD-Pitfall-JSONB: payload JSONB round-trips a non-empty object.
      const payload = candidate.payload as { parameter?: string; samplePayload?: string };
      expect(payload.parameter).toBe('q');
      expect(payload.samplePayload).toBe('<svg onload=alert(1)>');

      // A-FD-NoConfirm: findings table is empty.
      const findings = await fx.db
        .selectFrom('findings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(findings.length).toBe(0);

      // A-FD-Timeline: lifecycle audit rows present.
      const auditRows = await fx.db
        .selectFrom('audit_events')
        .select(['action'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      const actions = auditRows.map((r) => r.action);
      expect(actions).toContain('decepticon.session.started');
      expect(actions).toContain('decepticon.session.completed');
      expect(actions).toContain('decepticon.candidate.observed');
      expect(actions).not.toContain('decepticon.session.failed');
      expect(actions).not.toContain('assessment.failed');
      // EE-1 (2026-05-12) — Bugs B + C verified: assessment terminal transition + audit row.
      expect(actions).toContain('assessment.completed');

      // EE-1 Bug B — assessment.state must reach 'completed' on success.
      const finalAssessment = await fx.db
        .selectFrom('assessments')
        .select(['state'])
        .where('tenant_id', '=', tenantId)
        .where('id', '=', assessmentId)
        .executeTakeFirstOrThrow();
      expect(finalAssessment.state).toBe('completed');

      // Sprint 23 F: decepticon.findings queue kind removed; validate.finding published instead.
      const childJobs = await fx.db
        .selectFrom('jobs')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('kind', '=', 'validate.finding')
        .execute();
      expect(childJobs.length).toBe(1);

      rmSync(queueDir, { recursive: true, force: true });
      rmSync(storageDir, { recursive: true, force: true });
    });
  },
);
