// Sprint 21 — Unit tests for subfinder subprocess wrapper.
//
// Coverage paths:
//   (a) null scope → denied audit per domain, return [].
//   (b) missing binary → config_error audit, return [].
//   (c) scope denies domain → subfinder.denied audit, return []. Zero spawns.
//   (d) scope allows domain, subprocess succeeds → hosts parsed, run audit emitted.
//   (e) subprocess exits non-zero → subfinder.error audit, return [].
//   (f) malformed JSON lines are silently skipped.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import type { AuditEmitterArgs } from './worker.ts';
import { runSubfinder } from './subfinder.ts';

const VALID_UUID = '22222222-2222-4222-8222-222222222222';
const VALID_TRACE = 'aabbccddeeff00112233445566778899';
const TEST_DOMAIN = 'example.com';

const makeAuditCapture = (): {
  emitter: (args: AuditEmitterArgs) => Promise<void>;
  emitted: AuditEmitterArgs[];
} => {
  const emitted: AuditEmitterArgs[] = [];
  return {
    emitter: async (args: AuditEmitterArgs): Promise<void> => { emitted.push(args); },
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

const makeDenyScope = (): EffectiveScope => buildEffectiveScope({ ...SCOPE_BASE, rawRules: [] });

const makeAllowScope = (): EffectiveScope =>
  buildEffectiveScope({
    ...SCOPE_BASE,
    rawRules: [
      { id: 'r1', ruleKind: 'domain', effect: 'allow', payload: { pattern: 'example.com', matchSubdomains: true } },
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
    consume: async (): Promise<{ ok: true; retryAfterMs: number }> => ({ ok: true, retryAfterMs: 0 }),
  },
});

const baseReconDeps = {
  tenantId: VALID_UUID,
  assessmentId: VALID_UUID,
  projectId: VALID_UUID,
  traceId: VALID_TRACE,
  scopeDeps: makeScopeDeps(),
};

describe('subfinder :: null scope path', () => {
  test('emits recon.subfinder.denied with reason no_scope, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const spawnFn = async () => { throw new Error('should not spawn'); };
    const result = await runSubfinder(TEST_DOMAIN, {
      ...baseReconDeps,
      subfinderBin: '/usr/bin/subfinder',
      spawnFn,
      auditEmitter: emitter,
      scope: null,
    });
    expect(result).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.subfinder.denied');
    expect(emitted[0].outcome).toBe('denied');
    expect((emitted[0].metadata as Record<string, unknown>).reason).toBe('no_scope');
  });
});

describe('subfinder :: missing binary path', () => {
  test('emits recon.subfinder.error reason:config_error, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const result = await runSubfinder(TEST_DOMAIN, {
      ...baseReconDeps,
      subfinderBin: undefined,
      auditEmitter: emitter,
      scope: makeAllowScope(),
    });
    expect(result).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.subfinder.error');
    expect((emitted[0].metadata as Record<string, unknown>).reason).toBe('config_error');
  });
});

describe('subfinder :: scope deny path', () => {
  test('decide denies domain → denied audit, no spawn, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    let spawnCalled = false;
    const spawnFn = async () => { spawnCalled = true; return { stdout: '', exitCode: 0 }; };
    const result = await runSubfinder(TEST_DOMAIN, {
      ...baseReconDeps,
      subfinderBin: '/usr/bin/subfinder',
      spawnFn,
      auditEmitter: emitter,
      scope: makeDenyScope(),
    });
    expect(result).toEqual([]);
    expect(spawnCalled).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.subfinder.denied');
  });
});

describe('subfinder :: happy path', () => {
  test('parses JSON-lines stdout, emits run audit, returns hosts', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const spawnFn = async (_cmd: string[]) => ({
      stdout: [
        JSON.stringify({ host: 'sub1.example.com', input: 'example.com' }),
        JSON.stringify({ host: 'sub2.example.com', input: 'example.com' }),
        'not-json',
        '',
      ].join('\n'),
      exitCode: 0,
    });
    const result = await runSubfinder(TEST_DOMAIN, {
      ...baseReconDeps,
      subfinderBin: '/usr/bin/subfinder',
      spawnFn,
      auditEmitter: emitter,
      scope: makeAllowScope(),
    });
    expect(result).toEqual(['sub1.example.com', 'sub2.example.com']);
    const runAudit = emitted.find((e) => e.action === 'recon.subfinder.run');
    expect(runAudit).toBeDefined();
    expect(runAudit?.outcome).toBe('success');
    expect((runAudit?.metadata as Record<string, unknown>).count).toBe(2);
  });
});

describe('subfinder :: subprocess error path', () => {
  test('non-zero exit → subfinder.error audit, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const spawnFn = async () => ({ stdout: '', exitCode: 1 });
    const result = await runSubfinder(TEST_DOMAIN, {
      ...baseReconDeps,
      subfinderBin: '/usr/bin/subfinder',
      spawnFn,
      auditEmitter: emitter,
      scope: makeAllowScope(),
    });
    expect(result).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.subfinder.error');
    expect(emitted[0].outcome).toBe('failure');
  });

  test('spawn throws → subfinder.error audit, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const spawnFn = async () => { throw new Error('ENOENT'); };
    const result = await runSubfinder(TEST_DOMAIN, {
      ...baseReconDeps,
      subfinderBin: '/usr/bin/subfinder',
      spawnFn,
      auditEmitter: emitter,
      scope: makeAllowScope(),
    });
    expect(result).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.subfinder.error');
    expect((emitted[0].metadata as Record<string, unknown>).error).toBe('ENOENT');
  });
});
