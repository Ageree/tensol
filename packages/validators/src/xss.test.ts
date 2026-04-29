import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import type { ValidationInput } from './contract.ts';
import {
  BrowserReplayTimeoutError,
  type XssReplayDriver,
  type XssReplayInput,
  type XssReplayResult,
} from './xss-replay-driver.ts';
import { type XssValidatorDeps, validateXssReflected } from './xss.ts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSESS = '22222222-2222-2222-2222-222222222222';
const CANDIDATE = '33333333-3333-3333-3333-333333333333';
const TRACE = '0123456789abcdef0123456789abcdef';

const stubScopeDeps = {
  dns: {
    resolveA: async (host: string): Promise<string[]> => {
      if (host === 'localhost') return ['203.0.113.7'];
      if (host === 'evil.example') return ['198.51.100.7'];
      return [];
    },
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

const buildAllowLocalhost = async (port = 80): Promise<EffectiveScope> =>
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
      { id: 'r4', ruleKind: 'port', effect: 'allow', payload: { port } },
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

const baseInput = (overrides: Partial<ValidationInput> = {}): ValidationInput => ({
  tenantId: TENANT,
  projectId: null,
  assessmentId: ASSESS,
  candidateFindingId: CANDIDATE,
  candidateType: 'xss_reflected',
  affectedUrl: 'http://localhost/search?q=existing',
  payload: { sample: 1 },
  traceId: TRACE,
  ...overrides,
});

const fakeDriver = (results: ReadonlyArray<Partial<XssReplayResult>>): XssReplayDriver => {
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
        screenshot: new Uint8Array([1]),
        trace: new Uint8Array([2]),
        capturedAt: '2026-04-29T00:00:00.000Z',
        ...r,
      };
    },
  };
};

const throwingDriver = (err: Error): XssReplayDriver => ({
  replay: async (): Promise<XssReplayResult> => {
    throw err;
  },
});

const buildDeps = async (
  driver: XssReplayDriver,
  scope: EffectiveScope | null,
): Promise<XssValidatorDeps> => ({
  driver,
  scope,
  scopeDeps: stubScopeDeps,
});

describe('validators :: xss decision matrix', () => {
  test('both runs DOM echo + console hit → confirmed (high)', async () => {
    const scope = await buildAllowLocalhost();
    const deps = await buildDeps(
      fakeDriver([
        { domContainsNonce: true, consoleNonceHits: ['x'] },
        { domContainsNonce: true, consoleNonceHits: ['x'] },
      ]),
      scope,
    );
    const out = await validateXssReflected(baseInput(), deps);
    expect(out.status).toBe('confirmed');
    expect(out.confidence).toBe('high');
    expect(out.reason).toBe('two_runs_dom_echo');
  });

  test('both runs DOM echo only (no console) → confirmed dom_nonce_echo', async () => {
    const scope = await buildAllowLocalhost();
    const deps = await buildDeps(
      fakeDriver([{ domContainsNonce: true }, { domContainsNonce: true }]),
      scope,
    );
    const out = await validateXssReflected(baseInput(), deps);
    expect(out.status).toBe('confirmed');
    expect(out.proofType).toBe('dom_nonce_echo');
  });

  test('one DOM echo, one empty → inconclusive (non-reproducible)', async () => {
    const scope = await buildAllowLocalhost();
    const deps = await buildDeps(
      fakeDriver([{ domContainsNonce: true }, { domContainsNonce: false }]),
      scope,
    );
    const out = await validateXssReflected(baseInput(), deps);
    expect(out.status).toBe('inconclusive');
    expect(out.reason).toBe('non_reproducible_dom_echo');
  });

  test('both runs empty → rejected', async () => {
    const scope = await buildAllowLocalhost();
    const deps = await buildDeps(fakeDriver([{}, {}]), scope);
    const out = await validateXssReflected(baseInput(), deps);
    expect(out.status).toBe('rejected');
    expect(out.reason).toBe('no_echo_two_runs');
  });

  test('both runs alert-only (no DOM/console) → inconclusive (weak proof)', async () => {
    const scope = await buildAllowLocalhost();
    const deps = await buildDeps(
      fakeDriver([{ alertDispatched: true }, { alertDispatched: true }]),
      scope,
    );
    const out = await validateXssReflected(baseInput(), deps);
    expect(out.status).toBe('inconclusive');
    expect(out.proofType).toBe('alert_only');
    expect(out.reason).toBe('alert_only_weak_proof');
  });

  test('scope deny → out_of_scope (no driver call)', async () => {
    let calls = 0;
    const driver: XssReplayDriver = {
      replay: async (): Promise<XssReplayResult> => {
        calls += 1;
        throw new Error('should_not_be_called');
      },
    };
    const scope = await buildAllowLocalhost(); // localhost allowed; affectedUrl is evil.example
    const deps = await buildDeps(driver, scope);
    const out = await validateXssReflected(
      baseInput({ affectedUrl: 'http://evil.example/x' }),
      deps,
    );
    expect(out.status).toBe('out_of_scope');
    expect(out.proofType).toBe('none');
    expect(calls).toBe(0);
  });

  test('null scope → out_of_scope with reason scope_not_found', async () => {
    const deps = await buildDeps(fakeDriver([]), null);
    const out = await validateXssReflected(baseInput(), deps);
    expect(out.status).toBe('out_of_scope');
    expect(out.reason).toBe('scope_not_found');
  });

  test('driver throws BrowserReplayTimeoutError → inconclusive (reason=timeout) [A-V-Hang unit]', async () => {
    const scope = await buildAllowLocalhost();
    const deps = await buildDeps(
      throwingDriver(new BrowserReplayTimeoutError('took too long')),
      scope,
    );
    const out = await validateXssReflected(baseInput(), deps);
    expect(out.status).toBe('inconclusive');
    expect(out.reason).toBe('timeout');
    expect(out.proofType).toBe('none');
  });

  test('driver throws non-timeout Error → bubble up (worker handles transient nack)', async () => {
    const scope = await buildAllowLocalhost();
    const deps = await buildDeps(throwingDriver(new Error('unexpected')), scope);
    let caught: unknown = null;
    try {
      await validateXssReflected(baseInput(), deps);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof Error).toBe(true);
    expect((caught as Error).message).toBe('unexpected');
  });
});
