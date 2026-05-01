// Sprint 21 — Unit tests for nuclei subprocess wrapper.
//
// Coverage paths:
//   (a) null scope → denied per url, return [].
//   (b) missing binary → config_error audit, return [].
//   (c) per-url scope gate: denied url gets nuclei.denied, approved proceeds.
//   (d) all urls denied → no spawn, return [].
//   (e) happy path: nuclei runs, JSON-lines parsed, template_match + run audits.
//   (f) B4 per-finding write failure → nuclei.error reason:finding_write_failed + continue.
//   (g) non-zero exit → nuclei.error, return [].

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import type { NucleiFinding } from './types.ts';
import type { AuditEmitterArgs } from './worker.ts';
import { runNuclei } from './nuclei.ts';

const VALID_UUID = '44444444-4444-4444-8444-444444444444';
const VALID_TRACE = '00112233445566778899aabbccddeeff';
const ALLOWED_URL = 'https://target.example.com/';
const DENIED_URL = 'https://off-limits.example.net/';

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

const makeAllowTargetScope = (): EffectiveScope =>
  buildEffectiveScope({
    ...SCOPE_BASE,
    rawRules: [
      { id: 'r1', ruleKind: 'domain', effect: 'allow', payload: { pattern: 'target.example.com', matchSubdomains: false } },
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

const baseDeps = {
  tenantId: VALID_UUID,
  assessmentId: VALID_UUID,
  projectId: VALID_UUID,
  traceId: VALID_TRACE,
  scopeDeps: makeScopeDeps(),
};

const makeFindingLine = (templateId: string, matched: string, severity = 'medium'): string =>
  JSON.stringify({
    'template-id': templateId,
    matched,
    info: { name: `${templateId} test`, severity, description: 'A test finding' },
  });

describe('nuclei :: null scope path', () => {
  test('emits denied per url, no spawn, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    let spawnCalled = false;
    const result = await runNuclei([ALLOWED_URL, DENIED_URL], {
      ...baseDeps,
      nucleiBin: '/usr/bin/nuclei',
      spawnFn: async () => { spawnCalled = true; return { stdout: '', exitCode: 0 }; },
      auditEmitter: emitter,
      scope: null,
    });
    expect(result).toEqual([]);
    expect(spawnCalled).toBe(false);
    expect(emitted).toHaveLength(2);
    for (const e of emitted) {
      expect(e.action).toBe('recon.nuclei.denied');
      expect((e.metadata as Record<string, unknown>).reason).toBe('no_scope');
    }
  });
});

describe('nuclei :: missing binary path', () => {
  test('emits config_error, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const result = await runNuclei([ALLOWED_URL], {
      ...baseDeps,
      nucleiBin: undefined,
      auditEmitter: emitter,
      scope: makeAllowTargetScope(),
    });
    expect(result).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('recon.nuclei.error');
    expect((emitted[0].metadata as Record<string, unknown>).reason).toBe('config_error');
  });
});

describe('nuclei :: per-url scope gate (B3 invariant)', () => {
  test('denied url gets nuclei.denied audit, no spawn for it', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const spawnFn = async () => ({ stdout: '', exitCode: 0 });
    const result = await runNuclei([ALLOWED_URL, DENIED_URL], {
      ...baseDeps,
      nucleiBin: '/usr/bin/nuclei',
      spawnFn,
      auditEmitter: emitter,
      scope: makeAllowTargetScope(),
    });
    const deniedAudit = emitted.find((e) => e.action === 'recon.nuclei.denied');
    expect(deniedAudit).toBeDefined();
    expect((deniedAudit?.metadata as Record<string, unknown>).url).toBe(DENIED_URL);
    // run audit for approved url
    const runAudit = emitted.find((e) => e.action === 'recon.nuclei.run');
    expect(runAudit).toBeDefined();
    expect(result).toEqual([]);
  });

  test('all urls denied → no spawn, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    let spawnCalled = false;
    const result = await runNuclei([DENIED_URL], {
      ...baseDeps,
      nucleiBin: '/usr/bin/nuclei',
      spawnFn: async () => { spawnCalled = true; return { stdout: '', exitCode: 0 }; },
      auditEmitter: emitter,
      scope: makeAllowTargetScope(),
    });
    expect(result).toEqual([]);
    expect(spawnCalled).toBe(false);
    expect(emitted.some((e) => e.action === 'recon.nuclei.denied')).toBe(true);
  });
});

describe('nuclei :: happy path', () => {
  test('parses findings, emits template_match per finding + run audit', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const nucleiOut = [
      makeFindingLine('cve-2021-1234', ALLOWED_URL + 'vuln', 'high'),
      makeFindingLine('exposed-config', ALLOWED_URL + '.env', 'medium'),
      'not-json',
      '',
    ].join('\n');
    const findings: NucleiFinding[] = [];
    const result = await runNuclei([ALLOWED_URL], {
      ...baseDeps,
      nucleiBin: '/usr/bin/nuclei',
      spawnFn: async () => ({ stdout: nucleiOut, exitCode: 0 }),
      auditEmitter: emitter,
      scope: makeAllowTargetScope(),
      findingsWriter: async (f) => { findings.push(f); },
    });
    expect(result).toHaveLength(2);
    expect(result[0].templateId).toBe('cve-2021-1234');
    expect(result[0].severity).toBe('high');
    expect(result[1].templateId).toBe('exposed-config');
    expect(findings).toHaveLength(2);
    const templateMatches = emitted.filter((e) => e.action === 'recon.nuclei.template_match');
    expect(templateMatches).toHaveLength(2);
    const runAudit = emitted.find((e) => e.action === 'recon.nuclei.run');
    expect(runAudit?.outcome).toBe('success');
    expect((runAudit?.metadata as Record<string, unknown>).findingCount).toBe(2);
  });
});

describe('nuclei :: B4 per-finding write failure', () => {
  test('findingsWriter throws → finding_write_failed audit + loop continues', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const nucleiOut = [
      makeFindingLine('t1', ALLOWED_URL + 'a'),
      makeFindingLine('t2', ALLOWED_URL + 'b'),
    ].join('\n');
    let writeCount = 0;
    const result = await runNuclei([ALLOWED_URL], {
      ...baseDeps,
      nucleiBin: '/usr/bin/nuclei',
      spawnFn: async () => ({ stdout: nucleiOut, exitCode: 0 }),
      auditEmitter: emitter,
      scope: makeAllowTargetScope(),
      findingsWriter: async () => {
        writeCount++;
        throw new Error('db_write_failed');
      },
    });
    // Both findings still returned (loop never short-circuits).
    expect(result).toHaveLength(2);
    expect(writeCount).toBe(2);
    const writeErrors = emitted.filter(
      (e) => e.action === 'recon.nuclei.error' &&
        (e.metadata as Record<string, unknown>).reason === 'finding_write_failed',
    );
    expect(writeErrors).toHaveLength(2);
  });
});

describe('nuclei :: error paths', () => {
  test('non-zero exit → nuclei.error, returns []', async () => {
    const { emitter, emitted } = makeAuditCapture();
    const result = await runNuclei([ALLOWED_URL], {
      ...baseDeps,
      nucleiBin: '/usr/bin/nuclei',
      spawnFn: async () => ({ stdout: '', exitCode: 2 }),
      auditEmitter: emitter,
      scope: makeAllowTargetScope(),
    });
    expect(result).toEqual([]);
    expect(emitted[0].action).toBe('recon.nuclei.error');
  });
});
