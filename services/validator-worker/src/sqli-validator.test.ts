// Unit tests for SQLi replay validator.
//
// T1 — happy path: 200+accessToken positive, 401 baseline → confirmed.
// T2 — DB error markers in body → confirmed (no baseline).
// T3 — out-of-scope: decide() denies → out_of_scope, no fetch attempted.
// T4 — fetch_failed: httpFetcher throws → fetch_failed, reason populated.
// T5 — unmatched: 200 + normal body, no SQL signatures → unmatched.
// T6 — baseline length parity: positive ≈ baseline body length → unmatched
//      (even with weak hits — no real bypass).
// T7 — stub-injection ZFP: positive AND baseline both contain accessToken
//      (truly authed endpoint, not injection) → unmatched.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import {
  type HttpReplayRequest,
  type HttpReplayResponse,
  validateSqliCandidate,
} from './sqli-validator.ts';
import type { AuditEmitterArgs } from './worker.ts';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_TRACE = '0123456789abcdef0123456789abcdef';
const TARGET_URL = 'http://target.lab.example/rest/user/login';

// ---- Audit emitter stub --------------------------------------------------

const makeAuditEmitter = (): {
  emitter: (args: AuditEmitterArgs) => Promise<void>;
  emitted: AuditEmitterArgs[];
} => {
  const emitted: AuditEmitterArgs[] = [];
  const emitter = async (args: AuditEmitterArgs): Promise<void> => {
    emitted.push(args);
  };
  return { emitter, emitted };
};

// ---- Scope-deps stubs ----------------------------------------------------

