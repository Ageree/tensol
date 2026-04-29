// Sprint 6 — exhaustive coverage for buildEffectiveScope across all 16
// strict ruleKinds + the unknown_rule fallback (A-SE-Compat-1 / A-SE-Pri-3).
//
// Drives the per-kind materializeStrict() branches that the IT alone never
// reaches. Each kind asserted to:
//   - decode into the strict NormalizedRule shape with `id`, `kind`, `effect`.
//   - place itself on the right bucket (allowRules vs denyRules) by `effect`.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLATFORM_POLICY, buildEffectiveScope, legacyToRaw } from './effective-scope.ts';
import type { NormalizedRule, ToolPolicy } from './types.ts';

interface RawRule {
  id: string;
  ruleKind: string;
  effect: 'allow' | 'deny';
  payload: Record<string, unknown>;
}

const baseInputs = (rawRules: RawRule[]) =>
  ({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy: { tenantId: 't1' },
    platformPolicy: DEFAULT_PLATFORM_POLICY,
    rawRules,
    toolCatalog: new Map<string, ToolPolicy>(),
    assessmentFlags: {
      highImpactCategories: [],
      ownershipVerifiedTargetIds: new Set<string>(),
    },
    timeWindow: null,
  }) as const;

const findById = (rules: ReadonlyArray<NormalizedRule>, id: string): NormalizedRule | undefined =>
  rules.find((r) => r.id === id);

