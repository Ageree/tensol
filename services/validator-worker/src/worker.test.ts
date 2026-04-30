import { describe, expect, test } from 'bun:test';
import type { JobEnvelope } from '@cyberstrike/queue';
import {
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import {
  BrowserReplayTimeoutError,
  type XssReplayDriver,
  type XssReplayInput,
  type XssReplayResult,
} from '@cyberstrike/validators';
import { validateFindingPayloadSchema } from './payload-schema.ts';
import {
  type AuditEmitter,
  type AuditEmitterArgs,
  type CandidateRow,
  type ValidatorWorkerDeps,
  handleSsrfReplay,
  handleValidateFinding,
} from './worker.ts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSESS = '22222222-2222-2222-2222-222222222222';
const CANDIDATE = '33333333-3333-3333-3333-333333333333';
const TRACE = '0123456789abcdef0123456789abcdef';
const FINDING = '99999999-9999-9999-9999-999999999999';

const validPayload = {
  tenantId: TENANT,
  projectId: null,
  assessmentId: ASSESS,
  candidateFindingId: CANDIDATE,
  candidateType: 'xss_reflected' as const,
  traceId: TRACE,
};

const buildEnvelope = (kindPayload: unknown = validPayload): JobEnvelope => ({
  jobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  tenantId: TENANT,
  projectId: null,
  assessmentId: ASSESS,
  kind: 'validate.finding',
  idempotencyKey: 'idem',
  createdAt: '2026-04-29T00:00:00.000Z',
  attempt: 0,
  maxAttempts: 3,
  traceId: TRACE,
  payload: kindPayload,
});

const reflectingDriver = (results: ReadonlyArray<Partial<XssReplayResult>>): XssReplayDriver => {
  let i = 0;
  return {
    replay: async (_input: XssReplayInput): Promise<XssReplayResult> => {
      const r = results[i] ?? {};
      i++;
      return {
        finalUrl: 'http://localhost/search',
        httpStatus: 200,
        domContainsNonce: false,
        consoleNonceHits: [],
        alertDispatched: false,
        networkRequestsFromScript: [],
        screenshot: new Uint8Array([1, 2, 3]),
        trace: new Uint8Array([4, 5]),
        capturedAt: '2026-04-29T00:00:00.000Z',
        ...r,
      };
    },
  };
};

const buildAllowLocalhost = async (): Promise<EffectiveScope> =>
  buildEffectiveScope({
    tenantId: TENANT,
    assessmentId: ASSESS,
    tenantPolicy: { tenantId: TENANT },
    platformPolicy: DEFAULT_PLATFORM_POLICY,
    rawRules: [
      {
        id: 'r1',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'localhost', matchSubdomains: false },
      },
      { id: 'r2', ruleKind: 'ip', effect: 'allow', payload: { ip: '203.0.113.7' } },
      { id: 'r3', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
      { id: 'r4', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
      { id: 'r5', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
      { id: 'r6', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
    ],
    toolCatalog: new Map<string, ToolPolicy>(),
    assessmentFlags: {
      highImpactCategories: [],
      ownershipVerifiedTargetIds: new Set([TENANT]),
    },
    timeWindow: null,
  });

const stubScopeDeps = {
  dns: {
    resolveA: async (): Promise<string[]> => ['203.0.113.7'],
    resolveAAAA: async (): Promise<string[]> => [],
  },
  clock: { now: (): Date => new Date() },
  rateLimit: {
    consume: async (): Promise<{ ok: true; retryAfterMs: number }> => ({
      ok: true,
      retryAfterMs: 0,
    }),
  },
};

interface Recorder {
  audits: AuditEmitterArgs[];
  findingsInserts: number;
  evidenceInserts: number;
  storagePuts: number;
}

const buildDeps = async (
  override: Partial<ValidatorWorkerDeps> = {},
  recorder?: Recorder,
): Promise<{ deps: ValidatorWorkerDeps; recorder: Recorder }> => {
  const r: Recorder = recorder ?? {
    audits: [],
    findingsInserts: 0,
    evidenceInserts: 0,
    storagePuts: 0,
  };
  const auditEmitter: AuditEmitter = async (args): Promise<void> => {
    r.audits.push(args);
  };
  const candidate: CandidateRow = {
    id: CANDIDATE,
    tenantId: TENANT,
    assessmentId: ASSESS,
    type: 'xss_reflected',
    severity: 'medium',
    affectedUrl: 'http://localhost/search?q=existing',
    source: 'fake-decepticon',
    payload: { sample: 1 },
  };
  const scope = await buildAllowLocalhost();
  const deps: ValidatorWorkerDeps = {
    driver: reflectingDriver([
      { domContainsNonce: true, consoleNonceHits: ['x'] },
      { domContainsNonce: true, consoleNonceHits: ['x'] },
    ]),
    objectStorage: {
      put: async ({
        key,
        body,
        contentType,
      }): Promise<{
        key: string;
        sha256: string;
        sizeBytes: number;
        contentType: string;
      }> => {
        r.storagePuts += 1;
        const buf = body instanceof Uint8Array ? body : Buffer.from(String(body));
        return {
          key,
          sha256: 'a'.repeat(64),
          sizeBytes: buf.byteLength,
          contentType,
        };
      },
      get: async (): Promise<Buffer> => Buffer.from([0]),
    },
    buildScope: async (): Promise<EffectiveScope> => scope,
    scopeDeps: stubScopeDeps,
    auditEmitter,
    candidateLoader: async (): Promise<CandidateRow | null> => candidate,
    assessmentLoader: async (): Promise<{
      id: string;
      tenantId: string;
      projectId: string | null;
    }> => ({
      id: ASSESS,
      tenantId: TENANT,
      projectId: null,
    }),
    findingsWriter: async (): Promise<{ id: string }> => {
      r.findingsInserts += 1;
      return { id: FINDING };
    },
    findingEvidenceWriter: async (): Promise<{ id: string }> => {
      r.evidenceInserts += 1;
      return { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' };
    },
    findingByCandidateLoader: async (): Promise<{ id: string } | null> => null,
    evidenceCounter: async (): Promise<number> => 0,
    findingCreatedAuditChecker: async (): Promise<boolean> => false,
    payloadSchema: validateFindingPayloadSchema,
    ...override,
  };
  return { deps, recorder: r };
};

describe('validator-worker :: handleValidateFinding', () => {
  test('confirmed → calls findingsWriter once + 3 audits (started/confirmed/finding.created) + ack', async () => {
    const { deps, recorder } = await buildDeps();
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('ack');
    expect(recorder.findingsInserts).toBe(1);
    const actions = recorder.audits.map((a) => a.action);
    expect(actions).toEqual(['validation.started', 'validation.confirmed', 'finding.created']);
    // Two replay runs × 2 evidence kinds = 4 evidence rows.
    expect(recorder.evidenceInserts).toBe(4);
    expect(recorder.storagePuts).toBe(4);
  });

  test('rejected → no findings insert + validation.rejected audit + ack', async () => {
    const { deps, recorder } = await buildDeps({
      driver: reflectingDriver([{}, {}]),
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('ack');
    expect(recorder.findingsInserts).toBe(0);
    expect(recorder.evidenceInserts).toBe(0);
    const actions = recorder.audits.map((a) => a.action);
    expect(actions).toEqual(['validation.started', 'validation.rejected']);
  });

  test('inconclusive (alert-only origin) → no findings insert + validation.inconclusive audit + ack', async () => {
    const { deps, recorder } = await buildDeps({
      driver: reflectingDriver([{ alertDispatched: true }, { alertDispatched: true }]),
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('ack');
    expect(recorder.findingsInserts).toBe(0);
    const last = recorder.audits[recorder.audits.length - 1];
    expect(last?.action).toBe('validation.inconclusive');
    expect((last?.metadata as { reason: string }).reason).toBe('alert_only_weak_proof');
  });

  test('inconclusive (timeout origin via BrowserReplayTimeoutError) → no findings insert + audit metadata.reason=timeout + ack [A-V-Hang worker half]', async () => {
    const driver: XssReplayDriver = {
      replay: async (): Promise<XssReplayResult> => {
        throw new BrowserReplayTimeoutError('hang');
      },
    };
    const { deps, recorder } = await buildDeps({ driver });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('ack');
    expect(recorder.findingsInserts).toBe(0);
    const last = recorder.audits[recorder.audits.length - 1];
    expect(last?.action).toBe('validation.inconclusive');
    expect((last?.metadata as { reason: string }).reason).toBe('timeout');
  });

  test('out_of_scope → no driver call + validation.out_of_scope audit + ack', async () => {
    let driverCalls = 0;
    const driver: XssReplayDriver = {
      replay: async (): Promise<XssReplayResult> => {
        driverCalls += 1;
        throw new Error('should_not_be_called');
      },
    };
    const { deps, recorder } = await buildDeps({
      driver,
      buildScope: async (): Promise<null> => null, // null scope → out_of_scope
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('ack');
    expect(driverCalls).toBe(0);
    expect(recorder.findingsInserts).toBe(0);
    const last = recorder.audits[recorder.audits.length - 1];
    expect(last?.action).toBe('validation.out_of_scope');
    expect(last?.outcome).toBe('denied');
  });

  test('duplicate-key + evidence missing + audit missing → repairs both, emits finding.created, ack [iter-2 P1]', async () => {
    let evidenceRowsForExisting = 0;
    let findingCreatedAuditExists = false;
    const { deps, recorder } = await buildDeps({
      findingsWriter: async (): Promise<never> => {
        throw new Error(
          'duplicate key value violates unique constraint "findings_created_from_candidate_id_key"',
        );
      },
      findingByCandidateLoader: async (): Promise<{ id: string }> => ({
        id: 'eeee0000-eeee-eeee-eeee-eeeeeeeeeeee',
      }),
      evidenceCounter: async (): Promise<number> => evidenceRowsForExisting,
      findingEvidenceWriter: async (): Promise<{ id: string }> => {
        evidenceRowsForExisting += 1;
        return { id: 'evidence-row' };
      },
      findingCreatedAuditChecker: async (): Promise<boolean> => findingCreatedAuditExists,
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('ack');
    expect(recorder.findingsInserts).toBe(0);
    // 2 runs × 2 kinds = 4 evidence rows persisted via the repair path.
    expect(evidenceRowsForExisting).toBe(4);
    // Audit ordering: started → finding.created (repair) → confirmed (loser).
    const actions = recorder.audits.map((a) => a.action);
    expect(actions).toContain('finding.created');
    expect(actions[actions.length - 1]).toBe('validation.confirmed');
    const last = recorder.audits[recorder.audits.length - 1];
    expect((last?.metadata as Record<string, unknown>).idempotentLoser).toBe(true);
    expect((last?.metadata as Record<string, unknown>).evidenceRepaired).toBe(true);
    expect((last?.metadata as Record<string, unknown>).findingCreatedAuditEmitted).toBe(true);
    expect((last?.metadata as Record<string, unknown>).findingId).toBe(
      'eeee0000-eeee-eeee-eeee-eeeeeeeeeeee',
    );
    findingCreatedAuditExists = true; // appease unused-binding lint
  });

  test('duplicate-key + evidence already present + audit already emitted → ack with no repair [iter-2 P1]', async () => {
    let evidenceWritesAttempted = 0;
    const { deps, recorder } = await buildDeps({
      findingsWriter: async (): Promise<never> => {
        throw new Error('duplicate key value violates unique constraint');
      },
      findingByCandidateLoader: async (): Promise<{ id: string }> => ({
        id: 'eeee0000-eeee-eeee-eeee-eeeeeeeeeeee',
      }),
      evidenceCounter: async (): Promise<number> => 4, // already populated
      findingEvidenceWriter: async (): Promise<{ id: string }> => {
        evidenceWritesAttempted += 1;
        return { id: 'should-not-happen' };
      },
      findingCreatedAuditChecker: async (): Promise<boolean> => true, // already emitted
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('ack');
    expect(evidenceWritesAttempted).toBe(0);
    const actions = recorder.audits.map((a) => a.action);
    expect(actions).not.toContain('finding.created');
    const last = recorder.audits[recorder.audits.length - 1];
    expect((last?.metadata as Record<string, unknown>).idempotentLoser).toBe(true);
    expect((last?.metadata as Record<string, unknown>).evidenceRepaired).toBe(false);
    expect((last?.metadata as Record<string, unknown>).findingCreatedAuditEmitted).toBe(false);
  });

  test('duplicate-key + existing finding row missing → transient nack [iter-2 P1]', async () => {
    const { deps } = await buildDeps({
      findingsWriter: async (): Promise<never> => {
        throw new Error('duplicate key value violates unique constraint');
      },
      findingByCandidateLoader: async (): Promise<null> => null,
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('nack');
    if (out.kind === 'nack') {
      expect((out.error as { __terminal?: boolean }).__terminal).not.toBe(true);
      expect(out.error.message).toContain('idempotent_loser_existing_finding_not_found');
    }
  });

  test('duplicate-key + evidence-repair throws → transient nack [iter-2 P1]', async () => {
    const { deps } = await buildDeps({
      findingsWriter: async (): Promise<never> => {
        throw new Error('duplicate key value violates unique constraint');
      },
      findingByCandidateLoader: async (): Promise<{ id: string }> => ({
        id: 'eeee0000-eeee-eeee-eeee-eeeeeeeeeeee',
      }),
      evidenceCounter: async (): Promise<number> => 0,
      findingEvidenceWriter: async (): Promise<never> => {
        throw new Error('storage_blip');
      },
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('nack');
    if (out.kind === 'nack') {
      expect((out.error as { __terminal?: boolean }).__terminal).not.toBe(true);
    }
  });

  test('duplicate-key (legacy assertion preserved): no new findings row written', async () => {
    const { deps, recorder } = await buildDeps({
      findingsWriter: async (): Promise<never> => {
        throw new Error(
          'duplicate key value violates unique constraint "findings_created_from_candidate_id_key"',
        );
      },
      findingByCandidateLoader: async (): Promise<{ id: string }> => ({
        id: 'eeee0000-eeee-eeee-eeee-eeeeeeeeeeee',
      }),
      evidenceCounter: async (): Promise<number> => 4,
      findingCreatedAuditChecker: async (): Promise<boolean> => true,
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('ack');
    expect(recorder.findingsInserts).toBe(0);
    const last = recorder.audits[recorder.audits.length - 1];
    expect(last?.action).toBe('validation.confirmed');
    expect((last?.metadata as { idempotentLoser: boolean }).idempotentLoser).toBe(true);
  });

  test('candidate not found → terminal nack', async () => {
    const { deps } = await buildDeps({
      candidateLoader: async (): Promise<null> => null,
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('nack');
    if (out.kind === 'nack') {
      expect(out.error.message).toContain('candidate_not_found');
    }
  });

  test('assessment not found → terminal nack', async () => {
    const { deps } = await buildDeps({
      assessmentLoader: async (): Promise<null> => null,
    });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('nack');
    if (out.kind === 'nack') {
      expect(out.error.message).toContain('assessment_not_found');
    }
  });

  test('driver throws non-timeout Error → transient nack (NOT terminal)', async () => {
    const driver: XssReplayDriver = {
      replay: async (): Promise<XssReplayResult> => {
        throw new Error('generic_failure');
      },
    };
    const { deps } = await buildDeps({ driver });
    const out = await handleValidateFinding(deps, buildEnvelope());
    expect(out.kind).toBe('nack');
    if (out.kind === 'nack') {
      // Non-timeout, non-ScopeDenyError → no `__terminal:true` flag → transient.
      expect((out.error as { __terminal?: boolean }).__terminal).not.toBe(true);
      expect(out.error.message).toBe('generic_failure');
    }
  });

  test('invalid payload → terminal nack', async () => {
    const { deps } = await buildDeps();
    const out = await handleValidateFinding(deps, buildEnvelope({ malformed: true }));
    expect(out.kind).toBe('nack');
  });
});

const SSRF_CANDIDATE = '44444444-4444-4444-4444-444444444444';
const SSRF_TOKEN = `${SSRF_CANDIDATE}.${TENANT}.abcd1234`;

const buildSsrfEnvelope = (): JobEnvelope => ({
  jobId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  tenantId: TENANT,
  projectId: null,
  assessmentId: ASSESS,
  kind: 'validator.ssrf.replay',
  idempotencyKey: 'ssrf-idem',
  createdAt: '2026-04-29T00:00:00.000Z',
  attempt: 0,
  maxAttempts: 3,
  traceId: TRACE,
  payload: {
    tenantId: TENANT,
    projectId: null,
    assessmentId: ASSESS,
    candidateFindingId: SSRF_CANDIDATE,
    candidateType: 'ssrf',
    replayUrl: `http://ssrf.lab.example/redirect?_cs_token=${SSRF_TOKEN}`,
    token: SSRF_TOKEN,
    traceId: TRACE,
  },
});

const buildSsrfDeps = (override: Partial<ValidatorWorkerDeps> = {}): ValidatorWorkerDeps => {
  const audits: AuditEmitterArgs[] = [];
  const auditEmitter: AuditEmitter = async (args): Promise<void> => {
    audits.push(args);
  };
  const ssrfCandidate: CandidateRow = {
    id: SSRF_CANDIDATE,
    tenantId: TENANT,
    assessmentId: ASSESS,
    type: 'ssrf',
    severity: 'high',
    affectedUrl: 'http://ssrf.lab.example/redirect',
    source: 'fake-decepticon',
    payload: {},
  };
  return {
    driver: { replay: async () => ({ attempt: 0 }) } as unknown as ValidatorWorkerDeps['driver'],
    objectStorage: {
      put: async () => ({ key: '', sha256: '', sizeBytes: 0, contentType: '' }),
      get: async () => Buffer.from([]),
    },
    buildScope: async () => null,
    scopeDeps: stubScopeDeps,
    auditEmitter,
    candidateLoader: async () => ssrfCandidate,
    assessmentLoader: async () => ({ id: ASSESS, tenantId: TENANT, projectId: null }),
    findingsWriter: async () => ({ id: 'f1' }),
    findingEvidenceWriter: async () => ({ id: 'e1' }),
    findingByCandidateLoader: async () => null,
    evidenceCounter: async () => 0,
    findingCreatedAuditChecker: async () => false,
    payloadSchema: validateFindingPayloadSchema,
    ssrfHttpClient: { callCount: 0, get: async () => {} },
    oobCallbackLoader: async () => false,
    _auditStore: audits,
    ...override,
  } as unknown as ValidatorWorkerDeps;
};

describe('validator-worker :: handleSsrfReplay', () => {
  test('null buildScope() → ssrf.replay_denied audit + terminal ack (no_scope)', async () => {
    const audits: AuditEmitterArgs[] = [];
    const deps = buildSsrfDeps({
      buildScope: async () => null,
      auditEmitter: async (args) => {
        audits.push(args);
      },
    });
    const out = await handleSsrfReplay(deps, buildSsrfEnvelope());
    expect(out.kind).toBe('ack');
    const denied = audits.find((a) => a.action === 'validator.ssrf.replay_denied');
    expect(denied).toBeDefined();
    expect((denied?.metadata as { reason: string }).reason).toBe('no_scope');
  });

  test('missing ssrfHttpClient → nack with config_error audit', async () => {
    const audits: AuditEmitterArgs[] = [];
    const deps = buildSsrfDeps({
      ssrfHttpClient: undefined,
      auditEmitter: async (args) => {
        audits.push(args);
      },
    });
    const out = await handleSsrfReplay(deps, buildSsrfEnvelope());
    expect(out.kind).toBe('nack');
    const configErr = audits.find((a) => a.action === 'validation.inconclusive');
    expect((configErr?.metadata as { reason: string }).reason).toBe('config_error');
  });

  test('ssrf candidate type mismatch → nack', async () => {
    const deps = buildSsrfDeps({
      candidateLoader: async () => ({
        id: SSRF_CANDIDATE,
        tenantId: TENANT,
        assessmentId: ASSESS,
        type: 'xss_reflected',
        severity: 'medium' as const,
        affectedUrl: 'http://ssrf.lab.example/redirect',
        source: 'fake',
        payload: {},
      }),
    });
    const out = await handleSsrfReplay(deps, buildSsrfEnvelope());
    expect(out.kind).toBe('nack');
    if (out.kind === 'nack') {
      expect(out.error.message).toContain('ssrf_candidate_not_found');
    }
  });
});