const makeAllowScopeDeps = () => ({
  dns: {
    resolveA: async (_host: string): Promise<string[]> => ['203.0.113.42'],
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

const makeDenyScopeDeps = () => ({
  dns: {
    resolveA: async (_host: string): Promise<string[]> => [],
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

// ---- EffectiveScope fixtures --------------------------------------------

const TOOL_CATALOG = new Map<string, ToolPolicy>();
const SCOPE_BASE = {
  tenantId: VALID_UUID,
  assessmentId: VALID_UUID,
  tenantPolicy: { tenantId: VALID_UUID },
  platformPolicy: DEFAULT_PLATFORM_POLICY,
  toolCatalog: TOOL_CATALOG,
  assessmentFlags: { highImpactCategories: [], ownershipVerifiedTargetIds: new Set<string>() },
  timeWindow: null,
} as const;

const makeDenyScope = (): EffectiveScope => buildEffectiveScope({ ...SCOPE_BASE, rawRules: [] });

const makeAllowScope = (): EffectiveScope =>
  buildEffectiveScope({
    ...SCOPE_BASE,
    rawRules: [
      {
        id: 'r1',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'target.lab.example', matchSubdomains: false },
      },
      { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
      { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
      { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'POST' } },
      { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
    ],
  });

// ---- Input factory ------------------------------------------------------

const makeInput = (overrides: Partial<Parameters<typeof validateSqliCandidate>[0]> = {}) => ({
  tenantId: VALID_UUID,
  projectId: null,
  assessmentId: VALID_UUID,
  candidateFindingId: VALID_UUID,
  affectedUrl: TARGET_URL,
  method: 'POST' as const,
  payloadBody: '{"email":"\' OR 1=1--","password":"x"}',
  contentType: 'application/json',
  traceId: VALID_TRACE,
  ...overrides,
});

// ---- HTTP fetcher stubs --------------------------------------------------

type FetcherCall = HttpReplayRequest;
const makeFetcher = (
  responder: (req: HttpReplayRequest, callIndex: number) => HttpReplayResponse | Error,
) => {
  const calls: FetcherCall[] = [];
  const fetcher = async (req: HttpReplayRequest): Promise<HttpReplayResponse> => {
    const idx = calls.length;
    calls.push(req);
    const out = responder(req, idx);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetcher, calls };
};

// =========================================================================

describe('sqli-validator :: T1 happy path (JWT issued on injection, 401 baseline)', () => {
  test('positive 200+accessToken, baseline 401 → confirmed', async () => {
    const { emitter, emitted } = makeAuditEmitter();
    const { fetcher, calls } = makeFetcher((_req, idx) => {
      if (idx === 0) {
        return {
          status: 200,
          body: JSON.stringify({
            authentication: {
              token: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.signature',
            },
          }),
        };
      }
      return { status: 401, body: '{"error":"invalid_credentials"}' };
    });

    const result = await validateSqliCandidate(
      makeInput({ baselineBody: '{"email":"x@x","password":"x"}' }),
      {
        scope: makeAllowScope(),
        scopeDeps: makeAllowScopeDeps(),
        httpFetcher: fetcher,
        clock: () => new Date(),
        auditEmitter: emitter,
      },
    );

    expect(result.status).toBe('confirmed');
    expect(result.evidence?.signalHits.length).toBeGreaterThanOrEqual(1);
    expect(result.evidence?.responseStatus).toBe(200);
    expect(result.evidence?.baselineStatus).toBe(401);
    expect(calls.length).toBe(2);
    const confirmed = emitted.find((e) => e.action === 'validator.sqli.confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed?.outcome).toBe('success');
  });
});

describe('sqli-validator :: T2 DB error markers', () => {
  test('response contains "error in your SQL syntax" → confirmed (no baseline)', async () => {
    const { emitter, emitted } = makeAuditEmitter();
    const { fetcher } = makeFetcher(() => ({
      status: 500,
      body: 'You have an error in your SQL syntax near line 1',
    }));

    const result = await validateSqliCandidate(makeInput(), {
      scope: makeAllowScope(),
      scopeDeps: makeAllowScopeDeps(),
      httpFetcher: fetcher,
      clock: () => new Date(),
      auditEmitter: emitter,
    });

    expect(result.status).toBe('confirmed');
    expect(result.evidence?.signalHits).toContain('db_error_mysql_syntax');
    expect(emitted.some((e) => e.action === 'validator.sqli.confirmed')).toBe(true);
  });
});

describe('sqli-validator :: T3 out-of-scope', () => {
  test('scope.decide denies → out_of_scope, no fetch attempted', async () => {
    const { emitter, emitted } = makeAuditEmitter();
    let fetchCount = 0;
    const fetcher = async (): Promise<HttpReplayResponse> => {
      fetchCount++;
      return { status: 200, body: '' };
    };

    const result = await validateSqliCandidate(makeInput(), {
      scope: makeDenyScope(),
      scopeDeps: makeDenyScopeDeps(),
      httpFetcher: fetcher,
      clock: () => new Date(),
      auditEmitter: emitter,
    });

    expect(result.status).toBe('out_of_scope');
    expect(fetchCount).toBe(0);
    const denied = emitted.find((e) => e.action === 'validator.sqli.replay_denied');
    expect(denied).toBeDefined();
    expect(denied?.outcome).toBe('denied');
  });
});

describe('sqli-validator :: T4 fetch_failed', () => {
  test('httpFetcher throws → fetch_failed with reason populated', async () => {
    const { emitter, emitted } = makeAuditEmitter();
    const { fetcher } = makeFetcher(() => new Error('ECONNREFUSED 127.0.0.1:80'));

    const result = await validateSqliCandidate(makeInput(), {
      scope: makeAllowScope(),
      scopeDeps: makeAllowScopeDeps(),
      httpFetcher: fetcher,
      clock: () => new Date(),
      auditEmitter: emitter,
    });

    expect(result.status).toBe('fetch_failed');
    expect(result.reason).toContain('ECONNREFUSED');
    const failed = emitted.find((e) => e.action === 'validator.sqli.fetch_failed');
    expect(failed).toBeDefined();
    expect(failed?.outcome).toBe('denied');
  });
});

describe('sqli-validator :: T5 unmatched (clean response)', () => {
  test('200 + normal body with no SQL signatures → unmatched', async () => {
    const { emitter, emitted } = makeAuditEmitter();
    const { fetcher } = makeFetcher(() => ({
      status: 200,
      body: '{"status":"ok","message":"see catalog"}',
    }));

    const result = await validateSqliCandidate(makeInput(), {
      scope: makeAllowScope(),
      scopeDeps: makeAllowScopeDeps(),
      httpFetcher: fetcher,
      clock: () => new Date(),
      auditEmitter: emitter,
    });

    expect(result.status).toBe('unmatched');
    expect(result.evidence?.signalHits.length).toBe(0);
    expect(emitted.some((e) => e.action === 'validator.sqli.unmatched')).toBe(true);
  });
});

describe('sqli-validator :: T6 baseline length parity (no real bypass)', () => {
  test('positive body ≈ baseline length, weak hits → unmatched', async () => {
    const { emitter } = makeAuditEmitter();
    // Both responses contain a DB error marker AND similar length — likely a
    // generic error page that always fires that marker (not a true bypass).
    const sharedBody =
      'Server Error: We have an error in your SQL syntax. Contact administrator. Code 500. ';
    // Positive has the marker, baseline lacks it but is same length → distinct
    // signal hits but length parity says no real divergence.
    const positiveBody = sharedBody + 'extra padding to keep it close enough.';
    const baselineBody = `Server Error: a generic problem occurred. Contact administrator. Code 500. extra padding to keep it close enough!`;
    expect(Math.abs(positiveBody.length - baselineBody.length)).toBeLessThan(10);

    const { fetcher } = makeFetcher((_req, idx) =>
      idx === 0
        ? { status: 500, body: positiveBody }
        : { status: 500, body: baselineBody },
    );

    const result = await validateSqliCandidate(
      makeInput({ baselineBody: '{"email":"x@x","password":"x"}' }),
      {
        scope: makeAllowScope(),
        scopeDeps: makeAllowScopeDeps(),
        httpFetcher: fetcher,
        clock: () => new Date(),
        auditEmitter: emitter,
      },
    );

    expect(result.status).toBe('unmatched');
    // Hit was present on positive but length parity guard nullified it.
    expect(result.evidence?.signalHits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('sqli-validator :: T7 stub-injection ZFP (baseline also has token)', () => {
  test('positive AND baseline both contain accessToken → unmatched', async () => {
    const { emitter, emitted } = makeAuditEmitter();
    // Both calls return a JWT — endpoint is truly authed (e.g. test account),
    // not an injection bypass. Pure stub-injection zero-false-positive guard.
    const tokenBody = JSON.stringify({
      authentication: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.sig' },
    });

    const { fetcher } = makeFetcher(() => ({ status: 200, body: tokenBody }));

    const result = await validateSqliCandidate(
      makeInput({ baselineBody: '{"email":"valid@x","password":"valid"}' }),
      {
        scope: makeAllowScope(),
        scopeDeps: makeAllowScopeDeps(),
        httpFetcher: fetcher,
        clock: () => new Date(),
        auditEmitter: emitter,
      },
    );

    expect(result.status).toBe('unmatched');
    expect(result.evidence?.signalHits.length).toBeGreaterThanOrEqual(1);
    const unmatched = emitted.find((e) => e.action === 'validator.sqli.unmatched');
    expect(unmatched).toBeDefined();
  });
});
