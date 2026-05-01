// Sprint 21 — Unit tests for httpx subprocess wrapper.
//
// Coverage paths:
//   (a) null scope → denied per url, return [].
//   (b) missing binary → config_error audit, return [].
//   (c) per-url scope gate: denied url emits httpx.denied, approved url proceeds.
//   (d) all urls denied → no spawn, return [].
//   (e) happy path: httpx runs, JSON-lines parsed, run audit emitted.
//   (f) non-zero exit → httpx.error, return [].
//   (g) spawn throws → httpx.error, return [].

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { probeHttpx } from './httpx.ts';
import type { AuditEmitterArgs } from './worker.ts';

const VALID_UUID = '33333333-3333-4333-8333-333333333333';
const VALID_TRACE = 'ffeeddccbbaa99887766554433221100';
const ALLOWED_URL = 'https://example.com/';
const DENIED_URL = 'https://evil.attacker.com/';

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

const _makeDenyScope = (): EffectiveScope => buildEffectiveScope({ ...SCOPE_BASE, rawRules: [] });

const makeAllowExampleScope = (): EffectiveScope =>
  buildEffectiveScope({
    ...SCOPE_BASE,
    rawRules: [
      {
        id: 'r1',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'example.com', matchSubdomains: false },
      },
      { id: 'r2', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'https' } },
      { id: 'r3', ruleKind: 'port', effect: 'allow', payload: { port: 443 } },
      { id: 'r4', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
      { id: 'r5', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
    ],
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

const baseDeps = {
  tenantId: VALID_UUID,
  assessmentId: VALID_UUID,
  projectId: VALID_UUID,
  traceId: VALID_TRACE,
  scopeDeps: makeScopeDeps(),
};

describe('httpx :: null scope path', () => {
  test('emits denied per url, no spawn, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    let spawnCalled = false;
    const result = await probeHttpx([ALLOWED_URL, DENIED_URL], {
      ...baseDeps,
      httpxBin: '/usr/bin/httpx',
      spawnFn: async () => {
        spawnCalled = true;
        return { stdout: '', exitCode: 0 };
      },
      auditEmitter: emitter,
      scope: null,
    });
    expect(result).toEqual([]);
    expect(spawnCalled).toBe(false);
    expect(emitted).toHaveLength(2);
    for (const e of emitted) {
      expect(e.action).toBe('recon.httpx.denied');
      expect((e.metadata as Record<string, unknown>).reason).toBe('no_scope');
    }
  });
});

describe('httpx :: missing binary path', () => {
  test('emits config_error, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const result = await probeHttpx([ALLOWED_URL], {
      ...baseDeps,
      httpxBin: undefined,
      auditEmitter: emitter,
      scope: makeAllowExampleScope(),
    });
    expect(result).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.httpx.error');
    expect((emitted[0].metadata as Record<string, unknown>).reason).toBe('config_error');
  });
});

describe('httpx :: per-url scope gate (B3 invariant)', () => {
  test('denied url gets httpx.denied, approved url proceeds to spawn', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const spawnArgs: string[][] = [];
    const spawnFn = async (cmd: string[]) => {
      spawnArgs.push(cmd);
      // httpx response for the approved url
      return {
        stdout: `${JSON.stringify({ url: ALLOWED_URL, status_code: 200, title: 'Example', tech: [] })}\n`,
        exitCode: 0,
      };
    };
    const result = await probeHttpx([ALLOWED_URL, DENIED_URL], {
      ...baseDeps,
      httpxBin: '/usr/bin/httpx',
      spawnFn,
      auditEmitter: emitter,
      scope: makeAllowExampleScope(),
    });
    // DENIED_URL should be denied
    const deniedAudit = emitted.find((e) => e.action === 'recon.httpx.denied');
    expect(deniedAudit).toBeDefined();
    expect((deniedAudit?.metadata as Record<string, unknown>).url).toBe(DENIED_URL);
    // ALLOWED_URL was approved → spawn happened
    expect(spawnArgs.length).toBe(1);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe(ALLOWED_URL);
  });

  test('all urls denied → no spawn, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    let spawnCalled = false;
    const result = await probeHttpx([DENIED_URL], {
      ...baseDeps,
      httpxBin: '/usr/bin/httpx',
      spawnFn: async () => {
        spawnCalled = true;
        return { stdout: '', exitCode: 0 };
      },
      auditEmitter: emitter,
      scope: makeAllowExampleScope(),
    });
    expect(result).toEqual([]);
    expect(spawnCalled).toBe(false);
    expect(emitted.some((e) => e.action === 'recon.httpx.denied')).toBe(true);
  });
});

describe('httpx :: happy path', () => {
  test('parses JSON-lines, emits run audit with aliveCount', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const httpxOut = [
      JSON.stringify({
        url: ALLOWED_URL,
        status_code: 200,
        title: 'Example Domain',
        tech: ['Nginx'],
        webserver: 'nginx',
      }),
      'malformed',
      '',
    ].join('\n');
    const spawnFn = async () => ({ stdout: httpxOut, exitCode: 0 });
    const result = await probeHttpx([ALLOWED_URL], {
      ...baseDeps,
      httpxBin: '/usr/bin/httpx',
      spawnFn,
      auditEmitter: emitter,
      scope: makeAllowExampleScope(),
    });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe(ALLOWED_URL);
    expect(result[0].statusCode).toBe(200);
    expect(result[0].title).toBe('Example Domain');
    expect(result[0].tech).toEqual(['Nginx']);
    expect(result[0].webServer).toBe('nginx');
    const runAudit = emitted.find((e) => e.action === 'recon.httpx.run');
    expect(runAudit?.outcome).toBe('success');
    expect((runAudit?.metadata as Record<string, unknown>).aliveCount).toBe(1);
  });
});

describe('httpx :: mkdtemp failure (TMPDIR full/read-only)', () => {
  test('mkdtempFn throws EPERM → httpx.error audit emitted, returns tmpdir_setup fail, no rejection', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const result = await probeHttpx([ALLOWED_URL], {
      ...baseDeps,
      httpxBin: '/usr/bin/httpx',
      mkdtempFn: () => {
        const err = new Error('EPERM: operation not permitted, mkdtemp') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      },
      auditEmitter: emitter,
      scope: makeAllowExampleScope(),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'tmpdir_setup', error: expect.stringContaining('EPERM') });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.httpx.error');
    expect((emitted[0].metadata as Record<string, unknown>).error).toContain('EPERM');
  });
});

describe('httpx :: error paths', () => {
  test('non-zero exit → httpx.error, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const result = await probeHttpx([ALLOWED_URL], {
      ...baseDeps,
      httpxBin: '/usr/bin/httpx',
      spawnFn: async () => ({ stdout: '', exitCode: 127 }),
      auditEmitter: emitter,
      scope: makeAllowExampleScope(),
    });
    expect(result).toEqual([]);
    expect(emitted[0].action).toBe('recon.httpx.error');
    expect((emitted[0].metadata as Record<string, unknown>).exitCode).toBe(127);
  });

  test('spawn throws → httpx.error, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const result = await probeHttpx([ALLOWED_URL], {
      ...baseDeps,
      httpxBin: '/usr/bin/httpx',
      spawnFn: async () => {
        throw new Error('spawn_failed');
      },
      auditEmitter: emitter,
      scope: makeAllowExampleScope(),
    });
    expect(result).toEqual([]);
    expect(emitted[0].action).toBe('recon.httpx.error');
    expect((emitted[0].metadata as Record<string, unknown>).error).toBe('spawn_failed');
  });
});
