// Sprint 19 — unit tests for lfi-validator.ts.
//
// Covers:
//   1. Scope deny path (decide returns denied)
//   2. Confirmed path — Unix passwd sentinel
//   3. Unmatched path
//   4. Oversized body (M3 — truncation guard)
//   5. Match-priority ordering (M4 — passwd beats shadow when both present)
//   6–10. One test per remaining sentinel category

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { type LfiValidatorInput, validateLfiCandidate } from './lfi-validator.ts';
import type { AuditEmitterArgs } from './worker.ts';

const VALID_TRACE = '0123456789abcdef0123456789abcdef';
const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSESSMENT = '22222222-2222-2222-2222-222222222222';
const CANDIDATE = '33333333-3333-3333-3333-333333333333';
const AFFECTED_URL = 'http://target.local/app?file=../../../etc/passwd';

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

// Scope that denies: empty rawRules + deny-by-default → no_matching_allow_rule.
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

const makeInput = (scope: EffectiveScope): LfiValidatorInput => ({
  candidateFindingId: CANDIDATE,
  tenantId: TENANT,
  assessmentId: ASSESSMENT,
  projectId: null,
  affectedUrl: AFFECTED_URL,
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

const makeHttpClient = (
  body: string,
): { get: (url: string) => Promise<{ body: string }>; callCount: number } => {
  let callCount = 0;
  return {
    get: async (_url: string) => {
      callCount++;
      return { body };
    },
    get callCount() {
      return callCount;
    },
  };
};

// ──────────────────────────────────────────────
// Test 1 — scope deny (decide returns denied)
// ──────────────────────────────────────────────
describe('lfi-validator :: scope deny', () => {
  test('decide denied → out_of_scope, replay_denied audit, callCount === 0', async () => {
    const { emitter, audits } = makeAuditCapture();
    const httpClient = makeHttpClient('root:x:0:0:root:/root:/bin/bash\n');
    const result = await validateLfiCandidate(makeInput(makeDenyScope()), {
      scopeDeps: {
        dns: { resolveA: async () => [], resolveAAAA: async () => [] },
        clock: { now: () => new Date() },
        rateLimit: { consume: async () => ({ ok: true as const, retryAfterMs: 0 }) },
      },
      auditEmitter: emitter,
      httpClient,
    });
    expect(result.status).toBe('out_of_scope');
    expect(httpClient.callCount).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('validator.lfi.replay_denied');
    expect(audits[0].outcome).toBe('denied');
  });
});

// ──────────────────────────────────────────────
// Shared allow-scope deps for remaining tests
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// Test 2 — confirmed (Unix passwd)
// ──────────────────────────────────────────────
describe('lfi-validator :: confirmed path', () => {
  test('unix_passwd sentinel → confirmed, lfi.confirmed audit', async () => {
    const { emitter, audits } = makeAuditCapture();
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient(
        'root:x:0:0:root:/root:/bin/bash\nbin:x:1:1:bin:/bin:/sbin/nologin\n',
      ),
    });
    expect(result.status).toBe('confirmed');
    expect(result.sentinelKey).toBe('unix_passwd');
    expect(audits[audits.length - 1].action).toBe('validator.lfi.confirmed');
    expect(audits[audits.length - 1].outcome).toBe('success');
    expect(audits[audits.length - 1].metadata.sentinelKey).toBe('unix_passwd');
  });
});

// ──────────────────────────────────────────────
// Test 3 — unmatched
// ──────────────────────────────────────────────
describe('lfi-validator :: unmatched path', () => {
  test('no sentinel match → unmatched, lfi.unmatched audit with outcome:success', async () => {
    const { emitter, audits } = makeAuditCapture();
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient('hello world — this is a normal response'),
    });
    expect(result.status).toBe('unmatched');
    expect(result.sentinelKey).toBeUndefined();
    expect(audits[audits.length - 1].action).toBe('validator.lfi.unmatched');
    expect(audits[audits.length - 1].outcome).toBe('success');
    expect(audits[audits.length - 1].metadata.affectedUrl).toBe(AFFECTED_URL);
  });
});

// ──────────────────────────────────────────────
// Test 4 — oversized body (M3)
// ──────────────────────────────────────────────
describe('lfi-validator :: body cap (M3)', () => {
  test('sentinel only beyond 1MB mark → unmatched (truncated)', async () => {
    const { emitter } = makeAuditCapture();
    // Sentinel string at byte position 2MB — well past the 1MB cap.
    const oversized = `${'A'.repeat(2_097_152)}root:x:0:0:root:/root:/bin/bash\n`;
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient(oversized),
    });
    expect(result.status).toBe('unmatched');
  });
});

// ──────────────────────────────────────────────
// Test 5 — match-priority ordering (M4)
// ──────────────────────────────────────────────
describe('lfi-validator :: priority ordering (M4)', () => {
  test('body contains both passwd and shadow → unix_passwd wins (priority #1)', async () => {
    const { emitter } = makeAuditCapture();
    // Both passwd and shadow patterns present; passwd is priority #1.
    const body = 'root:x:0:0:root:/root:/bin/bash\nroot:$6$salt$longhash:19000:0:99999:7:::\n';
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient(body),
    });
    expect(result.status).toBe('confirmed');
    expect(result.sentinelKey).toBe('unix_passwd');
  });
});

