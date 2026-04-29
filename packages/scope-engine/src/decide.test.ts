import { describe, expect, test } from 'bun:test';
import { decide } from './decide.ts';
import { DEFAULT_PLATFORM_POLICY, buildEffectiveScope } from './effective-scope.ts';
import type {
  AssessmentFlags,
  Clock,
  DnsResolver,
  EffectiveScope,
  EngineDeps,
  NormalizedRule,
  RateLimitCounter,
  TimeWindow,
  ToolPolicy,
} from './types.ts';

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

const recordingDns = (table: Record<string, string[]>): DnsResolver => ({
  resolveA: async (host) => table[host] ?? [],
  resolveAAAA: async () => [],
});

const okRateLimit = (): RateLimitCounter => ({ consume: () => ({ ok: true }) });
const exhaustedRateLimit = (): RateLimitCounter => ({
  consume: () => ({ ok: false, retryAfterMs: 1000 }),
});

interface ScopeOverrides {
  allowRules?: NormalizedRule[];
  denyRules?: NormalizedRule[];
  timeWindow?: TimeWindow | null;
  assessmentFlags?: AssessmentFlags;
  toolCatalog?: ReadonlyMap<string, ToolPolicy>;
}

const basicScope = (overrides: ScopeOverrides = {}): EffectiveScope => {
  // Build a minimal scope, then if overrides specify rules, replace.
  const built = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy: { tenantId: 't1' },
    platformPolicy: DEFAULT_PLATFORM_POLICY,
    rawRules: [],
    toolCatalog: overrides.toolCatalog ?? new Map<string, ToolPolicy>(),
    assessmentFlags: overrides.assessmentFlags ?? {
      highImpactCategories: [],
      ownershipVerifiedTargetIds: new Set(),
    },
    timeWindow: overrides.timeWindow ?? null,
  });
  if (overrides.allowRules || overrides.denyRules) {
    return Object.freeze({
      ...built,
      allowRules: Object.freeze([...(overrides.allowRules ?? [])]) as readonly NormalizedRule[],
      denyRules: Object.freeze([...(overrides.denyRules ?? [])]) as readonly NormalizedRule[],
    });
  }
  return built;
};

const baseDeps = (): EngineDeps => ({
  dns: recordingDns({}),
  clock: fixedClock('2026-04-28T12:00:00.000Z'),
  rateLimit: okRateLimit(),
});

