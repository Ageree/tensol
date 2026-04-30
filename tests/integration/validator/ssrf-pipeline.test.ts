// Sprint 18 §A-18-IT — full SSRF replay pipeline integration test.
//
// OOB listener binds to port 0 (ephemeral) to avoid cross-test port conflicts (P39).
//
// Happy path: decepticon emits SSRF candidate → coordinator dispatches
//   validator.ssrf.replay envelope → validator-worker replays via HTTP GET
//   to lab OOB fixture → fixture inserts oob_callbacks row → oobCallbackLoader
//   finds row → validator confirms.
//
// Deny path: replayUrl is out-of-scope → replay_denied audit emitted,
//   httpClient.callCount === 0, no oob_callbacks row, no findings row.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JobEnvelope } from '@cyberstrike/queue';
import {
  DEFAULT_PLATFORM_POLICY,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { type ValidatorWorkerDeps, handleSsrfReplay } from '@cyberstrike/validator-worker';
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
  buildAssessmentLoader,
  buildAuditEmitter,
  buildFindingByCandidateLoader,
  buildFindingsWriter,
  buildLocalStorage,
  seedCandidateFinding,
  stubValidatorScopeDeps,
  uniqUuid,
} from './helpers.ts';

const VALID_TRACE = '0123456789abcdef0123456789abcdef';

class TrackingHttpClient {
  callCount = 0;
  private readonly _db: DbFixture['db'];
  private readonly _token: string;

  constructor(db: DbFixture['db'], token: string) {
    this._db = db;
    this._token = token;
  }

  async get(url: string): Promise<void> {
    this.callCount++;
    // Simulate the OOB receiver inserting a row on callback receipt.
    // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary.
    const headersJson = JSON.stringify({}) as any;
    await this._db
      .insertInto('oob_callbacks')
      .values({
        token: this._token,
        tenant_id: null,
        candidate_id: null,
        kind: 'http',
        method: 'GET',
        path: new URL(url).pathname,
        headers: headersJson,
        body: null,
        source_ip: '127.0.0.1',
      })
      .execute();
  }
}

class DenyHttpClient {
  callCount = 0;
  async get(_url: string): Promise<void> {
    this.callCount++;
  }
}

