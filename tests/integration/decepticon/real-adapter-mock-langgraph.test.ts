// Sprint 13 §A-13-Flow — coordinator wiring with RealDecepticonAdapter + mock LangGraph client.
//
// This test exercises the COORDINATOR wiring path end-to-end against a real DB,
// using RealDecepticonAdapter injected with a mock DecepticonClient (no live
// LangGraph server required). It differs from real.test.ts (unit: adapter
// alone) by driving the full handleAssessmentStart → startDecepticonSession
// → candidate persist → decepticon.findings + validate.finding publish path.
//
// Acceptance criteria exercised:
//   A-13-Flow: session row + candidate_findings + decepticon.findings job +
//              validate.finding job + audit trail
//   A-13-Scope: scope-engine.decide called on every candidate affectedUrl
//               (enforced by startDecepticonSession path, which the test drives)
//   A-13-Audit: decepticon.session.started / candidate.observed / session.completed
//   A-13-FixtureReset: resetAuthState called in every beforeEach (P27)

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAssessmentStart } from '@cyberstrike/coordinator';
import {
  type DecepticonClient,
  RealDecepticonAdapter,
  type StreamChunk,
} from '@cyberstrike/decepticon-adapter';
import { type JobEnvelope, LocalQueueAdapter } from '@cyberstrike/queue';
import type { Thread } from '@langchain/langgraph-sdk';
import { buildScopeForAssessment } from '../../../apps/api/src/scope-engine/build-scope.ts';
import { createDecepticonRunner } from '../../../apps/api/src/scope-engine/create-decepticon-runner.ts';
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
  buildLocalObjectStorage,
  stubScopeDeps,
  uniqUuid,
} from './helpers.ts';

// ============================================================================
// Mock LangGraph client factory
// ============================================================================

const buildMockClient = (chunks: StreamChunk[], threadId = 'mock-thread-s13'): DecepticonClient => {
  const client: DecepticonClient = {
    threads: {
      create(_args) {
        return Promise.resolve({ thread_id: threadId } as unknown as Thread);
      },
      get(_threadId) {
        // 2026-05-12 HITL state-machine — return idle empty thread so
        // auto-approval loop short-circuits in IT.
        return Promise.resolve({
          thread_id: threadId,
          status: 'idle',
          values: { messages: [] },
        } as unknown as Thread);
      },
    },
    runs: {
      stream(_threadId, _assistantId) {
        const generator = async function* (): AsyncGenerator<StreamChunk> {
          for (const c of chunks) {
            await Promise.resolve();
            yield c;
          }
        };
        return generator();
      },
      cancel() {
        return Promise.resolve();
      },
    },
  };
  return client;
};

const findingPayload = {
  type: 'xss_reflected',
  severity: 'high',
  affectedUrl: 'https://example.com/search?q=test',
  reproduction: { method: 'GET', payload: '<script>alert(1)</script>' },
};

const happyPathChunks: StreamChunk[] = [
  { event: 'metadata', data: { run_id: 'run-s13-1' } },
  { event: 'custom', data: { type: 'subagent_start', agent: 'recon' } },
  { event: 'custom', data: { type: 'subagent_start', agent: 'exploit' } },
  {
    event: 'custom',
    data: {
      type: 'subagent_tool_result',
      agent: 'detector',
      tool: 'report_finding',
      content: JSON.stringify(findingPayload),
    },
  },
  { event: 'end', data: {} },
];

// ============================================================================
// Suite
// ============================================================================

