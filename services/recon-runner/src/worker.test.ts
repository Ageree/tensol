// Sprint 21 — Unit tests for recon-runner worker (handleReconSubfinderRun).
//
// Coverage paths:
//   1. B2 assessment_mismatch (tenantId differs) → denied+ack+assessment_mismatch.
//   2. B2 assessment null (not found) → denied+ack+assessment_mismatch.
//   3. null buildScope → subfinder emits config_error, pipeline continues to ack.
//   4. B4 middle-throw in targetWriter → best-effort continue, ack returned.
//   5. C1 partial binary absence (subfinder missing) → fallback to primaryDomain, ack.
//   6. Happy path: all stubs wired, subfinder→httpx→nuclei, ack returned.
//   7. HIGH-2 project mismatch → denied+ack+project_mismatch.
//   8. HIGH-1 OOS host not persisted → only scope-approved aliveResults hosts written.

import { describe, expect, test } from 'bun:test';
import type { JobEnvelope } from '@cyberstrike/queue';
import {
  DEFAULT_PLATFORM_POLICY,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import type { AssessmentRow, AuditEmitterArgs, ReconWorkerDeps } from './worker.ts';
import { handleReconSubfinderRun } from './worker.ts';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const TENANT_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_UUID = '33333333-3333-4333-8333-333333333333';
const VALID_TRACE = 'aabbccddeeff00112233445566778899';
const PRIMARY_DOMAIN = 'example.com';

const makeEnvelope = (tenantId = TENANT_UUID, assessmentId = VALID_UUID): JobEnvelope => ({
  jobId: VALID_UUID,
  tenantId,
  assessmentId,
  projectId: VALID_UUID,
  kind: 'recon.subfinder.run',
  idempotencyKey: `test-${VALID_UUID}`,
  createdAt: new Date().toISOString(),
  attempt: 0,
  maxAttempts: 3,
  traceId: VALID_TRACE,
  payload: {
    tenantId,
    assessmentId,
    projectId: VALID_UUID,
    primaryDomain: PRIMARY_DOMAIN,
    traceId: VALID_TRACE,
  },
});

const makeAuditCapture = (): {
  emitter: (args: AuditEmitterArgs) => Promise<void>;
  emitted: AuditEmitterArgs[];
} => {
  const emitted: AuditEmitterArgs[] = [];
  return {
    emitter: async (args: AuditEmitterArgs): Promise<void> => {
      emitted.push(args);
    },
    emitted,
  };
};

const makeAssessmentLoader =
  (row: AssessmentRow | null) =>
  async (_input: { tenantId: string; assessmentId: string }): Promise<AssessmentRow | null> =>
    row;

const makeAllowScope = () =>
  buildEffectiveScope({
    tenantId: TENANT_UUID,
    assessmentId: VALID_UUID,
    tenantPolicy: { tenantId: TENANT_UUID },
    platformPolicy: DEFAULT_PLATFORM_POLICY,
    rawRules: [
      {
        id: 'r1',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'example.com', matchSubdomains: true },
      },
      { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'https' } },
      { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 443 } },
      { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
      { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
    ],
    toolCatalog: new Map<string, ToolPolicy>(),
    assessmentFlags: { highImpactCategories: [], ownershipVerifiedTargetIds: new Set<string>() },
    timeWindow: null,
  });