describe('scope-engine :: decide — A-SE-Pri-1 deny overrides allow', () => {
  test('overlapping CIDR: deny 10.0.0.0/8 wins over allow cidr 10.1.0.0/16', async () => {
    const scopeWithCidr = basicScope({
      allowRules: [
        { id: 'allow1', kind: 'cidr', effect: 'allow', cidr: '10.1.0.0/16' },
        { id: 'allow2', kind: 'port', effect: 'allow', port: 443 },
        { id: 'allow3', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'allow4', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
      ],
      denyRules: [{ id: 'deny1', kind: 'cidr', effect: 'deny', cidr: '10.0.0.0/8' }],
    });
    const deps: EngineDeps = {
      ...baseDeps(),
      dns: recordingDns({ 'x.io': ['10.1.2.3'] }),
    };
    const decision = await decide(
      scopeWithCidr,
      { kind: 'http_request', url: 'https://x.io/api', method: 'GET' },
      deps,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_by_rule');
    expect(decision.matchedDenyRuleIds).toContain('deny1');
  });
});

describe('scope-engine :: decide — A-SE-SSRF', () => {
  test('SSRF-1 — http://169.254.169.254/ blocked as metadata_ip_blocked', async () => {
    const scope = basicScope();
    const deps = baseDeps();
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'http://169.254.169.254/latest/meta-data/' },
      deps,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('metadata_ip_blocked');
  });

  test('SSRF-1 — Yandex Cloud metadata 100.100.100.200 blocked', async () => {
    const scope = basicScope();
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'http://100.100.100.200/latest/' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('metadata_ip_blocked');
  });

  test('SSRF-2 — domain resolves to private IP → blocked default; allow with explicit cidr permits', async () => {
    const scope1 = basicScope({
      allowRules: [
        {
          id: 'a1',
          kind: 'domain',
          effect: 'allow',
          pattern: 'internal.example.com',
          matchSubdomains: false,
        },
        { id: 'a2', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const deps = {
      ...baseDeps(),
      dns: recordingDns({ 'internal.example.com': ['192.168.1.10'] }),
    };
    const denied = await decide(
      scope1,
      { kind: 'http_request', url: 'https://internal.example.com/' },
      deps,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('private_ip_blocked');

    const scope2 = basicScope({
      allowRules: [
        {
          id: 'a1',
          kind: 'domain',
          effect: 'allow',
          pattern: 'internal.example.com',
          matchSubdomains: false,
        },
        { id: 'a2', kind: 'cidr', effect: 'allow', cidr: '192.168.0.0/16' },
        { id: 'a3', kind: 'protocol', effect: 'allow', protocol: 'https' },
        // codex iter-9 P2 — effectivePort=443 from default-port elision now
        // requires port-dimension coverage.
        { id: 'a4', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [],
    });
    const allowed = await decide(
      scope2,
      { kind: 'http_request', url: 'https://internal.example.com/' },
      deps,
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toBe('allowed');
  });

  test('R11 — mixed resolution [pub, priv] vs [priv, pub] yields identical deny decisions (order-independent)', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a1',
          kind: 'domain',
          effect: 'allow',
          pattern: 'mixed.example.com',
          matchSubdomains: false,
        },
        { id: 'a2', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a3', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });

    const deps1 = {
      ...baseDeps(),
      dns: recordingDns({ 'mixed.example.com': ['8.8.8.8', '192.168.1.5'] }),
    };
    const deps2 = {
      ...baseDeps(),
      dns: recordingDns({ 'mixed.example.com': ['192.168.1.5', '8.8.8.8'] }),
    };
    const d1 = await decide(
      scope,
      { kind: 'http_request', url: 'https://mixed.example.com/' },
      deps1,
    );
    const d2 = await decide(
      scope,
      { kind: 'http_request', url: 'https://mixed.example.com/' },
      deps2,
    );
    expect(d1.allowed).toBe(false);
    expect(d2.allowed).toBe(false);
    expect(d1.reason).toBe(d2.reason);
    expect(d1.reason).toBe('private_ip_blocked');
  });
});

describe('scope-engine :: decide — A-SE-Time-Boundary-1 (R2 + R3)', () => {
  const buildWindowScope = () =>
    basicScope({
      timeWindow: { start: '2026-04-28T10:00:00.000Z', end: '2026-04-28T14:00:00.000Z' },
      allowRules: [
        { id: 'a1', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a2', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a3', kind: 'protocol', effect: 'allow', protocol: 'https' },
        // codex iter-9 P2 — effectivePort coverage required.
        { id: 'a4', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [],
    });

  const action = { kind: 'http_request' as const, url: 'https://x.io/' };
  const dnsX = recordingDns({ 'x.io': ['8.8.8.8'] });

  test('R2 — sequential calls: no retroactive mutation', async () => {
    const scope = buildWindowScope();
    const t1 = '2026-04-28T13:59:59.999Z';
    const t2 = '2026-04-28T14:00:00.001Z';
    const clock1: Clock = { now: () => new Date(t1) };
    const clock2: Clock = { now: () => new Date(t2) };
    const d1 = await decide(scope, action, { ...baseDeps(), dns: dnsX, clock: clock1 });
    expect(d1.allowed).toBe(true);
    // Snapshot d1 before call #2.
    const d1Frozen = JSON.parse(JSON.stringify(d1));
    const d2 = await decide(scope, action, { ...baseDeps(), dns: dnsX, clock: clock2 });
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toBe('time_window_closed');
    // Confirm d1 untouched by d2's evaluation.
    expect(JSON.parse(JSON.stringify(d1))).toEqual(d1Frozen);
  });

  test('R3 — half-open boundary [start, end): 5 boundary points', async () => {
    const scope = buildWindowScope();
    const points: Array<[string, boolean]> = [
      ['2026-04-28T09:59:59.999Z', false], // start - 1ms
      ['2026-04-28T10:00:00.000Z', true], // start
      ['2026-04-28T13:59:59.999Z', true], // end - 1ms
      ['2026-04-28T14:00:00.000Z', false], // end (excluded)
      ['2026-04-28T14:00:00.001Z', false], // end + 1ms
    ];
    for (const [iso, expected] of points) {
      const d = await decide(scope, action, {
        ...baseDeps(),
        dns: dnsX,
        clock: { now: () => new Date(iso) },
      });
      expect(d.allowed).toBe(expected);
    }
  });
});

describe('scope-engine :: decide — codex P1 tool_invoke SSRF guards', () => {
  test('tool_invoke targetRef URL resolving to private IP → DENY private_ip_blocked', async () => {
    // Default platform policy. Allow rules say "tool, host, recon-cat" — would
    // pass if SSRF guard didn't fire. Codex bug: prior to fix, resolvedIps was
    // empty for tool_invoke URL targetRefs and the platform private-IP guard
    // never ran.
    const scope = basicScope({
      allowRules: [
        { id: 'a-tn', kind: 'tool_name', effect: 'allow', toolName: 'nuclei' },
        { id: 'a-tc', kind: 'tool_category', effect: 'allow', category: 'recon' },
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'internal.example.com',
          matchSubdomains: false,
        },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'nuclei',
        toolCategory: 'recon',
        targetRef: 'https://internal.example.com/',
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'internal.example.com': ['192.168.1.10'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('private_ip_blocked');
  });

  test('tool_invoke targetRef hostname resolving to metadata IP → DENY metadata_ip_blocked', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a-tn', kind: 'tool_name', effect: 'allow', toolName: 'naabu' },
        { id: 'a-tc', kind: 'tool_category', effect: 'allow', category: 'recon' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'naabu',
        toolCategory: 'recon',
        targetRef: 'aws-metadata.local',
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'aws-metadata.local': ['169.254.169.254'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('metadata_ip_blocked');
  });

  test('tool_invoke targetRef URL resolving to private IP with explicit cidr allow → permits', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a-tn', kind: 'tool_name', effect: 'allow', toolName: 'nuclei' },
        { id: 'a-tc', kind: 'tool_category', effect: 'allow', category: 'recon' },
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'internal.example.com',
          matchSubdomains: false,
        },
        { id: 'a-cidr', kind: 'cidr', effect: 'allow', cidr: '192.168.0.0/16' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'nuclei',
        toolCategory: 'recon',
        targetRef: 'https://internal.example.com/',
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'internal.example.com': ['192.168.1.10'] }),
      },
    );
    expect(decision.reason).not.toBe('private_ip_blocked');
  });
});

describe('scope-engine :: decide — codex iter-10 P1 (verify by target ID, not canonical ref)', () => {
  test('iter-10 P1 — two targets canonicalize to same ref (URL + matching domain), only one verified → DENY', async () => {
    // Pre-fix: Set<ref> dedupe — both targets canonicalize to `example.com`,
    // verified-refs set contains `example.com`, gate passes silently.
    // Post-fix: assessmentTargetIds={t-url,t-domain}, verifiedTargetIds={t-url}
    // → ID-set inequality → DENY high_impact_target_unverified.
    const scope = basicScope({
      toolCatalog: new Map<string, ToolPolicy>([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t-url']),
        assessmentTargetRefs: new Set(['example.com']),
        verifiedTargetRefs: new Set(['example.com']),
        assessmentTargetIds: new Set(['t-url', 't-domain']),
        verifiedTargetIds: new Set(['t-url']),
      },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'example.com',
      },
      { ...baseDeps(), dns: recordingDns({ 'example.com': ['8.8.8.8'] }) },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('high_impact_target_unverified');
  });

  test('iter-10 P1 — both targets verified (same canonical ref) → gate passes', async () => {
    const scope = basicScope({
      toolCatalog: new Map<string, ToolPolicy>([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t-url', 't-domain']),
        assessmentTargetRefs: new Set(['example.com']),
        verifiedTargetRefs: new Set(['example.com']),
        assessmentTargetIds: new Set(['t-url', 't-domain']),
        verifiedTargetIds: new Set(['t-url', 't-domain']),
      },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'example.com',
      },
      { ...baseDeps(), dns: recordingDns({ 'example.com': ['8.8.8.8'] }) },
    );
    expect(decision.toolPolicyResult?.highImpactGateOk).toBe(true);
  });

  test('iter-10 P1 — 2 distinct refs, both verified → gate passes (sanity)', async () => {
    const scope = basicScope({
      toolCatalog: new Map<string, ToolPolicy>([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t1', 't2']),
        assessmentTargetRefs: new Set(['a.example.com', 'b.example.com']),
        verifiedTargetRefs: new Set(['a.example.com', 'b.example.com']),
        assessmentTargetIds: new Set(['t1', 't2']),
        verifiedTargetIds: new Set(['t1', 't2']),
      },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'a.example.com',
      },
      { ...baseDeps(), dns: recordingDns({ 'a.example.com': ['8.8.8.8'] }) },
    );
    expect(decision.toolPolicyResult?.highImpactGateOk).toBe(true);
  });
});

describe('scope-engine :: decide — codex iter-9 (all-targets-verified + effectivePort coverage + unknown_rule diagnostic)', () => {
  test('iter-9 P1 — high-impact + 1-of-2 verified targets → DENY high_impact_target_unverified', async () => {
    const scope = basicScope({
      toolCatalog: new Map<string, ToolPolicy>([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t-verified']),
        assessmentTargetRefs: new Set(['verified.example.com', 'unverified.example.com']),
        verifiedTargetRefs: new Set(['verified.example.com']),
      },
    });
    // Action targets the verified one, but other unverified target exists.
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'verified.example.com',
      },
      { ...baseDeps(), dns: recordingDns({ 'verified.example.com': ['8.8.8.8'] }) },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('high_impact_target_unverified');
  });

  test('iter-9 P1 — high-impact + 2-of-2 verified targets → gate passes', async () => {
    const scope = basicScope({
      toolCatalog: new Map<string, ToolPolicy>([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t1', 't2']),
        assessmentTargetRefs: new Set(['a.example.com', 'b.example.com']),
        verifiedTargetRefs: new Set(['a.example.com', 'b.example.com']),
      },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'a.example.com',
      },
      { ...baseDeps(), dns: recordingDns({ 'a.example.com': ['8.8.8.8'] }) },
    );
    expect(decision.toolPolicyResult?.highImpactGateOk).toBe(true);
  });

  test('iter-9 P1 — high-impact with opaque CIDR action targetRef + 1-of-2 verified → DENY', async () => {
    // Action targets CIDR/opaque ref that doesn't exact-match any
    // assessmentTargetRef. Pre-fix: per-target check skipped → ALLOWED.
    // Post-fix: all-verified rule fires regardless.
    const scope = basicScope({
      toolCatalog: new Map<string, ToolPolicy>([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t-verified']),
        assessmentTargetRefs: new Set(['a.example.com', 'b.example.com']),
        verifiedTargetRefs: new Set(['a.example.com']),
      },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'opaque target value',
      },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('high_impact_target_unverified');
  });

  test('iter-9 P2 — effectivePort=443 from default-port elision requires port allow', async () => {
    // Allow rules cover host/ip/protocol but no port and no url_prefix.
    // Pre-fix: target.port=undefined → port-coverage skipped → ALLOWED.
    // Post-fix: effectivePort=443 triggers port-coverage check → DENY.
    const scope = basicScope({
      allowRules: [
        { id: 'a-host', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io/' },
      { ...baseDeps(), dns: recordingDns({ 'x.io': ['8.8.8.8'] }) },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_matching_allow_rule');
  });

  test('iter-9 P2 — explicit-port URL also requires port allow', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a-host', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io:443/' },
      { ...baseDeps(), dns: recordingDns({ 'x.io': ['8.8.8.8'] }) },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_matching_allow_rule');
  });

  test('iter-9 P2 — adding port:443 allow makes both elided and explicit URLs ALLOW', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a-host', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [],
    });
    const elided = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io/' },
      { ...baseDeps(), dns: recordingDns({ 'x.io': ['8.8.8.8'] }) },
    );
    expect(elided.allowed).toBe(true);
    const explicit = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io:443/' },
      { ...baseDeps(), dns: recordingDns({ 'x.io': ['8.8.8.8'] }) },
    );
    expect(explicit.allowed).toBe(true);
  });

  test('iter-9 P2 — mixed unknown+real deny matches → real-rule diagnostic wins', async () => {
    // Unknown_rule + real deny rule both match → reason should be
    // 'denied_by_rule' (the real rule fired); matchedDenyRuleIds includes both.
    const scope = buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy: { tenantId: 't1' },
      rawRules: [
        { id: 'unknown-1', ruleKind: 'future_rule', effect: 'deny', payload: {} },
        {
          id: 'real-deny-1',
          ruleKind: 'domain',
          effect: 'deny',
          payload: { pattern: 'x.io', matchSubdomains: false },
        },
      ],
      toolCatalog: new Map(),
      assessmentFlags: { highImpactCategories: [], ownershipVerifiedTargetIds: new Set() },
      timeWindow: null,
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io/' },
      { ...baseDeps(), dns: recordingDns({ 'x.io': ['8.8.8.8'] }) },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_by_rule');
    expect(decision.matchedDenyRuleIds).toContain('unknown-1');
    expect(decision.matchedDenyRuleIds).toContain('real-deny-1');
  });
});

describe('scope-engine :: decide — codex iter-8 P1 (uncatalogued tool + percent-encoded path)', () => {
  test('iter-8 P1 — uncatalogued tool denies BEFORE rule matching with tool_not_in_catalog', async () => {
    // Pre-fix: catalog had only `nuclei` but action invoked `not-in-catalog`;
    // broad `tool_category:'web'` allow + host/protocol allows let it through.
    // Post-fix: tool_invoke with toolName + inCatalog=false → DENY.
    const scope = basicScope({
      toolCatalog: new Map<string, ToolPolicy>([
        ['nuclei', { toolName: 'nuclei', category: 'recon', highImpact: false }],
      ]),
      allowRules: [
        { id: 'a-tc', kind: 'tool_category', effect: 'allow', category: 'web' },
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'x.example',
          matchSubdomains: false,
        },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'not-in-catalog',
        toolCategory: 'web',
        targetRef: 'https://x.example/',
      },
      { ...baseDeps(), dns: recordingDns({ 'x.example': ['8.8.8.8'] }) },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('tool_not_in_catalog');
  });

  test('iter-8 P1 — catalogued tool with same shape ALLOWS', async () => {
    const scope = basicScope({
      toolCatalog: new Map<string, ToolPolicy>([
        ['nuclei', { toolName: 'nuclei', category: 'recon', highImpact: false }],
      ]),
      allowRules: [
        { id: 'a-tn', kind: 'tool_name', effect: 'allow', toolName: 'nuclei' },
        { id: 'a-tc', kind: 'tool_category', effect: 'allow', category: 'recon' },
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'x.example',
          matchSubdomains: false,
        },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'nuclei',
        toolCategory: 'recon',
        targetRef: 'https://x.example/',
      },
      { ...baseDeps(), dns: recordingDns({ 'x.example': ['8.8.8.8'] }) },
    );
    expect(decision.allowed).toBe(true);
  });

  test('iter-8 P1 — percent-encoded path denied by `/admin` path_pattern', async () => {
    // Pre-fix: `/%61dmin` (encoded `a`) bypassed `/admin` deny rule because
    // path normalization didn't decode unreserved chars. Post-fix:
    // collapsePath decodes %61 → 'a' before matching, deny fires.
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'example.com',
          matchSubdomains: false,
        },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
        {
          id: 'a-prefix',
          kind: 'url_prefix',
          effect: 'allow',
          prefix: 'https://example.com/',
        },
      ],
      denyRules: [{ id: 'd-admin', kind: 'path_pattern', effect: 'deny', glob: '/admin' }],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://example.com/%61dmin' },
      { ...baseDeps(), dns: recordingDns({ 'example.com': ['8.8.8.8'] }) },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_by_rule');
    expect(decision.matchedDenyRuleIds).toContain('d-admin');
  });

  test('iter-8 P1 — encoded `..` collapsed by path-traversal logic', async () => {
    // `/%2E%2E/etc` → decode → `/../etc` → collapse to `/etc`.
    // The action effectively targets `/etc`; deny on `/etc` should match.
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'example.com',
          matchSubdomains: false,
        },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
        {
          id: 'a-prefix',
          kind: 'url_prefix',
          effect: 'allow',
          prefix: 'https://example.com/',
        },
      ],
      denyRules: [{ id: 'd-etc', kind: 'path_pattern', effect: 'deny', glob: '/etc' }],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://example.com/%2E%2E/etc' },
      { ...baseDeps(), dns: recordingDns({ 'example.com': ['8.8.8.8'] }) },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_by_rule');
    expect(decision.matchedDenyRuleIds).toContain('d-etc');
  });

  test('iter-8 P1 — malformed percent-encoding → normalization_error', async () => {
    const scope = basicScope();
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://example.com/%G0' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('normalization_error');
  });
});

describe('scope-engine :: decide — codex iter-7 P1 (tool_invoke URL protocol + rate-limit tenant isolation)', () => {
  test('iter-7 P1 — tool_invoke URL targetRef populates protocol; deny http blocks tool over http', async () => {
    // Pre-fix: tool_invoke URL → no protocol field → protocol deny rules
    // never matched. Post-fix: protocol mirrors http_request mapping, deny
    // fires.
    const scope = basicScope({
      // codex iter-8 P1 — uncatalogued tools deny first, so seed the catalog.
      toolCatalog: new Map<string, ToolPolicy>([
        ['nuclei', { toolName: 'nuclei', category: 'recon', highImpact: false }],
      ]),
      allowRules: [
        { id: 'a-tn', kind: 'tool_name', effect: 'allow', toolName: 'nuclei' },
        { id: 'a-tc', kind: 'tool_category', effect: 'allow', category: 'recon' },
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'example.com',
          matchSubdomains: false,
        },
      ],
      denyRules: [{ id: 'd-http', kind: 'protocol', effect: 'deny', protocol: 'http' }],
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'nuclei',
        toolCategory: 'recon',
        targetRef: 'http://example.com/',
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'example.com': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_by_rule');
    expect(decision.matchedDenyRuleIds).toContain('d-http');
  });

  test('iter-7 P1 — tool_invoke URL with full allow set ALLOWS', async () => {
    const scope = basicScope({
      toolCatalog: new Map<string, ToolPolicy>([
        ['nuclei', { toolName: 'nuclei', category: 'recon', highImpact: false }],
      ]),
      allowRules: [
        { id: 'a-tn', kind: 'tool_name', effect: 'allow', toolName: 'nuclei' },
        { id: 'a-tc', kind: 'tool_category', effect: 'allow', category: 'recon' },
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'example.com',
          matchSubdomains: false,
        },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'nuclei',
        toolCategory: 'recon',
        targetRef: 'https://example.com/',
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'example.com': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.normalizedTarget?.protocol).toBe('https');
    expect(decision.normalizedTarget?.effectivePort).toBe(443);
  });

  test('iter-7 P1 — rate-limit bucket key namespaced by tenantId+assessmentId; t1 exhaustion does NOT affect t2', async () => {
    // Custom counter: tracks each key independently. Verifies the engine
    // passes a namespaced key (so t1 and t2 with same bucket name don't collide).
    const counts = new Map<string, number>();
    const counter = {
      consume: (key: string, perSecond: number, _burst: number) => {
        const used = counts.get(key) ?? 0;
        if (used >= perSecond) return { ok: false, retryAfterMs: 1000 };
        counts.set(key, used + 1);
        return { ok: true };
      },
    };
    const allowRules: NormalizedRule[] = [
      { id: 'a-rl', kind: 'rate_limit', effect: 'allow', bucket: 'recon', perSecond: 1, burst: 1 },
      { id: 'a-host', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
      { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
      { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
      { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
    ];
    const scopeT1 = buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy: { tenantId: 't1' },
      rawRules: [],
      toolCatalog: new Map(),
      assessmentFlags: { highImpactCategories: [], ownershipVerifiedTargetIds: new Set() },
      timeWindow: null,
    });
    const t1Scope: EffectiveScope = Object.freeze({
      ...scopeT1,
      allowRules: Object.freeze([...allowRules]) as readonly NormalizedRule[],
      denyRules: Object.freeze([]) as readonly NormalizedRule[],
    });
    const scopeT2 = buildEffectiveScope({
      tenantId: 't2',
      assessmentId: 'a2',
      tenantPolicy: { tenantId: 't2' },
      rawRules: [],
      toolCatalog: new Map(),
      assessmentFlags: { highImpactCategories: [], ownershipVerifiedTargetIds: new Set() },
      timeWindow: null,
    });
    const t2Scope: EffectiveScope = Object.freeze({
      ...scopeT2,
      allowRules: Object.freeze([...allowRules]) as readonly NormalizedRule[],
      denyRules: Object.freeze([]) as readonly NormalizedRule[],
    });
    const action = { kind: 'http_request' as const, url: 'https://x.io/' };
    const deps = {
      ...baseDeps(),
      dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
      rateLimit: counter,
    };
    // First t1 call consumes the t1 bucket.
    const r1 = await decide(t1Scope, action, deps);
    expect(r1.allowed).toBe(true);
    // Second t1 call → exhausted.
    const r2 = await decide(t1Scope, action, deps);
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe('rate_limit_exceeded');
    // First t2 call → MUST succeed (namespaced bucket); pre-fix would have
    // exhausted the shared 'recon' bucket via t1 calls.
    const r3 = await decide(t2Scope, action, deps);
    expect(r3.allowed).toBe(true);
    // Bucket keys recorded separately.
    expect(counts.has('t1:a1:recon')).toBe(true);
    expect(counts.has('t2:a2:recon')).toBe(true);
  });

  test('iter-7 P1 — same tenant + same assessment + same bucket exhaustion still works', async () => {
    const counts = new Map<string, number>();
    const counter = {
      consume: (key: string, perSecond: number, _burst: number) => {
        const used = counts.get(key) ?? 0;
        if (used >= perSecond) return { ok: false };
        counts.set(key, used + 1);
        return { ok: true };
      },
    };
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-rl',
          kind: 'rate_limit',
          effect: 'allow',
          bucket: 'recon',
          perSecond: 1,
          burst: 1,
        },
        { id: 'a-host', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [],
    });
    const action = { kind: 'http_request' as const, url: 'https://x.io/' };
    const deps = { ...baseDeps(), dns: recordingDns({ 'x.io': ['8.8.8.8'] }), rateLimit: counter };
    const r1 = await decide(scope, action, deps);
    expect(r1.allowed).toBe(true);
    const r2 = await decide(scope, action, deps);
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe('rate_limit_exceeded');
  });
});

describe('scope-engine :: decide — codex iter-5 P2 (IP-literal hosts + IPv6)', () => {
  test('iter-5 P2 — https://8.8.8.8/ allowed by ip+protocol+port (no domain rule needed)', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://8.8.8.8/' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
  });

  test('iter-5 P2 — bracketed IPv6 URL allowed by ip rule on the IPv6 literal', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '2001:db8::1' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'http' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 80 },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'http://[2001:db8::1]/' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
  });

  test('iter-5 P2 — tcp_connect ::1 denies as loopback unless explicit allow', async () => {
    const scope = basicScope();
    const decision = await decide(
      scope,
      { kind: 'tcp_connect', host: '::1', port: 22 },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('loopback_blocked');
  });

  test('iter-5 P2 — dns_lookup 2001:db8::1 with ip allow rule', async () => {
    const scope = basicScope({
      allowRules: [{ id: 'a-ip', kind: 'ip', effect: 'allow', ip: '2001:db8::1' }],
      denyRules: [],
    });
    const decision = await decide(scope, { kind: 'dns_lookup', host: '2001:db8::1' }, baseDeps());
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
  });
});

describe('scope-engine :: decide — codex iter-4 P1 (userinfo / port / redirect / DNS-empty)', () => {
  test('iter-4 P1 userinfo — host comes from URL parser, not userinfo prefix', async () => {
    // Pre-fix: manual extraction stops at the colon in `:secret@evil.example`,
    // reports host as `allowed.example` (the userinfo username segment).
    // Post-fix: WHATWG URL.hostname is authoritative → host is `evil.example`.
    // An allow rule for `allowed.example` does NOT match.
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'allowed.example',
          matchSubdomains: false,
        },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://allowed.example:secret@evil.example/' },
      {
        ...baseDeps(),
        dns: recordingDns({ 'evil.example': ['8.8.8.8'] }),
      },
    );
    // Allow on `allowed.example` does not match → no_matching_allow_rule.
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_matching_allow_rule');
    // Canonical URL must NOT contain userinfo.
    expect(decision.normalizedTarget?.url).not.toContain('secret');
    expect(decision.normalizedTarget?.host).toBe('evil.example');
  });

  test('iter-4 P1 effectivePort — deny port:443 blocks https://x/ (default-port elided)', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a-host', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [{ id: 'd-443', kind: 'port', effect: 'deny', port: 443 }],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io/' },
      {
        ...baseDeps(),
        dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_by_rule');
    expect(decision.matchedDenyRuleIds).toContain('d-443');
  });

  test('iter-4 P1 effectivePort — deny port:443 blocks https://x:443/ (explicit port)', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a-host', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [{ id: 'd-443', kind: 'port', effect: 'deny', port: 443 }],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io:443/' },
      {
        ...baseDeps(),
        dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_by_rule');
    expect(decision.matchedDenyRuleIds).toContain('d-443');
  });

  test('iter-4 P1 redirect — redirect to out-of-scope host denies via no_matching_allow_rule', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'safe.example',
          matchSubdomains: false,
        },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'http_request',
        url: 'https://safe.example/',
        followRedirectsTo: ['https://evil.example/'],
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'safe.example': ['8.8.8.8'], 'evil.example': ['9.9.9.9'] }),
      },
    );
    // Primary passes allow; redirect to evil.example has no covering allow.
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_matching_allow_rule');
  });

  test('iter-4 P1 redirect — all redirect URLs in-scope → allowed', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'safe.example',
          matchSubdomains: true,
        },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
        // codex iter-9 P2 — effectivePort=443 coverage required.
        { id: 'a-port', kind: 'port', effect: 'allow', port: 443 },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'http_request',
        url: 'https://safe.example/',
        followRedirectsTo: [
          'https://a.safe.example/',
          'https://b.safe.example/',
          'https://c.safe.example/',
        ],
      },
      {
        ...baseDeps(),
        dns: recordingDns({
          'safe.example': ['8.8.8.8'],
          'a.safe.example': ['8.8.8.8'],
          'b.safe.example': ['8.8.8.8'],
          'c.safe.example': ['8.8.8.8'],
        }),
      },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
  });

  test('iter-4 P1 redirect — redirect to metadata IP denies via metadata_ip_blocked', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'safe.example',
          matchSubdomains: false,
        },
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'http_request',
        url: 'https://safe.example/',
        followRedirectsTo: ['http://169.254.169.254/'],
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'safe.example': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('metadata_ip_blocked');
  });

  test('iter-4 P1 dns_resolution_failed — empty DNS response on hostname → DENY', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: 'nonexistent.invalid',
          matchSubdomains: false,
        },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://nonexistent.invalid/' },
      {
        ...baseDeps(),
        dns: recordingDns({}), // no entries → empty resolution
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('dns_resolution_failed');
  });

  test('iter-4 P1 dns_resolution — raw IP target is `not_applicable`, never fails closed', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a-ip', kind: 'ip', effect: 'allow', ip: '1.2.3.4' },
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: '1.2.3.4',
          matchSubdomains: false,
        },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://1.2.3.4/' },
      { ...baseDeps(), dns: recordingDns({}) }, // resolver should not be consulted
    );
    expect(decision.reason).not.toBe('dns_resolution_failed');
    expect(decision.normalizedTarget?.dnsResolution).toBe('not_applicable');
  });
});

