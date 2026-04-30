// Sprint 18 — Unit tests for SSRF replay validator.
//
// (a) Scope deny path: decide returns allowed=false → out_of_scope, replay_denied audit,
//     httpClient.callCount === 0 (no network egress).
// (b) Confirmed path: scope passes, oobCallbackLoader returns true → confirmed.
// (c) Timeout path: scope passes, oobCallbackLoader always false → inconclusive/timeout.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { validateSsrfCandidate } from './ssrf-validator.ts';
import type { AuditEmitterArgs } from './worker.ts';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_TRACE = '0123456789abcdef0123456789abcdef';
const VALID_TOKEN = `${VALID_UUID}.${VALID_UUID}.deadbeef`;
const REPLAY_URL = 'http://oob.lab.example/callback';

const makeAuditEmitter = (): {
  emitter: ReturnType<typeof buildAuditEmitter>;
  emitted: AuditEmitterArgs[];
} => {
  const emitted: AuditEmitterArgs[] = [];
  const emitter = async (args: AuditEmitterArgs): Promise<void> => {
    emitted.push(args);
  };
  return { emitter, emitted };
};

const buildAuditEmitter =
  () =>
  async (_args: AuditEmitterArgs): Promise<void> => {};

// Stub scopeDeps for the allow path — resolves to a public IP so no loopback/private guard fires.
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

// Scope that denies: empty allow rules + deny-by-default means no_matching_allow_rule.
const makeDenyScope = (): EffectiveScope => buildEffectiveScope({ ...SCOPE_BASE, rawRules: [] });

// Scope that allows oob.lab.example:80 HTTP GET (for confirmed/timeout paths).
const makeAllowScope = (): EffectiveScope =>
  buildEffectiveScope({
    ...SCOPE_BASE,
    rawRules: [
      {
        id: 'r1',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'oob.lab.example', matchSubdomains: false },
      },
      { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
      { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
      { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
      { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
    ],
  });

const makeInput = (replayUrl = REPLAY_URL, scope: EffectiveScope = makeDenyScope()) => ({
  candidateFindingId: VALID_UUID,
  tenantId: VALID_UUID,
  assessmentId: VALID_UUID,
  projectId: null,
  replayUrl,
  token: VALID_TOKEN,
  scope,
  traceId: VALID_TRACE,
});

class TrackingHttpClient {
  callCount = 0;
  async get(_url: string): Promise<void> {
    this.callCount++;
  }
}

describe('ssrf-validator :: scope deny path (R4)', () => {
  test('out-of-scope → replay_denied audit emitted, httpClient.callCount === 0', async () => {
    const { emitter, emitted } = makeAuditEmitter();
    const httpClient = new TrackingHttpClient();

    const result = await validateSsrfCandidate(makeInput(REPLAY_URL, makeDenyScope()), {
      scopeDeps: makeDenyScopeDeps(),
      auditEmitter: emitter,
      httpClient,
      oobCallbackLoader: async () => false,
      oobVerifyTimeoutMs: 100,
    });

    expect(result.status).toBe('out_of_scope');
    expect(httpClient.callCount).toBe(0);
    const denied = emitted.find((e) => e.action === 'validator.ssrf.replay_denied');
    expect(denied).toBeDefined();
    expect(denied?.outcome).toBe('denied');
  });
});

describe('ssrf-validator :: confirmed path', () => {
  test('scope allows + oobCallbackLoader returns true → confirmed audit emitted', async () => {
    const { emitter, emitted } = makeAuditEmitter();
    const httpClient = new TrackingHttpClient();

    const result = await validateSsrfCandidate(
      makeInput('http://oob.lab.example/callback', makeAllowScope()),
      {
        scopeDeps: makeAllowScopeDeps(),
        auditEmitter: emitter,
        httpClient,
        oobCallbackLoader: async () => true,
        oobVerifyTimeoutMs: 5000,
      },
    );

    expect(result.status).toBe('confirmed');
    const confirmed = emitted.find((e) => e.action === 'validator.ssrf.confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed?.outcome).toBe('success');
  });
});

describe('ssrf-validator :: timeout path', () => {
  test('scope allows + oobCallbackLoader always false → inconclusive/timeout audit', async () => {
    const { emitter, emitted } = makeAuditEmitter();
    const httpClient = new TrackingHttpClient();

    const result = await validateSsrfCandidate(
      makeInput('http://oob.lab.example/callback', makeAllowScope()),
      {
        scopeDeps: makeAllowScopeDeps(),
        auditEmitter: emitter,
        httpClient,
        oobCallbackLoader: async () => false,
        oobVerifyTimeoutMs: 50, // Very short timeout for fast test.
      },
    );

    expect(result.status).toBe('inconclusive');
    expect(result.reason).toBe('timeout');
    const timeout = emitted.find((e) => e.action === 'validator.ssrf.timeout');
    expect(timeout).toBeDefined();
    expect(timeout?.outcome).toBe('success');
  });
});