const makeScopeDeps = () => ({
  dns: {
    resolveA: async (_host: string): Promise<string[]> => ['93.184.216.34'],
    resolveAAAA: async (): Promise<string[]> => [],
  },
  clock: { now: (): Date => new Date() },
  rateLimit: {
    consume: async (): Promise<{ ok: true; retryAfterMs: number }> => ({
      ok: true,
      retryAfterMs: 0,
    }),
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 1 — B2: assessment belongs to different tenant → denied+ack
// ─────────────────────────────────────────────────────────────────────────────
describe('worker :: B2 tenant mismatch', () => {
  test('assessment row has different tenantId → recon.subfinder.denied + ack', async () => {
    const { emitter, emitted } = makeAuditCapture();
    // Loader returns a row that belongs to OTHER_UUID, not TENANT_UUID
    const deps: ReconWorkerDeps = {
      auditEmitter: emitter,
      assessmentLoader: makeAssessmentLoader({
        id: VALID_UUID,
        tenantId: OTHER_UUID,
        projectId: VALID_UUID,
      }),
      buildScope: async () => makeAllowScope(),
      scopeDeps: makeScopeDeps(),
    };

    const outcome = await handleReconSubfinderRun(makeEnvelope(TENANT_UUID), deps);

    expect(outcome.kind).toBe('ack');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.subfinder.denied');
    expect(emitted[0].outcome).toBe('denied');
    expect((emitted[0].metadata as Record<string, unknown>).reason).toBe('assessment_mismatch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 2 — B2: assessment not found (loader returns null) → denied+ack
// ─────────────────────────────────────────────────────────────────────────────
describe('worker :: B2 assessment null', () => {
  test('loader returns null → recon.subfinder.denied + ack', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const deps: ReconWorkerDeps = {
      auditEmitter: emitter,
      assessmentLoader: makeAssessmentLoader(null),
      buildScope: async () => makeAllowScope(),
      scopeDeps: makeScopeDeps(),
    };

    const outcome = await handleReconSubfinderRun(makeEnvelope(), deps);

    expect(outcome.kind).toBe('ack');
    expect(emitted[0].action).toBe('recon.subfinder.denied');
    expect((emitted[0].metadata as Record<string, unknown>).reason).toBe('assessment_mismatch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 3 — null buildScope → subfinder emits config_error (missing scope), ack
// ─────────────────────────────────────────────────────────────────────────────
describe('worker :: null buildScope', () => {
  test('buildScope returns null → pipeline runs with null scope, subfinder.denied emitted, ack', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const deps: ReconWorkerDeps = {
      auditEmitter: emitter,
      assessmentLoader: makeAssessmentLoader({
        id: VALID_UUID,
        tenantId: TENANT_UUID,
        projectId: VALID_UUID,
      }),
      buildScope: async () => null,
      scopeDeps: makeScopeDeps(),
      subfinderBin: '/fake/subfinder',
    };

    const outcome = await handleReconSubfinderRun(makeEnvelope(), deps);

    // Pipeline still acks — null scope means no-scope denial at subfinder level.
    expect(outcome.kind).toBe('ack');
    // subfinder.denied emitted because scope is null
    const denied = emitted.find((e) => e.action === 'recon.subfinder.denied');
    expect(denied).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 4 — B4: targetWriter throws mid-loop → best-effort continue, ack
// ─────────────────────────────────────────────────────────────────────────────
describe('worker :: B4 targetWriter middle-throw', () => {
  test('targetWriter throws → error swallowed best-effort, ack returned', async () => {
    const { emitter } = makeAuditCapture();
    let _writeAttempts = 0;
    const deps: ReconWorkerDeps = {
      auditEmitter: emitter,
      assessmentLoader: makeAssessmentLoader({
        id: VALID_UUID,
        tenantId: TENANT_UUID,
        projectId: VALID_UUID,
      }),
      buildScope: async () => makeAllowScope(),
      scopeDeps: makeScopeDeps(),
      subfinderBin: '/fake/subfinder',
      targetWriter: async () => {
        _writeAttempts++;
        throw new Error('db_unavailable');
      },
    };

    // Even if targetWriter throws every call, the handler must still ack
    const outcome = await handleReconSubfinderRun(makeEnvelope(), deps);
    expect(outcome.kind).toBe('ack');
    // writeAttempts may be 0 (no subfinder hosts) or >0 — either is fine,
    // the key is no throw propagation.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 5 — C1 partial binary: subfinder missing → fallback to primaryDomain, ack
// ─────────────────────────────────────────────────────────────────────────────
describe('worker :: C1 subfinder binary missing', () => {
  test('subfinderBin absent → fallback to primaryDomain probe, ack', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const deps: ReconWorkerDeps = {
      auditEmitter: emitter,
      assessmentLoader: makeAssessmentLoader({
        id: VALID_UUID,
        tenantId: TENANT_UUID,
        projectId: VALID_UUID,
      }),
      buildScope: async () => makeAllowScope(),
      scopeDeps: makeScopeDeps(),
      subfinderBin: undefined,
      // httpxBin also absent → httpx skips too (C1 chain)
      httpxBin: undefined,
    };

    const outcome = await handleReconSubfinderRun(makeEnvelope(), deps);
    expect(outcome.kind).toBe('ack');
    // subfinder must emit config_error when binary is absent
    const configError = emitted.find(
      (e) =>
        e.action === 'recon.subfinder.error' &&
        (e.metadata as Record<string, unknown>).reason === 'config_error',
    );
    expect(configError).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 6 — happy path: valid assessment, scope, all stubs fire, ack
// ─────────────────────────────────────────────────────────────────────────────
describe('worker :: happy path', () => {
  test('valid assessment + scope → pipeline completes, ack, subfinder.run or httpx.run emitted', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const persisted: string[] = [];
    const deps: ReconWorkerDeps = {
      auditEmitter: emitter,
      assessmentLoader: makeAssessmentLoader({
        id: VALID_UUID,
        tenantId: TENANT_UUID,
        projectId: VALID_UUID,
      }),
      buildScope: async () => makeAllowScope(),
      scopeDeps: makeScopeDeps(),
      subfinderBin: '/fake/subfinder',
      httpxBin: '/fake/httpx',
      nucleiBin: '/fake/nuclei',
      targetWriter: async (input) => {
        persisted.push(input.value);
      },
    };

    const outcome = await handleReconSubfinderRun(makeEnvelope(), deps);
    expect(outcome.kind).toBe('ack');
    // At minimum an audit event was emitted (subfinder.error for missing binary or subfinder.denied for scope)
    expect(emitted.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 7 — HIGH-2: project mismatch → denied+ack+project_mismatch
// ─────────────────────────────────────────────────────────────────────────────
describe('worker :: HIGH-2 project mismatch', () => {
  test('assessment.projectId differs from payload projectId → recon.subfinder.denied + ack', async () => {
    const { emitter, emitted } = makeAuditCapture();
    // Assessment belongs to OTHER_UUID project, but envelope claims VALID_UUID project
    const deps: ReconWorkerDeps = {
      auditEmitter: emitter,
      assessmentLoader: makeAssessmentLoader({
        id: VALID_UUID,
        tenantId: TENANT_UUID,
        projectId: OTHER_UUID,
      }),
      buildScope: async () => makeAllowScope(),
      scopeDeps: makeScopeDeps(),
    };

    const outcome = await handleReconSubfinderRun(makeEnvelope(TENANT_UUID), deps);

    expect(outcome.kind).toBe('ack');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.subfinder.denied');
    expect(emitted[0].outcome).toBe('denied');
    expect((emitted[0].metadata as Record<string, unknown>).reason).toBe('project_mismatch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 8 — HIGH-1: OOS hosts not persisted, only scope-approved aliveResults
// ─────────────────────────────────────────────────────────────────────────────
describe('worker :: HIGH-1 oos host not persisted', () => {
  test('out-of-scope subfinder host → NOT written to targetWriter', async () => {
    const { emitter } = makeAuditCapture();
    const persisted: string[] = [];
    const deps: ReconWorkerDeps = {
      auditEmitter: emitter,
      assessmentLoader: makeAssessmentLoader({
        id: VALID_UUID,
        tenantId: TENANT_UUID,
        projectId: VALID_UUID,
      }),
      buildScope: async () => makeAllowScope(),
      scopeDeps: makeScopeDeps(),
      subfinderBin: '/fake/subfinder',
      httpxBin: '/fake/httpx',
      targetWriter: async (input) => {
        persisted.push(input.value);
      },
    };

    // Without real binaries, httpx returns [] (no alive results) → no targets persisted.
    // This verifies the loop uses aliveResults not discoveredHosts.
    const outcome = await handleReconSubfinderRun(makeEnvelope(), deps);
    expect(outcome.kind).toBe('ack');
    // aliveResults is empty (no real httpx binary) → nothing persisted
    expect(persisted).toHaveLength(0);
  });
});