describe('scope-engine :: decide — codex P1 catalog-driven high-impact + ownership gate', () => {
  const catalogWith = (entries: Array<[string, ToolPolicy]>): ReadonlyMap<string, ToolPolicy> =>
    new Map(entries);

  test('catalogued tool — caller-supplied toolCategory cannot bypass HIGH_IMPACT_CATEGORIES', async () => {
    // Catalog says metasploit is post_exploit/highImpact:true. Caller lies
    // by claiming toolCategory:'web'. Pre-fix: highImpact derived from caller
    // → false → gate bypassed. Post-fix: catalog wins → highImpact=true →
    // category_mismatch is detected and denies.
    const scope = basicScope({
      toolCatalog: catalogWith([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t-verified']),
      },
      allowRules: [
        { id: 'a-tn', kind: 'tool_name', effect: 'allow', toolName: 'metasploit' },
        { id: 'a-tc', kind: 'tool_category', effect: 'allow', category: 'web' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'web',
        targetRef: 'opaque target value',
      },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('tool_category_mismatch');
  });

  test('catalogued tool — caller agrees with catalog → category passes through, high-impact gate runs', async () => {
    const scope = basicScope({
      toolCatalog: catalogWith([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t-verified']),
      },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'opaque target value',
      },
      baseDeps(),
    );
    expect(decision.toolPolicyResult?.highImpact).toBe(true);
    expect(decision.toolPolicyResult?.category).toBe('post_exploit');
    expect(decision.toolPolicyResult?.highImpactGateOk).toBe(true);
  });

  test('declared post_exploit + zero verified targets → DENY high_impact_unverified_ownership', async () => {
    // Category declared in highImpactCategories but ownershipVerifiedTargetIds
    // is empty → fail the verified-ownership gate.
    const scope = basicScope({
      toolCatalog: catalogWith([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(),
      },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'opaque target value',
      },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('high_impact_unverified_ownership');
  });

  test('declared + verified other-target + action-target unverified → DENY high_impact_target_unverified', async () => {
    // assessmentTargetRefs covers two refs; only 'verified.example.com' is
    // verified. Action targets 'unverified.example.com' which IS an assessment
    // target but NOT verified.
    const scope = basicScope({
      toolCatalog: catalogWith([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t-verified']),
        assessmentTargetRefs: new Set(['verified.example.com', 'unverified.example.com']),
        verifiedTargetRefs: new Set(['verified.example.com']),
      },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'unverified.example.com',
      },
      // Provide DNS so codex iter-4 P1 fail-closed doesn't fire on empty.
      {
        ...baseDeps(),
        dns: recordingDns({ 'unverified.example.com': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('high_impact_target_unverified');
  });

  test('declared + verified action target → high-impact gate passes', async () => {
    const scope = basicScope({
      toolCatalog: catalogWith([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['t-verified']),
        assessmentTargetRefs: new Set(['verified.example.com']),
        verifiedTargetRefs: new Set(['verified.example.com']),
      },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'verified.example.com',
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'verified.example.com': ['8.8.8.8'] }),
      },
    );
    expect(decision.toolPolicyResult?.highImpactGateOk).toBe(true);
  });
});

describe('scope-engine :: decide — tool-category high-impact gate', () => {
  test('post_exploit without declaration → deny tool_category_high_impact_unverified_targets', async () => {
    const scope = basicScope({
      // codex iter-8 P1 — seed catalog so uncatalogued-tool gate doesn't fire first.
      toolCatalog: new Map<string, ToolPolicy>([
        ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
      ]),
      assessmentFlags: { highImpactCategories: [], ownershipVerifiedTargetIds: new Set() },
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'https://x.io/',
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('tool_category_high_impact_unverified_targets');
  });
});

describe('scope-engine :: decide — rate limit', () => {
  test('exhausted bucket → rate_limit_exceeded', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a1', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a2', kind: 'protocol', effect: 'allow', protocol: 'https' },
        {
          id: 'a3',
          kind: 'rate_limit',
          effect: 'allow',
          bucket: 'recon',
          perSecond: 5,
          burst: 10,
        },
        { id: 'a4', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io/' },
      {
        ...baseDeps(),
        dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
        rateLimit: exhaustedRateLimit(),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('rate_limit_exceeded');
  });
});

describe('scope-engine :: decide — IDN homograph default-deny (OQ-8)', () => {
  test('Cyrillic-Latin mixed-script host → mixed_script_host_blocked', async () => {
    const cyrillicO = 'о';
    const homograph = `g${cyrillicO}${cyrillicO}gle.com`;
    const scope = basicScope();
    const decision = await decide(
      scope,
      { kind: 'http_request', url: `https://${homograph}/` },
      {
        ...baseDeps(),
        dns: recordingDns({}),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('mixed_script_host_blocked');
  });
});

describe('scope-engine :: decide — happy path', () => {
  test('all-allow, public IP, port 443, https → allowed', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a1', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a2', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a3', kind: 'port', effect: 'allow', port: 443 },
        { id: 'a4', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io:443/' },
      {
        ...baseDeps(),
        dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
  });
});

describe('scope-engine :: decide — A-SE-Pri-3 unknown rule default-deny', () => {
  test('legacy-shape rule with out-of-set ruleKind denies', async () => {
    const scope = buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy: { tenantId: 't1' },
      rawRules: [
        { id: 'legacy1', ruleKind: 'gibberish_kind', effect: 'deny', payload: { junk: 1 } },
      ],
      toolCatalog: new Map(),
      assessmentFlags: { highImpactCategories: [], ownershipVerifiedTargetIds: new Set() },
      timeWindow: null,
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io/' },
      {
        ...baseDeps(),
        dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    // codex iter-9 P2 — when ALL matched deny rules are unknown_rule, the
    // diagnostic surfaces as 'unknown_rule_default_deny' (vs generic
    // 'denied_by_rule' which is reserved for real-rule matches).
    expect(decision.reason).toBe('unknown_rule_default_deny');
    expect(decision.matchedDenyRuleIds).toContain('legacy1');
  });

  test('codex P2 — unknown rule persisted with effect:allow is fail-closed and denies any action', async () => {
    // Scope contains:
    //   - One UNKNOWN rule persisted with effect:'allow' (must be coerced to deny + applied)
    //   - Plus a complete set of true allow rules that would otherwise let the action pass.
    // Result: deny via the unknown-rule, with 'unknown-rule-id' in matchedDenyRuleIds.
    const scope = buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy: { tenantId: 't1' },
      rawRules: [
        { id: 'unknown-rule-id', ruleKind: 'future_rule', effect: 'allow', payload: {} },
        // The following rows would individually allow the action.
        {
          id: 'a1',
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 'x.io', matchSubdomains: false },
        },
        { id: 'a2', ruleKind: 'ip', effect: 'allow', payload: { ip: '8.8.8.8' } },
        { id: 'a3', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'https' } },
        { id: 'a4', ruleKind: 'port', effect: 'allow', payload: { port: 443 } },
      ],
      toolCatalog: new Map(),
      assessmentFlags: { highImpactCategories: [], ownershipVerifiedTargetIds: new Set() },
      timeWindow: null,
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io:443/' },
      {
        ...baseDeps(),
        dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    // codex iter-9 P2 — only the unknown_rule sentinel matched → sharper
    // 'unknown_rule_default_deny' diagnostic.
    expect(decision.reason).toBe('unknown_rule_default_deny');
    expect(decision.matchedDenyRuleIds).toContain('unknown-rule-id');
  });
});

describe('scope-engine :: decide — additional branch coverage', () => {
  test('normalization_error → allowed:false reason=normalization_error', async () => {
    const scope = basicScope();
    const decision = await decide(
      scope,
      // URL fails normalization (not-a-url)
      { kind: 'http_request', url: 'not-a-url' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('normalization_error');
  });

  test('loopback IP → loopback_blocked unless explicit allow', async () => {
    const scope = basicScope();
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'http://127.0.0.1/' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('loopback_blocked');
  });

  test('loopback IP with explicit cidr allow → bypasses platform guard', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a1', kind: 'cidr', effect: 'allow', cidr: '127.0.0.0/8' },
        { id: 'a2', kind: 'protocol', effect: 'allow', protocol: 'http' },
        {
          id: 'a3',
          kind: 'domain',
          effect: 'allow',
          pattern: '127.0.0.1',
          matchSubdomains: false,
        },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'http://127.0.0.1/' },
      baseDeps(),
    );
    // Bypassed loopback guard but no_matching_allow_rule possible — what
    // matters: NOT loopback_blocked.
    expect(decision.reason).not.toBe('loopback_blocked');
  });

  test('link_local IP → link_local_blocked', async () => {
    // 169.254.10.10 is link_local but NOT metadata IP.
    const scope = basicScope();
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'http://169.254.10.10/' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('link_local_blocked');
  });

  test('metadata IP with allowMetadataIpExplicit + explicit ip allow → bypasses', async () => {
    // Construct scope manually so we can flip the platform flag.
    const scope = basicScope({
      allowRules: [
        { id: 'a-meta', kind: 'ip', effect: 'allow', ip: '169.254.169.254' },
        { id: 'a-proto', kind: 'protocol', effect: 'allow', protocol: 'http' },
        {
          id: 'a-host',
          kind: 'domain',
          effect: 'allow',
          pattern: '169.254.169.254',
          matchSubdomains: false,
        },
      ],
      denyRules: [],
    });
    const overridden = {
      ...scope,
      platformPolicy: { allowMetadataIpExplicit: true, allowPrivateIpExplicit: false },
    };
    const decision = await decide(
      overridden,
      { kind: 'http_request', url: 'http://169.254.169.254/' },
      baseDeps(),
    );
    expect(decision.reason).not.toBe('metadata_ip_blocked');
  });

  test('metadata IP with allowMetadataIpExplicit but no explicit allow rule → still blocked', async () => {
    const scope = basicScope();
    const overridden = {
      ...scope,
      platformPolicy: { allowMetadataIpExplicit: true, allowPrivateIpExplicit: false },
    };
    const decision = await decide(
      overridden,
      { kind: 'http_request', url: 'http://169.254.169.254/' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('metadata_ip_blocked');
  });

  test('time_window deny rule that contains now → denied_by_rule', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a1', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a2', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a3', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [
        {
          id: 'tw-deny',
          kind: 'time_window',
          effect: 'deny',
          start: '2026-04-28T11:00:00.000Z',
          end: '2026-04-28T13:00:00.000Z',
        },
      ],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io/' },
      {
        ...baseDeps(),
        dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_by_rule');
    expect(decision.matchedDenyRuleIds).toContain('tw-deny');
  });

  test('time_window allow rule whose window is closed → time_window_closed', async () => {
    const scope = basicScope({
      allowRules: [
        { id: 'a1', kind: 'domain', effect: 'allow', pattern: 'x.io', matchSubdomains: false },
        { id: 'a2', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a3', kind: 'protocol', effect: 'allow', protocol: 'https' },
        // allow-effect time_window outside the clock — closes the gate.
        {
          id: 'tw-allow',
          kind: 'time_window',
          effect: 'allow',
          start: '2027-01-01T00:00:00.000Z',
          end: '2027-01-02T00:00:00.000Z',
        },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.io/' },
      {
        ...baseDeps(),
        dns: recordingDns({ 'x.io': ['8.8.8.8'] }),
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('time_window_closed');
  });

  test('A-SE-SSRF-4 — out-of-scope redirect target denies via private-IP guard', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a1',
          kind: 'domain',
          effect: 'allow',
          pattern: 'safe.example',
          matchSubdomains: false,
        },
        { id: 'a2', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
        { id: 'a3', kind: 'protocol', effect: 'allow', protocol: 'https' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'http_request',
        url: 'https://safe.example/',
        followRedirectsTo: ['https://192.168.1.10/'],
      },
      {
        ...baseDeps(),
        dns: recordingDns({ 'safe.example': ['8.8.8.8'] }),
      },
    );
    // Redirect IP is private → platform guard fires → private_ip_blocked.
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('private_ip_blocked');
    expect(decision.normalizedTarget?.redirectTargets?.length).toBe(1);
  });

  test('mixed-script host with no allow → mixed_script_host_blocked (verifies escape hatch absence)', async () => {
    const cyrillicO = 'о';
    const scope = basicScope();
    const decision = await decide(
      scope,
      { kind: 'http_request', url: `https://g${cyrillicO}${cyrillicO}gle.com/` },
      { ...baseDeps(), dns: recordingDns({}) },
    );
    // OQ-8 default-deny path verified.
    expect(decision.reason).toBe('mixed_script_host_blocked');
  });

  test('tool_invoke with declared high-impact category — gate OK signal surfaces', async () => {
    const scope = basicScope({
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['target-1']),
      },
      allowRules: [
        { id: 'a-tn', kind: 'tool_name', effect: 'allow', toolName: 'metasploit' },
        { id: 'a-tc', kind: 'tool_category', effect: 'allow', category: 'post_exploit' },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'an opaque target with spaces',
      },
      baseDeps(),
    );
    // Verifies the toolPolicyResult shape (high-impact branch executed).
    expect(decision.toolPolicyResult?.highImpact).toBe(true);
    expect(decision.toolPolicyResult?.highImpactGateOk).toBe(true);
  });

  test('cloud_call action — provider/account match required', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-cloud',
          kind: 'cloud_account',
          effect: 'allow',
          provider: 'aws',
          accountId: '123',
        },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'cloud_call', provider: 'aws', accountId: '123', op: 'list' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
  });

  test('cloud_call without matching account → no_matching_allow_rule', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-cloud',
          kind: 'cloud_account',
          effect: 'allow',
          provider: 'aws',
          accountId: '123',
        },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'cloud_call', provider: 'aws', accountId: '999', op: 'list' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_matching_allow_rule');
  });

  test('k8s_call action — namespace match', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-k8s',
          kind: 'kubernetes_namespace',
          effect: 'allow',
          cluster: 'prod',
          namespace: 'app',
        },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'k8s_call', cluster: 'prod', namespace: 'app', op: 'list' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(true);
  });

  test('repo_op action — repository match', async () => {
    const scope = basicScope({
      allowRules: [
        {
          id: 'a-repo',
          kind: 'repository',
          effect: 'allow',
          vcs: 'github',
          owner: 'acme',
          name: 'svc',
        },
      ],
      denyRules: [],
    });
    const decision = await decide(
      scope,
      { kind: 'repo_op', vcs: 'github', owner: 'acme', name: 'svc', op: 'clone' },
      baseDeps(),
    );
    expect(decision.allowed).toBe(true);
  });
});