// ──────────────────────────────────────────────
// Test 6 — Unix shadow
// ──────────────────────────────────────────────
describe('lfi-validator :: unix_shadow sentinel', () => {
  test('shadow file body → sentinelKey unix_shadow', async () => {
    const { emitter } = makeAuditCapture();
    const body = 'root:$6$salt$longhash:19000:0:99999:7:::\ndaemon:*:18000:0:99999:7:::\n';
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient(body),
    });
    expect(result.status).toBe('confirmed');
    expect(result.sentinelKey).toBe('unix_shadow');
  });
});

// ──────────────────────────────────────────────
// Test 7 — Windows hosts
// ──────────────────────────────────────────────
describe('lfi-validator :: windows_hosts sentinel', () => {
  test('windows hosts file → sentinelKey windows_hosts', async () => {
    const { emitter } = makeAuditCapture();
    const body = '# Copyright (c) 1993-2009 Microsoft Corp.\n#\n127.0.0.1       localhost\n';
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient(body),
    });
    expect(result.status).toBe('confirmed');
    expect(result.sentinelKey).toBe('windows_hosts');
  });
});

// ──────────────────────────────────────────────
// Test 8 — Windows boot.ini
// ──────────────────────────────────────────────
describe('lfi-validator :: windows_boot_ini sentinel', () => {
  test('boot.ini body → sentinelKey windows_boot_ini', async () => {
    const { emitter } = makeAuditCapture();
    const body =
      '[boot loader]\ntimeout=30\ndefault=multi(0)disk(0)rdisk(0)partition(1)\\WINDOWS\n';
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient(body),
    });
    expect(result.status).toBe('confirmed');
    expect(result.sentinelKey).toBe('windows_boot_ini');
  });
});

// ──────────────────────────────────────────────
// Test 9 — PHP config (H1 anchor)
// ──────────────────────────────────────────────
describe('lfi-validator :: php_config sentinel (H1 — line-anchored)', () => {
  test('php.ini body → sentinelKey php_config', async () => {
    const { emitter } = makeAuditCapture();
    const body = '[PHP]\nshort_open_tag = On\noutput_buffering = 4096\n';
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient(body),
    });
    expect(result.status).toBe('confirmed');
    expect(result.sentinelKey).toBe('php_config');
  });

  test('inline HTML mentioning short_open_tag — no line anchor → unmatched (H1 false-pos rejection)', async () => {
    const { emitter } = makeAuditCapture();
    // In HTML the string appears inside a paragraph, not at line start after the anchor.
    const body = '<html><body><p>Set short_open_tag = On in your php.ini</p></body></html>';
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient(body),
    });
    expect(result.status).toBe('unmatched');
  });
});

// ──────────────────────────────────────────────
// Test 10 — Generic Linux fallback
// ──────────────────────────────────────────────
describe('lfi-validator :: linux_generic sentinel', () => {
  test('passwd with bin line but no root line → linux_generic fallback', async () => {
    const { emitter } = makeAuditCapture();
    // Deliberately omit root:x:0:0 so linux_generic fires.
    const body = 'nobody:x:99:99:nobody:/:/sbin/nologin\nbin:x:1:1:bin:/bin:/sbin/nologin\n';
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: makeHttpClient(body),
    });
    expect(result.status).toBe('confirmed');
    expect(result.sentinelKey).toBe('linux_generic');
  });
});

// ──────────────────────────────────────────────
// Test 11 — fetch error (codex MED fix)
// ──────────────────────────────────────────────
describe('lfi-validator :: fetch_failed path', () => {
  test('httpClient.get throws → fetch_failed status + lfi.fetch_failed audit', async () => {
    const { emitter, audits } = makeAuditCapture();
    const throwingClient = {
      callCount: 0,
      get: async (_url: string): Promise<{ body: string }> => {
        throwingClient.callCount++;
        throw new Error('connection refused');
      },
    };
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: throwingClient,
    });
    expect(result.status).toBe('fetch_failed');
    expect(result.reason).toContain('connection refused');
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('validator.lfi.fetch_failed');
    expect(audits[0].outcome).toBe('denied');
  });

  test('httpClient.get throws timeout → fetch_failed, callCount === 1', async () => {
    const { emitter, audits } = makeAuditCapture();
    const timeoutClient = {
      callCount: 0,
      get: async (_url: string): Promise<{ body: string }> => {
        timeoutClient.callCount++;
        throw new Error('request timeout');
      },
    };
    const result = await validateLfiCandidate(makeInput(makeAllowScope()), {
      scopeDeps: allowScopeDeps,
      auditEmitter: emitter,
      httpClient: timeoutClient,
    });
    expect(result.status).toBe('fetch_failed');
    expect(timeoutClient.callCount).toBe(1);
    expect(audits[0].metadata.error).toContain('timeout');
  });
});