describe.skipIf(!hasDatabaseUrl())('validator :: SSRF pipeline (A-18-IT)', () => {
  let fx: DbFixture;
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
    tenantId = uniqUuid();
    await fx.db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
      .execute();
  });

  test('happy path — SSRF confirmed: oob_callbacks row + confirmed audit + findings row', async () => {
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

    const projectId = await seedProject(fx, { tenantId, name: 'P-ssrf' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://target.example/api',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });
    const candidateFindingId = await seedCandidateFinding(fx.db, {
      tenantId,
      assessmentId,
      affectedUrl: 'http://ssrf.lab.example/redirect?url=http://169.254.169.254/',
    });

    const candidateUuid = candidateFindingId;
    const token = `${candidateUuid}.${tenantId}.abcd1234`;

    // oobCallbackLoader checks oob_callbacks table for matching token.
    const oobCallbackLoader = async (t: string): Promise<boolean> => {
      const row = await fx.db
        .selectFrom('oob_callbacks')
        .select(['id'])
        .where('token', '=', t)
        .executeTakeFirst();
      return Boolean(row);
    };

    const httpClient = new TrackingHttpClient(fx.db, token);
    const { storage } = buildLocalStorage();

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
          payload: { pattern: 'ssrf.lab.example', matchSubdomains: false },
        },
        { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
        { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
        { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
        { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
        { id: 'r6', ruleKind: 'ip', effect: 'allow', payload: { ip: '127.0.0.1' } },
      ],
      toolCatalog: new Map<string, ToolPolicy>(),
      assessmentFlags: {
        highImpactCategories: [],
        ownershipVerifiedTargetIds: new Set([targetId]),
      },
      timeWindow: null,
    });

    const ssrfScopeDeps = {
      ...stubValidatorScopeDeps,
      dns: {
        resolveA: async (host: string): Promise<string[]> => {
          if (host === 'ssrf.lab.example') return ['203.0.113.10'];
          return stubValidatorScopeDeps.dns.resolveA(host);
        },
        resolveAAAA: async (): Promise<string[]> => [],
      },
    };

    const deps: ValidatorWorkerDeps = {
      driver: {
        replay: async () => ({
          attempt: 0,
          capturedAt: '',
          httpStatus: null,
          domContainsNonce: false,
          consoleNonceHits: [],
          alertDispatched: false,
          screenshot: Buffer.alloc(0),
          trace: Buffer.alloc(0),
        }),
      } as unknown as ValidatorWorkerDeps['driver'],
      objectStorage: storage,
      buildScope: async () => scope,
      scopeDeps: ssrfScopeDeps,
      auditEmitter: buildAuditEmitter(fx.db),
      candidateLoader: async () => null,
      assessmentLoader: buildAssessmentLoader(fx.db),
      findingsWriter: buildFindingsWriter(fx.db),
      findingEvidenceWriter: async () => ({ id: uniqUuid() }),
      findingByCandidateLoader: buildFindingByCandidateLoader(fx.db),
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: (await import('@cyberstrike/validator-worker')).validateFindingPayloadSchema,
      oobCallbackLoader,
      oobVerifyTimeoutMs: 5000,
      ssrfHttpClient: httpClient,
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.ssrf.replay',
      idempotencyKey: `ssrf:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'ssrf',
        replayUrl: 'http://ssrf.lab.example/redirect',
        token,
        traceId: VALID_TRACE,
      },
    };

    const result = await handleSsrfReplay(deps, envelope);
    expect(result.kind).toBe('ack');

    // oob_callbacks row inserted by httpClient stub.
    const oobRows = await fx.db
      .selectFrom('oob_callbacks')
      .selectAll()
      .where('token', '=', token)
      .execute();
    expect(oobRows.length).toBeGreaterThanOrEqual(1);
    expect(String(oobRows[0]?.kind)).toBe('http');

    // validator.ssrf.confirmed audit row present.
    const audits = await fx.db
      .selectFrom('audit_events')
      .select(['action'])
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.ssrf.confirmed')
      .execute();
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // findings row created.
    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(findings.length).toBe(1);
    expect(String(findings[0]?.type)).toBe('ssrf');
  });

  test('deny path — out-of-scope: replay_denied audit, callCount===0, no oob_callbacks, no findings', async () => {
    const userId = uniqUuid();
    await fx.db
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email: `u-deny-${userId.slice(0, 8)}@example.com`,
        display_name: `u-deny-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-ssrf-deny' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://deny.example/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });
    const candidateFindingId = await seedCandidateFinding(fx.db, {
      tenantId,
      assessmentId,
      affectedUrl: 'http://evil.oos.example/ssrf',
    });
    const token = `${candidateFindingId}.${tenantId}.deadbeef`;

    // Empty scope = deny by default (no allow rules).
    const scope = buildEffectiveScope({
      tenantId,
      assessmentId,
      tenantPolicy: { tenantId },
      platformPolicy: DEFAULT_PLATFORM_POLICY,
      rawRules: [],
      toolCatalog: new Map<string, ToolPolicy>(),
      assessmentFlags: {
        highImpactCategories: [],
        ownershipVerifiedTargetIds: new Set([targetId]),
      },
      timeWindow: null,
    });

    const denyClient = new DenyHttpClient();
    const { storage } = buildLocalStorage();

    const deps: ValidatorWorkerDeps = {
      driver: { replay: async () => ({}) } as unknown as ValidatorWorkerDeps['driver'],
      objectStorage: storage,
      buildScope: async () => scope,
      scopeDeps: stubValidatorScopeDeps,
      auditEmitter: buildAuditEmitter(fx.db),
      candidateLoader: async () => null,
      assessmentLoader: buildAssessmentLoader(fx.db),
      findingsWriter: buildFindingsWriter(fx.db),
      findingEvidenceWriter: async () => ({ id: uniqUuid() }),
      findingByCandidateLoader: buildFindingByCandidateLoader(fx.db),
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: (await import('@cyberstrike/validator-worker')).validateFindingPayloadSchema,
      oobCallbackLoader: async () => false,
      oobVerifyTimeoutMs: 100,
      ssrfHttpClient: denyClient,
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.ssrf.replay',
      idempotencyKey: `ssrf-deny:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'ssrf',
        replayUrl: 'http://evil.oos.example/ssrf',
        token,
        traceId: VALID_TRACE,
      },
    };

    const result = await handleSsrfReplay(deps, envelope);
    expect(result.kind).toBe('ack');

    // R4: no HTTP call made.
    expect(denyClient.callCount).toBe(0);

    // No oob_callbacks row.
    const oobRows = await fx.db
      .selectFrom('oob_callbacks')
      .selectAll()
      .where('token', '=', token)
      .execute();
    expect(oobRows.length).toBe(0);

    // No findings row.
    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(findings.length).toBe(0);

    // validator.ssrf.replay_denied audit present.
    const audits = await fx.db
      .selectFrom('audit_events')
      .select(['action'])
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.ssrf.replay_denied')
      .execute();
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});
