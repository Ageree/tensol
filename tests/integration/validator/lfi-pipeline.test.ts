// Sprint 19 §A-19-IT — full LFI replay pipeline integration test.
//
// 4 paths:
//   1. Happy path — confirmed: LFI sentinel match → findings row + confirmed audit
//   2. Deny path — out-of-scope: replay_denied audit, lfiHttpClient.callCount===0, no findings
//   3. Unmatched path — no sentinel match: unmatched audit, no findings
//   4. Missing deps — lfiHttpClient absent: nack, validation.inconclusive audit

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JobEnvelope } from '@cyberstrike/queue';
import {
  DEFAULT_PLATFORM_POLICY,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { type ValidatorWorkerDeps, handleLfiReplay } from '@cyberstrike/validator-worker';
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

// Mock LFI HTTP client — returns a configurable body; never makes real network calls.
class LfiMockHttpClient {
  callCount = 0;
  private readonly _body: string;

  constructor(body: string) {
    this._body = body;
  }

  async get(_url: string): Promise<{ body: string }> {
    this.callCount++;
    return { body: this._body };
  }
}

// Deny client — tracks calls but never returns body (should never be called on deny path).
class LfiDenyHttpClient {
  callCount = 0;
  async get(_url: string): Promise<{ body: string }> {
    this.callCount++;
    return { body: '' };
  }
}

describe.skipIf(!hasDatabaseUrl())('validator :: LFI pipeline (A-19-IT)', () => {
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
  // Path 1 — happy path: confirmed finding + audit + reproduction shape (H2)
  // ─────────────────────────────────────────────────────────────────────────
  test('happy path — LFI confirmed: passwd sentinel → findings row + confirmed audit + reproduction shape', async () => {
    const userId = uniqUuid();
    await fx.db
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email: `u-lfi-${userId.slice(0, 8)}@example.com`,
        display_name: `u-lfi-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-lfi' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://lfi.lab.local/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(fx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });
    const affectedUrl = 'http://lfi.lab.local/app?file=../../../etc/passwd';
    const candidateFindingId = await seedCandidateFinding(fx.db, {
      tenantId,
      assessmentId,
      type: 'lfi',
      affectedUrl,
    });

    // Mock client returns a /etc/passwd-shaped body.
    const passwdBody = 'root:x:0:0:root:/root:/bin/bash\nbin:x:1:1:bin:/bin:/sbin/nologin\n';
    const httpClient = new LfiMockHttpClient(passwdBody);
    const { storage } = buildLocalStorage();

    const lfiScopeDeps = {
      ...stubValidatorScopeDeps,
      dns: {
        resolveA: async (host: string): Promise<string[]> => {
          if (host === 'lfi.lab.local') return ['203.0.113.20'];
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
        { id: 'r1', ruleKind: 'domain', effect: 'allow', payload: { pattern: 'lfi.lab.local', matchSubdomains: false } },
        { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
        { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
        { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
        { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
        { id: 'r6', ruleKind: 'ip', effect: 'allow', payload: { ip: '203.0.113.20' } },
      ],
      toolCatalog: new Map<string, ToolPolicy>(),
      assessmentFlags: {
        highImpactCategories: [],
        ownershipVerifiedTargetIds: new Set([targetId]),
      },
      timeWindow: null,
    });

    const deps: ValidatorWorkerDeps = {
      driver: { replay: async () => ({}) } as unknown as ValidatorWorkerDeps['driver'],
      objectStorage: storage,
      buildScope: async () => scope,
      scopeDeps: lfiScopeDeps,
      auditEmitter: buildAuditEmitter(fx.db),
      candidateLoader: buildCandidateLoader(fx.db),
      assessmentLoader: buildAssessmentLoader(fx.db),
      findingsWriter: buildFindingsWriter(fx.db),
      findingEvidenceWriter: async () => ({ id: uniqUuid() }),
      findingByCandidateLoader: buildFindingByCandidateLoader(fx.db),
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: (await import('@cyberstrike/validator-worker')).validateFindingPayloadSchema,
      lfiHttpClient: httpClient,
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.lfi.replay',
      idempotencyKey: `lfi:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'lfi',
        traceId: VALID_TRACE,
      },
    };

    const result = await handleLfiReplay(deps, envelope);
    expect(result.kind).toBe('ack');
    expect(httpClient.callCount).toBe(1);

    // findings row created with type='lfi'.
    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(findings.length).toBe(1);
    expect(String(findings[0]?.type)).toBe('lfi');

    // H2 — reproduction jsonb shape has sentinelKey + affectedUrl.
    const repro = findings[0]?.reproduction as Record<string, unknown> | null;
    expect(repro?.sentinelKey).toBe('unix_passwd');
    expect(repro?.affectedUrl).toBe(affectedUrl);

    // validator.lfi.confirmed audit present with outcome='success'.
    const confirmedAudits = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.lfi.confirmed')
      .execute();
    expect(confirmedAudits.length).toBeGreaterThanOrEqual(1);
    expect(String(confirmedAudits[0]?.outcome)).toBe('success');
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
        email: `u-lfi-deny-${userId.slice(0, 8)}@example.com`,
        display_name: `u-lfi-deny-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-lfi-deny' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://denied.oos.example/',
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
      type: 'lfi',
      affectedUrl: 'http://denied.oos.example/app?file=../../../etc/passwd',
    });

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

    const denyClient = new LfiDenyHttpClient();
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
      lfiHttpClient: denyClient,
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.lfi.replay',
      idempotencyKey: `lfi-deny:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'lfi',
        traceId: VALID_TRACE,
      },
    };

    const result = await handleLfiReplay(deps, envelope);
    expect(result.kind).toBe('ack');

    // Zero HTTP calls made.
    expect(denyClient.callCount).toBe(0);

    // No findings row.
    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(findings.length).toBe(0);

    // validator.lfi.replay_denied audit present with outcome='denied'.
    const deniedAudits = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.lfi.replay_denied')
      .execute();
    expect(deniedAudits.length).toBeGreaterThanOrEqual(1);
    expect(String(deniedAudits[0]?.outcome)).toBe('denied');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Path 3 — unmatched: no sentinel match, unmatched audit (H3)
  // ─────────────────────────────────────────────────────────────────────────
  test('unmatched path — no sentinel match: unmatched audit with outcome=success + resource_type=candidate_finding', async () => {
    const userId = uniqUuid();
    await fx.db
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email: `u-lfi-unmatch-${userId.slice(0, 8)}@example.com`,
        display_name: `u-lfi-unmatch-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-lfi-unmatch' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://lfi.unmatch.local/',
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
      type: 'lfi',
      affectedUrl: 'http://lfi.unmatch.local/page?file=../config.php',
    });

    const unmatchScopeDeps = {
      ...stubValidatorScopeDeps,
      dns: {
        resolveA: async (host: string): Promise<string[]> => {
          if (host === 'lfi.unmatch.local') return ['203.0.113.21'];
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
        { id: 'r1', ruleKind: 'domain', effect: 'allow', payload: { pattern: 'lfi.unmatch.local', matchSubdomains: false } },
        { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
        { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
        { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
        { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
        { id: 'r6', ruleKind: 'ip', effect: 'allow', payload: { ip: '203.0.113.21' } },
      ],
      toolCatalog: new Map<string, ToolPolicy>(),
      assessmentFlags: {
        highImpactCategories: [],
        ownershipVerifiedTargetIds: new Set([targetId]),
      },
      timeWindow: null,
    });

    // Returns a generic response — no sentinel pattern.
    const httpClient = new LfiMockHttpClient('HTTP/1.1 200 OK\nContent-Type: text/html\n\n<html><body>Hello</body></html>');
    const { storage } = buildLocalStorage();

    const deps: ValidatorWorkerDeps = {
      driver: { replay: async () => ({}) } as unknown as ValidatorWorkerDeps['driver'],
      objectStorage: storage,
      buildScope: async () => scope,
      scopeDeps: unmatchScopeDeps,
      auditEmitter: buildAuditEmitter(fx.db),
      candidateLoader: buildCandidateLoader(fx.db),
      assessmentLoader: buildAssessmentLoader(fx.db),
      findingsWriter: buildFindingsWriter(fx.db),
      findingEvidenceWriter: async () => ({ id: uniqUuid() }),
      findingByCandidateLoader: buildFindingByCandidateLoader(fx.db),
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: (await import('@cyberstrike/validator-worker')).validateFindingPayloadSchema,
      lfiHttpClient: httpClient,
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.lfi.replay',
      idempotencyKey: `lfi-unmatch:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'lfi',
        traceId: VALID_TRACE,
      },
    };

    const result = await handleLfiReplay(deps, envelope);
    expect(result.kind).toBe('ack');

    // No findings row.
    const findings = await fx.db
      .selectFrom('findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assessment_id', '=', assessmentId)
      .execute();
    expect(findings.length).toBe(0);

    // H3 — unmatched audit with outcome='success' and resource_type='candidate_finding'.
    const unmatchedAudits = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validator.lfi.unmatched')
      .execute();
    expect(unmatchedAudits.length).toBeGreaterThanOrEqual(1);
    expect(String(unmatchedAudits[0]?.outcome)).toBe('success');
    expect(String(unmatchedAudits[0]?.resource_type)).toBe('candidate_finding');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Path 4 — missing deps: nack + validation.inconclusive audit
  // ─────────────────────────────────────────────────────────────────────────
  test('missing lfiHttpClient → nack, validation.inconclusive audit with reason:config_error', async () => {
    const userId = uniqUuid();
    await fx.db
      .insertInto('users')
      .values({
        id: userId,
        tenant_id: tenantId,
        email: `u-lfi-nodeps-${userId.slice(0, 8)}@example.com`,
        display_name: `u-lfi-nodeps-${userId.slice(0, 8)}`,
        status: 'active',
        role: 'security_lead',
        password_hash: 'x',
      })
      .execute();

    const projectId = await seedProject(fx, { tenantId, name: 'P-lfi-nodeps' });
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://lfi.nodeps.local/',
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
      type: 'lfi',
      affectedUrl: 'http://lfi.nodeps.local/page?file=../etc/passwd',
    });

    const { storage } = buildLocalStorage();

    // No lfiHttpClient in deps.
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
      // lfiHttpClient intentionally absent.
    };

    const envelope: JobEnvelope = {
      jobId: uniqUuid(),
      tenantId,
      projectId,
      assessmentId,
      kind: 'validator.lfi.replay',
      idempotencyKey: `lfi-nodeps:${candidateFindingId}`,
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId,
        projectId,
        assessmentId,
        candidateFindingId,
        candidateType: 'lfi',
        traceId: VALID_TRACE,
      },
    };

    const result = await handleLfiReplay(deps, envelope);
    expect(result.kind).toBe('nack');

    // validation.inconclusive audit with reason:'config_error'.
    const inconclusiveAudits = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'validation.inconclusive')
      .execute();
    expect(inconclusiveAudits.length).toBeGreaterThanOrEqual(1);
    const meta = inconclusiveAudits[0]?.metadata as Record<string, unknown> | null;
    expect(meta?.reason).toBe('config_error');
    expect(meta?.missing).toBe('lfiHttpClient');
  });
});