describe('buildEffectiveScope — per-kind materialization (R6 + A-SE-Pri-3)', () => {
  test('domain rule decodes and lands in allowRules', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-domain',
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 'EXAMPLE.com', matchSubdomains: true },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-domain');
    expect(rule?.kind).toBe('domain');
    if (rule?.kind === 'domain') {
      // Pattern is normalized to lowercase ASCII via normalizeHost.
      expect(rule.pattern).toBe('example.com');
      expect(rule.matchSubdomains).toBe(true);
    }
  });

  test('subdomain rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-subdomain',
          ruleKind: 'subdomain',
          effect: 'deny',
          payload: { parent: 'INTERNAL.example.com' },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-subdomain');
    expect(rule?.kind).toBe('subdomain');
    if (rule?.kind === 'subdomain') {
      expect(rule.parent).toBe('internal.example.com');
    }
  });

  test('url_prefix rule decodes (URL canonicalization)', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-url',
          ruleKind: 'url_prefix',
          effect: 'allow',
          payload: { prefix: 'HTTPS://Example.COM:443/api' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-url');
    expect(rule?.kind).toBe('url_prefix');
    if (rule?.kind === 'url_prefix') {
      expect(rule.prefix.startsWith('https://example.com/api')).toBe(true);
    }
  });

  test('ip rule decodes (IP canonicalization)', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-ip',
          ruleKind: 'ip',
          effect: 'deny',
          payload: { ip: '192.168.001.001' },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-ip');
    expect(rule?.kind).toBe('ip');
    if (rule?.kind === 'ip') {
      expect(rule.ip).toBe('192.168.1.1');
    }
  });

  test('cidr rule decodes (CIDR canonicalization)', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-cidr',
          ruleKind: 'cidr',
          effect: 'allow',
          payload: { cidr: '192.168.001.000/24' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-cidr');
    expect(rule?.kind).toBe('cidr');
    if (rule?.kind === 'cidr') {
      expect(rule.cidr).toBe('192.168.1.0/24');
    }
  });

  test('port rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([{ id: 'r-port', ruleKind: 'port', effect: 'allow', payload: { port: 443 } }]),
    );
    const rule = findById(scope.allowRules, 'r-port');
    expect(rule?.kind).toBe('port');
    if (rule?.kind === 'port') expect(rule.port).toBe(443);
  });

  test('protocol rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-proto',
          ruleKind: 'protocol',
          effect: 'allow',
          payload: { protocol: 'https' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-proto');
    expect(rule?.kind).toBe('protocol');
  });

  test('cloud_account rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-cloud',
          ruleKind: 'cloud_account',
          effect: 'allow',
          payload: { provider: 'aws', accountId: '123' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-cloud');
    expect(rule?.kind).toBe('cloud_account');
  });

  test('kubernetes_namespace rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-k8s',
          ruleKind: 'kubernetes_namespace',
          effect: 'allow',
          payload: { cluster: 'prod', namespace: 'app' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-k8s');
    expect(rule?.kind).toBe('kubernetes_namespace');
  });

  test('repository rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-repo',
          ruleKind: 'repository',
          effect: 'allow',
          payload: { vcs: 'github', owner: 'acme', name: 'svc' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-repo');
    expect(rule?.kind).toBe('repository');
  });

  test('time_window rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-tw',
          ruleKind: 'time_window',
          effect: 'allow',
          payload: {
            start: '2026-04-28T00:00:00.000Z',
            end: '2026-04-29T00:00:00.000Z',
          },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-tw');
    expect(rule?.kind).toBe('time_window');
  });

  test('rate_limit rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-rl',
          ruleKind: 'rate_limit',
          effect: 'allow',
          payload: { bucket: 'b', perSecond: 5, burst: 10 },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-rl');
    expect(rule?.kind).toBe('rate_limit');
  });

  test('tool_category rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-tc',
          ruleKind: 'tool_category',
          effect: 'allow',
          payload: { category: 'recon' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-tc');
    expect(rule?.kind).toBe('tool_category');
  });

  test('tool_name rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-tn',
          ruleKind: 'tool_name',
          effect: 'allow',
          payload: { toolName: 'nuclei' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-tn');
    expect(rule?.kind).toBe('tool_name');
  });

  test('http_method rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-m',
          ruleKind: 'http_method',
          effect: 'deny',
          payload: { method: 'DELETE' },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-m');
    expect(rule?.kind).toBe('http_method');
  });

  test('path_pattern rule decodes', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-pp',
          ruleKind: 'path_pattern',
          effect: 'allow',
          payload: { glob: '/api/v1/**' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-pp');
    expect(rule?.kind).toBe('path_pattern');
  });

  test('A-SE-Pri-3 — out-of-set ruleKind maps to unknown_rule', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-unknown',
          ruleKind: 'gibberish_kind',
          effect: 'deny',
          payload: { foo: 'bar' },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-unknown');
    expect(rule?.kind).toBe('unknown_rule');
    if (rule?.kind === 'unknown_rule') {
      expect(rule.rawRuleKind).toBe('gibberish_kind');
    }
  });

  test('codex P2 — unknown_rule with effect:allow is FORCED to deny (fail-closed)', () => {
    // Persisted row claims effect='allow' on an unknown rule kind. The engine
    // MUST coerce to deny so unknown rules can never contribute to allow set
    // and always surface in matchedDenyRuleIds when matched.
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'unknown-allow-id',
          ruleKind: 'future_rule',
          effect: 'allow',
          payload: { whatever: true },
        },
      ]),
    );
    // Must NOT land in allowRules.
    expect(findById(scope.allowRules, 'unknown-allow-id')).toBeUndefined();
    // Must land in denyRules with effect coerced to 'deny'.
    const rule = findById(scope.denyRules, 'unknown-allow-id');
    expect(rule?.kind).toBe('unknown_rule');
    expect(rule?.effect).toBe('deny');
    if (rule?.kind === 'unknown_rule') {
      expect(rule.rawRuleKind).toBe('future_rule');
    }
  });

  test('R6 — strict ruleKind with malformed payload falls back to unknown_rule', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        // ruleKind is in the closed set but payload missing required fields →
        // strict parse fails → engine maps to unknown_rule (defense-in-depth).
        {
          id: 'r-bad-domain',
          ruleKind: 'domain',
          effect: 'deny',
          payload: { not_pattern: 'wrong' },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-bad-domain');
    expect(rule?.kind).toBe('unknown_rule');
  });

  test('domain rule with un-normalizable pattern preserves lowercased pattern', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-bad-host',
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 'with space.invalid', matchSubdomains: false },
        },
      ]),
    );
    // The materializer's host-normalize fallback path: catches the throw, uses
    // toLowerCase() on the raw pattern. Asserts the catch branch is reached.
    const rule = findById(scope.allowRules, 'r-bad-host');
    expect(rule?.kind).toBe('domain');
    if (rule?.kind === 'domain') {
      expect(rule.pattern).toBe('with space.invalid');
    }
  });

  test('subdomain rule with un-normalizable parent preserves lowercased value', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-bad-sub',
          ruleKind: 'subdomain',
          effect: 'deny',
          payload: { parent: 'with space.invalid' },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-bad-sub');
    expect(rule?.kind).toBe('subdomain');
    if (rule?.kind === 'subdomain') {
      expect(rule.parent).toBe('with space.invalid');
    }
  });

  test('codex iter-9 P2 — url_prefix with un-normalizable URL falls through to unknown_rule (fail-closed)', () => {
    // Pre-fix: malformed `prefix: 'not-a-url'` was preserved as kind:'url_prefix',
    // a silent no-op. Post-fix: rule maps to unknown_rule (effect:'deny') so
    // it fails closed and surfaces in matchedDenyRuleIds.
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-bad-url',
          ruleKind: 'url_prefix',
          effect: 'allow',
          payload: { prefix: 'not-a-url' },
        },
      ]),
    );
    expect(findById(scope.allowRules, 'r-bad-url')).toBeUndefined();
    const rule = findById(scope.denyRules, 'r-bad-url');
    expect(rule?.kind).toBe('unknown_rule');
    expect(rule?.effect).toBe('deny');
  });

  test('codex iter-9 P2 — url_prefix without scheme → unknown_rule', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-no-scheme',
          ruleKind: 'url_prefix',
          effect: 'deny',
          payload: { prefix: 'example.com/admin' },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-no-scheme');
    expect(rule?.kind).toBe('unknown_rule');
  });

  test('codex iter-9 P2 — valid url_prefix still parses normally', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-good-url',
          ruleKind: 'url_prefix',
          effect: 'allow',
          payload: { prefix: 'https://example.com/admin' },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-good-url');
    expect(rule?.kind).toBe('url_prefix');
  });

  test('codex iter-8 P2 — ip with un-normalizable value falls through to unknown_rule (fail-closed)', () => {
    // Pre-fix: malformed `ip: 'not-an-ip'` was preserved as kind:'ip', a
    // silent no-op. Post-fix: rule is mapped to unknown_rule with effect:'deny'
    // so it surfaces in matchedDenyRuleIds when matched.
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-bad-ip',
          ruleKind: 'ip',
          effect: 'allow',
          payload: { ip: 'not-an-ip' },
        },
      ]),
    );
    expect(findById(scope.allowRules, 'r-bad-ip')).toBeUndefined();
    const rule = findById(scope.denyRules, 'r-bad-ip');
    expect(rule?.kind).toBe('unknown_rule');
    expect(rule?.effect).toBe('deny');
    if (rule?.kind === 'unknown_rule') {
      expect(rule.rawRuleKind).toBe('ip');
    }
  });

  test('codex iter-8 P2 — cidr with un-canonical value falls through to unknown_rule (fail-closed)', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-bad-cidr',
          ruleKind: 'cidr',
          effect: 'allow',
          payload: { cidr: 'not-cidr' },
        },
      ]),
    );
    expect(findById(scope.allowRules, 'r-bad-cidr')).toBeUndefined();
    const rule = findById(scope.denyRules, 'r-bad-cidr');
    expect(rule?.kind).toBe('unknown_rule');
    expect(rule?.effect).toBe('deny');
  });

  test('codex iter-8 P2 — cidr with malformed prefix `8.8.8.0/bad` → unknown_rule', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-bad-cidr-prefix',
          ruleKind: 'cidr',
          effect: 'deny',
          payload: { cidr: '8.8.8.0/bad' },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-bad-cidr-prefix');
    expect(rule?.kind).toBe('unknown_rule');
  });

  test('codex iter-8 P2 — cidr with out-of-range prefix → unknown_rule', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-cidr-prefix-overflow',
          ruleKind: 'cidr',
          effect: 'deny',
          payload: { cidr: '192.168.0.0/64' }, // IPv4 max is /32
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-cidr-prefix-overflow');
    expect(rule?.kind).toBe('unknown_rule');
  });
});