describe.skipIf(!hasDatabaseUrl())(
  'decepticon :: real-adapter + mock LangGraph (A-13-Flow)',
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
      queueDir = mkdtempSync(join(tmpdir(), 'cs-real-adapter-q-'));
      queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir: queueDir });
      tenantId = uniqUuid();
      await fx.db
        .insertInto('tenants')
        .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
        .execute();
    });

    test('A-13-Flow: happy path — session row + candidate_findings + jobs + audit', async () => {
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

      const projectId = await seedProject(fx, { tenantId, name: 'P-real-s13' });
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

      const mockClient = buildMockClient(happyPathChunks, 'mock-thread-s13-flow');
      const adapter = new RealDecepticonAdapter({ clientFactory: () => mockClient });
      const { storage, baseDir: storageDir } = buildLocalObjectStorage();
      const runner = createDecepticonRunner(adapter, {
        db: fx.db,
        objectStorage: storage,
        queueAdapter,
      });

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: 'assessment.start:real-s13-1',
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
          decepticonRunner: runner,
        },
        env,
      );
      expect(outcome.kind).toBe('ack');

      // A-13-Flow: ONE decepticon_sessions row, status='completed'.
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
      // A-13-Migration: langgraph_thread_id populated from mock client.
      expect(session.langgraph_thread_id).toBe('mock-thread-s13-flow');
      expect(session.completed_at).not.toBeNull();

      // A-13-Flow: ONE candidate_findings row (scope-validated affectedUrl).
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
      // A-13-Scope: affectedUrl is https://example.com/ scope-validated before persist.
      expect(candidate.affected_url).toBe('https://example.com/search?q=test');
      expect(candidate.source).toBe('decepticon.detector');

      // A-13-Flow: findings table empty (not confirmed yet).
      const findings = await fx.db
        .selectFrom('findings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(findings.length).toBe(0);

      // Sprint 23 F: decepticon.findings kind removed; validate.finding published instead.

      // A-13-Flow: validate.finding job enqueued for xss_reflected candidate.
      const validateJobs = await fx.db
        .selectFrom('jobs')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('kind', '=', 'validate.finding')
        .execute();
      expect(validateJobs.length).toBe(1);

      // A-13-Audit: correct audit trail.
      const auditRows = await fx.db
        .selectFrom('audit_events')
        .select(['action'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      const actions = auditRows.map((r) => r.action);
      expect(actions).toContain('decepticon.session.started');
      expect(actions).toContain('decepticon.candidate.observed');
      expect(actions).toContain('decepticon.session.completed');
      expect(actions).not.toContain('decepticon.session.failed');
      expect(actions).not.toContain('assessment.failed');

      rmSync(queueDir, { recursive: true, force: true });
      rmSync(storageDir, { recursive: true, force: true });
    });

    test('A-13-Scope: out-of-scope candidate is denied — 0 candidate_findings, 0 validate jobs, 1 denied audit', async () => {
      await resetAuthState(fx.db);
      tenantId = uniqUuid();
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

      const projectId = await seedProject(fx, { tenantId, name: 'P-scope-deny' });
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
        // Scope only allows example.com — attacker.example must be denied.
        scopeRules: allowExampleComScopeRules,
      });

      // Adapter emits one candidate with an out-of-scope URL.
      // The attacker.example domain is NOT in scope, so decide() should deny it.
      const outOfScopeChunks: StreamChunk[] = [
        { event: 'metadata', data: { run_id: 'run-s13-scope-deny' } },
        {
          event: 'custom',
          data: {
            type: 'subagent_tool_result',
            agent: 'detector',
            tool: 'report_finding',
            content: JSON.stringify({
              type: 'xss_reflected',
              severity: 'high',
              affectedUrl: 'https://attacker.example/',
              reproduction: { method: 'GET', payload: '<script>alert(1)</script>' },
            }),
          },
        },
        { event: 'end', data: {} },
      ];
      const mockClient = buildMockClient(outOfScopeChunks, 'mock-thread-scope-deny');
      const adapter = new RealDecepticonAdapter({ clientFactory: () => mockClient });
      const { storage, baseDir: storageDir } = buildLocalObjectStorage();
      // scopeDeps is pre-bound in the runner via createDecepticonRunner so
      // startDecepticonSession calls decide() on each candidate's affectedUrl.
      // attacker.example resolves to [] (no DNS entry) → dnsResolution=failed
      // → denied (fail-closed per scope-engine codex iter-4 P1).
      const runner = createDecepticonRunner(adapter, {
        db: fx.db,
        objectStorage: storage,
        queueAdapter,
        scopeDeps: stubScopeDeps,
      });

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: 'assessment.start:real-s13-scope-deny',
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
          decepticonRunner: runner,
        },
        env,
      );
      // Session completes even though the candidate was denied.
      expect(outcome.kind).toBe('ack');

      // A-13-Scope P1-A: ZERO candidate_findings rows for out-of-scope URL.
      const candidates = await fx.db
        .selectFrom('candidate_findings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(candidates.length).toBe(0);

      // A-13-Scope P1-A: ZERO validate.finding jobs published.
      const validateJobs = await fx.db
        .selectFrom('jobs')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('kind', '=', 'validate.finding')
        .execute();
      expect(validateJobs.length).toBe(0);

      // Sprint 23 F: decepticon.findings kind removed; no such jobs exist.

      // A-13-Scope P1-A: ONE decepticon.candidate.denied audit event.
      const deniedAuditRows = await fx.db
        .selectFrom('audit_events')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('action', '=', 'decepticon.candidate.denied')
        .execute();
      expect(deniedAuditRows.length).toBe(1);

      // Verify the denied audit metadata contains the out-of-scope URL.
      const deniedRow = deniedAuditRows[0];
      if (!deniedRow) throw new Error('expected denied audit row');
      // after_state = { outcome: 'denied', reason: 'scope_deny', affectedUrl, ... }
      const afterState = deniedRow.after_state as Record<string, unknown>;
      expect(afterState.affectedUrl).toBe('https://attacker.example/');

      rmSync(queueDir, { recursive: true, force: true });
      rmSync(storageDir, { recursive: true, force: true });
    });

    test('A-13-Flow: crash path — failed session + no candidates + audit', async () => {
      await resetAuthState(fx.db);
      tenantId = uniqUuid();
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

      const projectId = await seedProject(fx, { tenantId, name: 'P-real-crash' });
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

      const crashChunks: StreamChunk[] = [
        {
          event: 'custom',
          data: { type: 'subagent_end', agent: 'recon', error: true, content: 'recon_blew_up' },
        },
        { event: 'end', data: {} },
      ];
      const mockClient = buildMockClient(crashChunks, 'mock-thread-s13-crash');
      const adapter = new RealDecepticonAdapter({ clientFactory: () => mockClient });
      const { storage, baseDir: storageDir } = buildLocalObjectStorage();
      const runner = createDecepticonRunner(adapter, {
        db: fx.db,
        objectStorage: storage,
        queueAdapter,
      });

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: 'assessment.start:real-s13-crash',
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: 'abcdef0123456789abcdef0123456789',
        payload: { assessmentId, targetIds: [targetId] },
      };
      await queueAdapter.publish(env);

      const outcome = await handleAssessmentStart(
        {
          db: fx.db,
          adapter: queueAdapter,
          scopeDeps: stubScopeDeps,
          buildScope: (id) => buildScopeForAssessment(fx.db, id),
          decepticonRunner: runner,
        },
        env,
      );
      expect(outcome.kind).toBe('nack');

      const sessions = await fx.db
        .selectFrom('decepticon_sessions')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.status).toBe('failed');

      const candidates = await fx.db
        .selectFrom('candidate_findings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(candidates.length).toBe(0);

      const auditRows = await fx.db
        .selectFrom('audit_events')
        .select(['action'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      const actions = auditRows.map((r) => r.action);
      expect(actions).toContain('decepticon.session.failed');
      expect(actions).toContain('assessment.failed');
      expect(actions).not.toContain('decepticon.session.completed');

      rmSync(queueDir, { recursive: true, force: true });
      rmSync(storageDir, { recursive: true, force: true });
    });
  },
);