describe('buildEffectiveScope — codex iter-10 P2 (legacy domain payload + inverted time_window)', () => {
  test('iter-10 P2 — legacy {domain, matchSubdomains} payload translates to {pattern, matchSubdomains}', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-legacy-domain',
          ruleKind: 'domain',
          effect: 'allow',
          payload: { domain: 'example.com', matchSubdomains: true },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-legacy-domain');
    expect(rule?.kind).toBe('domain');
    if (rule?.kind === 'domain') {
      expect(rule.pattern).toBe('example.com');
      expect(rule.matchSubdomains).toBe(true);
    }
  });

  test('iter-10 P2 — legacy {domain} subdomain payload translates to {parent}', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-legacy-sub',
          ruleKind: 'subdomain',
          effect: 'deny',
          payload: { domain: 'internal.example.com' },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-legacy-sub');
    expect(rule?.kind).toBe('subdomain');
    if (rule?.kind === 'subdomain') {
      expect(rule.parent).toBe('internal.example.com');
    }
  });

  test('iter-10 P2 — both `domain` and `pattern` present → forward shape (`pattern`) wins', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-both',
          ruleKind: 'domain',
          effect: 'allow',
          payload: {
            domain: 'legacy.example.com',
            pattern: 'forward.example.com',
            matchSubdomains: false,
          },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-both');
    if (rule?.kind === 'domain') {
      expect(rule.pattern).toBe('forward.example.com');
    }
  });

  test('iter-10 P2 — domain rule with neither domain nor pattern → unknown_rule', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-empty-domain',
          ruleKind: 'domain',
          effect: 'allow',
          payload: { matchSubdomains: true },
        },
      ]),
    );
    expect(findById(scope.allowRules, 'r-empty-domain')).toBeUndefined();
    const rule = findById(scope.denyRules, 'r-empty-domain');
    expect(rule?.kind).toBe('unknown_rule');
  });

  test('iter-10 P2 — inverted time_window (start > end) → unknown_rule fail-closed', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-inverted',
          ruleKind: 'time_window',
          effect: 'deny',
          payload: {
            start: '2026-04-28T12:00:00.000Z',
            end: '2026-04-28T11:00:00.000Z',
          },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-inverted');
    expect(rule?.kind).toBe('unknown_rule');
    expect(rule?.effect).toBe('deny');
  });

  test('iter-10 P2 — zero-length time_window (start === end) → unknown_rule', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-zero',
          ruleKind: 'time_window',
          effect: 'deny',
          payload: {
            start: '2026-04-28T12:00:00.000Z',
            end: '2026-04-28T12:00:00.000Z',
          },
        },
      ]),
    );
    const rule = findById(scope.denyRules, 'r-zero');
    expect(rule?.kind).toBe('unknown_rule');
  });

  test('iter-10 P2 — inverted time_window allow → unknown_rule deny (still fail-closed)', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-inverted-allow',
          ruleKind: 'time_window',
          effect: 'allow',
          payload: {
            start: '2026-04-28T13:00:00.000Z',
            end: '2026-04-28T11:00:00.000Z',
          },
        },
      ]),
    );
    expect(findById(scope.allowRules, 'r-inverted-allow')).toBeUndefined();
    const rule = findById(scope.denyRules, 'r-inverted-allow');
    expect(rule?.kind).toBe('unknown_rule');
    expect(rule?.effect).toBe('deny');
  });

  test('iter-10 P2 — valid time_window still parses normally', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        {
          id: 'r-valid-tw',
          ruleKind: 'time_window',
          effect: 'allow',
          payload: {
            start: '2026-04-28T10:00:00.000Z',
            end: '2026-04-28T14:00:00.000Z',
          },
        },
      ]),
    );
    const rule = findById(scope.allowRules, 'r-valid-tw');
    expect(rule?.kind).toBe('time_window');
  });
});

describe('buildEffectiveScope — bucketing + freeze', () => {
  test('allow + deny rules land in respective buckets by effect', () => {
    const scope = buildEffectiveScope(
      baseInputs([
        { id: 'a1', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
        { id: 'd1', ruleKind: 'port', effect: 'deny', payload: { port: 22 } },
      ]),
    );
    expect(scope.allowRules.some((r) => r.id === 'a1')).toBe(true);
    expect(scope.denyRules.some((r) => r.id === 'd1')).toBe(true);
  });

  test('returned scope is frozen', () => {
    const scope = buildEffectiveScope(baseInputs([]));
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.allowRules)).toBe(true);
    expect(Object.isFrozen(scope.denyRules)).toBe(true);
  });

  test('legacyToRaw helper passes through rule ids', () => {
    const raw = legacyToRaw([
      {
        id: 'l1',
        ruleKind: 'gibberish',
        effect: 'allow',
        payload: { whatever: 1 },
      },
    ]);
    expect(raw[0]?.id).toBe('l1');
    expect(raw[0]?.ruleKind).toBe('gibberish');
  });
});
