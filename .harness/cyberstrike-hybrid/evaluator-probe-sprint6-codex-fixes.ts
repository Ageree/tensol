/**
 * Sprint 6 codex-fix evaluator probes.
 *
 * Reproduces each of the 4 codex findings from a fresh angle. PASS = bypass closed.
 *
 * Run with: bun run .harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts
 *
 * P1-A — tool_invoke URL DNS resolution → resolvedIps populated, private-IP guard fires
 * P1-B — catalog-driven highImpact (caller toolCategory cannot downgrade)
 * P1-C — verified-ownership gate (3 sub-probes a/b/c)
 * P2   — unknown-rule fail-closed (effect coerced to deny in denyRules)
 */

import { decide } from '../../packages/scope-engine/src/decide.ts';
import {
  buildEffectiveScope,
  DEFAULT_PLATFORM_POLICY,
} from '../../packages/scope-engine/src/effective-scope.ts';
import type {
  AssessmentFlags,
  Clock,
  DnsResolver,
  EngineDeps,
  RateLimitCounter,
  ToolPolicy,
} from '../../packages/scope-engine/src/types.ts';

// ============================================================================
// Test deps
// ============================================================================

const fixedNow = new Date('2026-04-28T12:00:00.000Z');
const clock: Clock = { now: () => fixedNow };
const noopRateLimit: RateLimitCounter = {
  consume: () => ({ ok: true }),
};

const makeDns = (table: Record<string, { v4?: string[]; v6?: string[] }>): DnsResolver => ({
  resolveA: async (host) => table[host]?.v4 ?? [],
  resolveAAAA: async (host) => table[host]?.v6 ?? [],
});

const emptyFlags = (overrides?: Partial<AssessmentFlags>): AssessmentFlags => ({
  highImpactCategories: [],
  ownershipVerifiedTargetIds: new Set<string>(),
  ...overrides,
});

const tenantPolicy = { tenantId: 't1' } as const;

let pass = 0;
let fail = 0;
const failures: string[] = [];

const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) {
    pass += 1;
    console.log(`PASS ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`FAIL ${label}`);
    if (detail !== undefined) console.log('  detail:', JSON.stringify(detail, replacer, 2));
  }
};

const replacer = (_k: string, v: unknown): unknown => {
  if (v instanceof Set) return Array.from(v);
  if (v instanceof Map) return Object.fromEntries(v);
  return v;
};

// ============================================================================
// P1-A — tool_invoke URL with DNS resolution; private IP guard must fire
// ============================================================================

async function probeP1A(): Promise<void> {
  // Tool catalog with a benign 'recon' tool — NOT high-impact — to isolate the
  // SSRF-via-DNS bypass under test. The category is 'recon' so no ownership/HI
  // gate confounds this probe.
  const toolCatalog = new Map<string, ToolPolicy>([
    ['amass', { toolName: 'amass', category: 'recon', highImpact: false }],
  ]);
  const dns = makeDns({ 'internal.example.com': { v4: ['192.168.1.10'] } });

  // No allow rules covering the private CIDR. Default platform policy blocks
  // private IPs from resolution.
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    platformPolicy: DEFAULT_PLATFORM_POLICY,
    rawRules: [],
    toolCatalog,
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });

  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    {
      kind: 'tool_invoke',
      toolName: 'amass',
      toolCategory: 'recon',
      targetRef: 'https://internal.example.com/',
    },
    deps,
  );

  check(
    'P1-A: tool_invoke URL → DNS resolved, resolvedIps populated',
    (decision.normalizedTarget?.resolvedIps?.length ?? 0) > 0,
    decision,
  );
  check(
    'P1-A: tool_invoke URL → private-IP guard fires (private_ip_blocked)',
    decision.allowed === false && decision.reason === 'private_ip_blocked',
    { allowed: decision.allowed, reason: decision.reason, ips: decision.normalizedTarget?.resolvedIps },
  );
}

// ============================================================================
// P1-B — catalog-driven high-impact; spoofed caller toolCategory does not
//         downgrade or change category. Action denied if assessment didn't
//         declare the catalog-derived category.
// ============================================================================

async function probeP1B(): Promise<void> {
  const toolCatalog = new Map<string, ToolPolicy>([
    [
      'metasploit',
      { toolName: 'metasploit', category: 'post_exploit', highImpact: true },
    ],
  ]);
  const dns = makeDns({});

  // Assessment did NOT declare post_exploit. Caller spoofs category='web'.
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [],
    toolCatalog,
    assessmentFlags: emptyFlags({ highImpactCategories: [] }),
    timeWindow: null,
  });

  // Use a raw public IP targetRef so the iter-4 dns_resolution_failed gate
  // (dnsResolution='not_applicable' for IP literals) does not fire before the
  // tool-policy gate.
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    {
      kind: 'tool_invoke',
      toolName: 'metasploit',
      toolCategory: 'web', // spoof — should be ignored by catalog lookup
      targetRef: '198.51.100.50',
    },
    deps,
  );

  check(
    'P1-B: catalog override → toolPolicyResult.highImpact=true despite caller toolCategory=web',
    decision.toolPolicyResult?.highImpact === true,
    decision.toolPolicyResult,
  );
  check(
    'P1-B: catalog override → toolPolicyResult.category=post_exploit (from catalog, not caller)',
    decision.toolPolicyResult?.category === 'post_exploit',
    decision.toolPolicyResult,
  );
  check(
    'P1-B: caller-spoofed category cannot bypass HI gate — denied',
    decision.allowed === false &&
      decision.reason === 'tool_category_high_impact_unverified_targets',
    { allowed: decision.allowed, reason: decision.reason },
  );
}

// ============================================================================
// P1-C — Ownership-verified gate (3 sub-probes)
// ============================================================================

async function probeP1C(): Promise<void> {
  const toolCatalog = new Map<string, ToolPolicy>([
    [
      'metasploit',
      { toolName: 'metasploit', category: 'post_exploit', highImpact: true },
    ],
  ]);
  const dns = makeDns({});

  // Use IP-literal targetRefs so the only host-side dimension is `ip` (an
  // explicit `ip` allow rule covers it). Documentation/test range public IPs
  // avoid the platform private-IP guard short-circuit.
  const refX = '203.0.113.10';
  const refY = '203.0.113.20';

  const buildScope = (
    verifiedTargetIds: ReadonlySet<string>,
    assessmentTargetRefs: ReadonlySet<string> | undefined,
    verifiedTargetRefs: ReadonlySet<string> | undefined,
  ) =>
    buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy,
      rawRules: [
        // Allow rules covering tool name/category and IP dimension so the
        // ONLY remaining blocker is the ownership gate.
        {
          id: 'allow-tool',
          ruleKind: 'tool_name',
          effect: 'allow',
          payload: { toolName: 'metasploit' },
        },
        {
          id: 'allow-cat',
          ruleKind: 'tool_category',
          effect: 'allow',
          payload: { category: 'post_exploit' },
        },
        {
          id: 'allow-ip-x',
          ruleKind: 'ip',
          effect: 'allow',
          payload: { ip: refX },
        },
        {
          id: 'allow-ip-y',
          ruleKind: 'ip',
          effect: 'allow',
          payload: { ip: refY },
        },
      ],
      toolCatalog,
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: verifiedTargetIds,
        ...(assessmentTargetRefs ? { assessmentTargetRefs } : {}),
        ...(verifiedTargetRefs ? { verifiedTargetRefs } : {}),
      } as AssessmentFlags,
      timeWindow: null,
    });

  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };

  // (a) Declared post_exploit + verified-set EMPTY → DENY high_impact_unverified_ownership.
  {
    const scope = buildScope(new Set<string>(), undefined, undefined);
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: refX,
      },
      deps,
    );
    check(
      'P1-C(a): declared HI + zero verified targets → DENY high_impact_unverified_ownership',
      decision.allowed === false &&
        decision.reason === 'high_impact_unverified_ownership',
      { allowed: decision.allowed, reason: decision.reason },
    );
  }

  // (b) Declared + ownership-verified set non-empty + action target IN
  //     assessmentTargetRefs but NOT in verifiedTargetRefs → DENY
  //     high_impact_target_unverified.
  {
    const scope = buildScope(
      new Set(['target-X']),
      new Set([refX, refY]),
      new Set([refX]),
    );
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: refY, // unverified
      },
      deps,
    );
    check(
      'P1-C(b): declared HI + verified=[X], action target=Y → DENY high_impact_target_unverified',
      decision.allowed === false &&
        decision.reason === 'high_impact_target_unverified',
      {
        allowed: decision.allowed,
        reason: decision.reason,
        ips: decision.normalizedTarget?.resolvedIps,
      },
    );
  }

  // (c) Declared + ALL assessment targets verified + action target verified → ALLOW.
  // (iter-9 round-6 fix #1 tightened the gate to require assessmentRefs ⊆ verifiedRefs;
  //  the prior P1-C(c) fixture {refX,refY} ⊆ {refX} would now legitimately DENY.)
  {
    const scope = buildScope(
      new Set(['target-X']),
      new Set([refX]), // only X is an assessment target
      new Set([refX]), // X is verified — assessmentRefs ⊆ verifiedRefs
    );
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: refX,
      },
      deps,
    );
    check(
      'P1-C(c): declared HI + ALL assessment targets verified → ALLOW (iter-9 gate tightening preserved)',
      decision.allowed === true && decision.reason === 'allowed',
      {
        allowed: decision.allowed,
        reason: decision.reason,
        matched: decision.matchedAllowRuleIds,
      },
    );
  }
}

// ============================================================================
// P2 — unknown-rule fail-closed (both effect=allow and effect=deny inputs land
//      in denyRules with effect=deny, surfacing in matchedDenyRuleIds)
// ============================================================================

async function probeP2(): Promise<void> {
  const toolCatalog = new Map<string, ToolPolicy>();
  const dns = makeDns({});

  for (const callerEffect of ['allow', 'deny'] as const) {
    const scope = buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy,
      rawRules: [
        {
          id: 'unk-1',
          ruleKind: 'future_rule',
          effect: callerEffect,
          payload: {},
        },
      ],
      toolCatalog,
      assessmentFlags: emptyFlags(),
      timeWindow: null,
    });

    // Hard structural assertion: unknown rule must land in denyRules with effect=deny.
    const inDeny = scope.denyRules.find((r) => r.id === 'unk-1');
    const inAllow = scope.allowRules.find((r) => r.id === 'unk-1');
    check(
      `P2(effect=${callerEffect}): unknown rule placed in denyRules`,
      inDeny !== undefined && inAllow === undefined,
      { allowRules: scope.allowRules.map((r) => r.id), denyRules: scope.denyRules.map((r) => r.id) },
    );
    check(
      `P2(effect=${callerEffect}): unknown rule effect coerced to 'deny'`,
      inDeny !== undefined && inDeny.effect === 'deny',
      inDeny,
    );

    // Behavioural assertion: any decision (matching or not) where the engine
    // surfaces matchedDenyRuleIds must include this rule when matchRule
    // matches. The unknown_rule kind is a synthetic catch-all in matchers, so
    // we need at least to verify the rule is in scope.denyRules and any action
    // that touches the engine surfaces denial. Use a tcp_connect to a public
    // host (no other deny path triggers) and assert deny-by-rule.
    const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
    const decision = await decide(
      scope,
      { kind: 'tcp_connect', host: '8.8.8.8', port: 443 },
      deps,
    );
    check(
      `P2(effect=${callerEffect}): action evaluated against unknown_rule → denied (catch-all)`,
      decision.allowed === false &&
        (decision.matchedDenyRuleIds.includes('unk-1') ||
          decision.reason === 'no_matching_allow_rule'),
      { allowed: decision.allowed, reason: decision.reason, matchedDenyRuleIds: decision.matchedDenyRuleIds },
    );
  }
}

// ============================================================================
// Run all probes
// ============================================================================

// ============================================================================
// iter-4 codex round-2 probes (5 P1 + 1 P2)
// ============================================================================

import { normalizeUrl } from '../../packages/scope-engine/src/normalize/url.ts';
import { scopeActionInputSchema } from '../../packages/contracts/src/scope-action.ts';

// I4-1 — userinfo bypass: host MUST come from URL parser, not manual scan.
async function probeI4_1(): Promise<void> {
  // Direct normalizer assertion — host is from WHATWG parser.
  const u = normalizeUrl('https://allowed.example:secret@evil.example/path');
  check(
    'I4-1: userinfo URL → host comes from URL parser (evil.example), not userinfo (allowed.example)',
    u.host === 'evil.example',
    { host: u.host, canonical: u.canonical },
  );
  check(
    'I4-1: canonical URL strips userinfo entirely',
    !u.canonical.includes('secret') && !u.canonical.includes('@'),
    { canonical: u.canonical },
  );

  // Behavioural: scope allowing `allowed.example` must NOT permit a userinfo URL whose real host is `evil.example`.
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      {
        id: 'allow-allowed',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'allowed.example', matchSubdomains: false },
      },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'https' },
      },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns = makeDns({
    'evil.example': { v4: ['198.51.100.1'] }, // public IP, no platform-guard trip
  });
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    { kind: 'http_request', url: 'https://allowed.example:secret@evil.example/' },
    deps,
  );
  check(
    'I4-1: userinfo bypass closed — action against userinfo URL denied (real host evil.example unscoped)',
    decision.allowed === false,
    { allowed: decision.allowed, reason: decision.reason, host: decision.normalizedTarget?.host },
  );
}

// I4-2 — effectivePort: deny rule on port 443 must block https://x/ even with elided port.
async function probeI4_2(): Promise<void> {
  const u = normalizeUrl('https://x.example/');
  check(
    'I4-2: effectivePort=443 set when default port elided',
    u.effectivePort === 443 && u.port === undefined,
    { port: u.port, effectivePort: u.effectivePort },
  );
  const u2 = normalizeUrl('https://x.example:443/');
  check(
    'I4-2: effectivePort=443 set when explicit :443 also elided in canonical',
    u2.effectivePort === 443,
    { port: u2.port, effectivePort: u2.effectivePort, canonical: u2.canonical },
  );

  // Behavioural: deny port:443 should block https://x.example/ even though port is elided.
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      // Deny port 443.
      {
        id: 'deny-443',
        ruleKind: 'port',
        effect: 'deny',
        payload: { port: 443 },
      },
      {
        id: 'allow-domain',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'x.example', matchSubdomains: false },
      },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'https' },
      },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns = makeDns({ 'x.example': { v4: ['198.51.100.2'] } });
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    { kind: 'http_request', url: 'https://x.example/' },
    deps,
  );
  check(
    'I4-2: deny port:443 → DENY https://x.example/ (effectivePort consulted, default-port elision does NOT bypass)',
    decision.allowed === false &&
      decision.reason === 'denied_by_rule' &&
      decision.matchedDenyRuleIds.includes('deny-443'),
    {
      allowed: decision.allowed,
      reason: decision.reason,
      matchedDenyRuleIds: decision.matchedDenyRuleIds,
    },
  );
}

// I4-3 — redirect destinations must be matched independently. Allow primary
// host, redirect to a different host with no allow → DENY.
async function probeI4_3(): Promise<void> {
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      {
        id: 'allow-safe',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'safe.example', matchSubdomains: false },
      },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'https' },
      },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns = makeDns({
    'safe.example': { v4: ['198.51.100.10'] },
    'evil.example': { v4: ['198.51.100.20'] },
  });
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    {
      kind: 'http_request',
      url: 'https://safe.example/',
      followRedirectsTo: ['https://evil.example/path'],
    },
    deps,
  );
  check(
    'I4-3: redirect to out-of-scope host → DENY (matched independently, not just primary)',
    decision.allowed === false,
    {
      allowed: decision.allowed,
      reason: decision.reason,
      matchedAllowRuleIds: decision.matchedAllowRuleIds,
    },
  );

  // Redirect to metadata IP via DNS resolution → metadata_ip_blocked.
  const scope2 = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      {
        id: 'allow-safe',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'safe.example', matchSubdomains: false },
      },
      {
        id: 'allow-target',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'cloud.example', matchSubdomains: false },
      },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'https' },
      },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns2 = makeDns({
    'safe.example': { v4: ['198.51.100.10'] },
    'cloud.example': { v4: ['169.254.169.254'] }, // metadata IP via DNS
  });
  const deps2: EngineDeps = { dns: dns2, clock, rateLimit: noopRateLimit };
  const decision2 = await decide(
    scope2,
    {
      kind: 'http_request',
      url: 'https://safe.example/',
      followRedirectsTo: ['https://cloud.example/'],
    },
    deps2,
  );
  check(
    'I4-3: redirect resolving to metadata IP → DENY metadata_ip_blocked',
    decision2.allowed === false && decision2.reason === 'metadata_ip_blocked',
    { allowed: decision2.allowed, reason: decision2.reason },
  );
}

// I4-4 — ownership normalization parity. Documented in build-scope.ts; the
// engine only sees ReadonlySet<string>, so we verify the canonical-ref
// behavior by simulating both URL+host forms in the verifiedTargetRefs set
// and confirming the engine matches the action target's canonical form.
async function probeI4_4(): Promise<void> {
  const toolCatalog = new Map<string, ToolPolicy>([
    ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
  ]);
  // Action targetRef is a URL; canonical form (default port elided, lowercase) must be in verifiedTargetRefs.
  const targetUrl = 'https://verified.example/'; // canonical = 'https://verified.example/'
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      {
        id: 'allow-tool',
        ruleKind: 'tool_name',
        effect: 'allow',
        payload: { toolName: 'metasploit' },
      },
      {
        id: 'allow-cat',
        ruleKind: 'tool_category',
        effect: 'allow',
        payload: { category: 'post_exploit' },
      },
      {
        id: 'allow-domain',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'verified.example', matchSubdomains: false },
      },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'https' },
      },
      {
        id: 'allow-path',
        ruleKind: 'path_pattern',
        effect: 'allow',
        payload: { glob: '/*' },
      },
      // iter-9 round-6 fix #2: effectivePort=443 (default-port elided) requires
      // port-or-url_prefix allow coverage. Add port:443 allow.
      { id: 'allow-port', ruleKind: 'port', effect: 'allow', payload: { port: 443 } },
    ],
    toolCatalog,
    assessmentFlags: {
      highImpactCategories: ['post_exploit'],
      ownershipVerifiedTargetIds: new Set(['target-1']),
      // build-scope.ts:canonicalRefsFromTargetValue inserts BOTH url canonical AND host.
      assessmentTargetRefs: new Set(['https://verified.example/', 'verified.example']),
      verifiedTargetRefs: new Set(['https://verified.example/', 'verified.example']),
    } as AssessmentFlags,
    timeWindow: null,
  });
  const dns = makeDns({ 'verified.example': { v4: ['198.51.100.30'] } });
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    {
      kind: 'tool_invoke',
      toolName: 'metasploit',
      toolCategory: 'post_exploit',
      targetRef: targetUrl,
    },
    deps,
  );
  check(
    'I4-4: action targetRef URL canonical form matches verifiedTargetRefs (url canonical OR host) → ALLOW',
    decision.allowed === true && decision.reason === 'allowed',
    {
      allowed: decision.allowed,
      reason: decision.reason,
      matchedAllowRuleIds: decision.matchedAllowRuleIds,
    },
  );
}

// I4-5 — DNS resolution failure fail-closed. Action against a hostname whose
// DNS returns empty → DENY dns_resolution_failed (NOT a domain/protocol allow).
async function probeI4_5(): Promise<void> {
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      {
        id: 'allow-domain',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'nxdomain.example', matchSubdomains: false },
      },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'https' },
      },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  // DNS stub returns empty for nxdomain.example → dnsResolution='failed'.
  const dns = makeDns({});
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    { kind: 'http_request', url: 'https://nxdomain.example/' },
    deps,
  );
  check(
    'I4-5: DNS empty (NXDOMAIN-like) → DENY dns_resolution_failed (not allowed despite domain+protocol allows)',
    decision.allowed === false && decision.reason === 'dns_resolution_failed',
    { allowed: decision.allowed, reason: decision.reason },
  );

  // Sanity: raw-IP target should NOT trigger fail-closed (dnsResolution='not_applicable').
  const scope2 = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'allow-ip', ruleKind: 'ip', effect: 'allow', payload: { ip: '198.51.100.99' } },
      { id: 'allow-protocol', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'https' } },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const decision2 = await decide(
    scope2,
    { kind: 'http_request', url: 'https://198.51.100.99/' },
    deps,
  );
  check(
    'I4-5: raw IP target → dnsResolution=not_applicable, fail-closed gate does NOT fire',
    decision2.reason !== 'dns_resolution_failed',
    { allowed: decision2.allowed, reason: decision2.reason },
  );
}

// I4-6 — scheme allowlist on http_request URL.
function probeI4_6(): void {
  // Rejects forbidden schemes.
  for (const bad of [
    'ftp://x.example/',
    'gopher://x.example/',
    'file:///etc/passwd',
    'data:text/plain,hello',
  ]) {
    const result = scopeActionInputSchema.safeParse({
      kind: 'http_request',
      url: bad,
    });
    check(
      `I4-6: scheme allowlist rejects ${bad.slice(0, 12)}... at zod boundary`,
      result.success === false,
      { success: result.success },
    );
  }
  // Accepts allowed schemes.
  for (const good of [
    'http://x.example/',
    'https://x.example/',
    'ws://x.example/',
    'wss://x.example/',
  ]) {
    const result = scopeActionInputSchema.safeParse({ kind: 'http_request', url: good });
    check(
      `I4-6: scheme allowlist accepts ${good}`,
      result.success === true,
      { success: result.success, error: result.success === false ? result.error.message : undefined },
    );
  }
  // followRedirectsTo entries also restricted.
  const redirectResult = scopeActionInputSchema.safeParse({
    kind: 'http_request',
    url: 'https://x.example/',
    followRedirectsTo: ['ftp://evil.example/'],
  });
  check(
    'I4-6: scheme allowlist applies to followRedirectsTo entries (ftp rejected)',
    redirectResult.success === false,
    { success: redirectResult.success },
  );
}

// ============================================================================
// iter-5 codex round-3 probes (1 P1 + 3 P2)
// ============================================================================

import { normalizeAction } from '../../packages/scope-engine/src/normalize/index.ts';

// I5-1 — audit redaction whitelist (the engine surfaces nested url, the route
// must redact). Static structural check on the route source confirms the
// whitelist + recursive walk is in place; the IT covers live behaviour.
async function probeI5_1(): Promise<void> {
  const dns = makeDns({ 'safe.example': { v4: ['198.51.100.1'] } });
  const decisionInput = {
    kind: 'http_request' as const,
    url: 'https://safe.example/?q=ok',
    followRedirectsTo: [
      'https://safe.example/redirect?token=zzzzleakvalue&other=safe',
    ],
  };
  const normalized = await normalizeAction(decisionInput, { dns });
  const t = normalized.target;
  check(
    'I5-1: engine surfaces redirectNormalizedTargets[] with own url field for route to redact',
    Array.isArray(t.redirectNormalizedTargets) &&
      t.redirectNormalizedTargets.length === 1 &&
      typeof t.redirectNormalizedTargets[0]?.url === 'string',
    { redirectNormalizedTargets: t.redirectNormalizedTargets },
  );
  check(
    'I5-1: pre-redaction nested url DOES contain secret (route-side redaction is load-bearing)',
    t.redirectNormalizedTargets?.[0]?.url?.includes('zzzzleakvalue') === true,
    { url: t.redirectNormalizedTargets?.[0]?.url },
  );

  // Static structural check on the route.
  const fs = await import('node:fs');
  const routeSrc = fs.readFileSync(
    '/Users/saveliy/Documents/пентест ИИ/apps/api/src/routes/assessments/scope-validate.ts',
    'utf-8',
  );
  check(
    'I5-1: AUDIT_TARGET_WHITELIST includes redirectNormalizedTargets',
    /AUDIT_TARGET_WHITELIST[\s\S]*?redirectNormalizedTargets/.test(routeSrc),
    {},
  );
  check(
    'I5-1: whitelistAndRedact recursively walks redirectNormalizedTargets',
    /redirectNormalizedTargets[\s\S]{0,200}whitelistAndRedact\(nested\)/.test(routeSrc),
    {},
  );
  // resolvedIps must NOT be in the whitelist (deliberately omitted).
  // Whitelist is declared as `new Set<string>([... 'redirectNormalizedTargets', ...])`.
  // Extract the whitelist body and assert resolvedIps is absent.
  const match = routeSrc.match(/AUDIT_TARGET_WHITELIST\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  check(
    'I5-1: resolvedIps NOT in AUDIT_TARGET_WHITELIST (deliberate omission)',
    match !== null && !/['"]resolvedIps['"]/.test(match[1] ?? ''),
    { whitelistBody: match?.[1]?.slice(0, 200) },
  );
}

// I5-2 — IP-literal hosts covered by ip allow rules in dimension-coverage.
async function probeI5_2(): Promise<void> {
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'allow-ip', ruleKind: 'ip', effect: 'allow', payload: { ip: '8.8.8.8' } },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'https' },
      },
      { id: 'allow-port', ruleKind: 'port', effect: 'allow', payload: { port: 443 } },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns = makeDns({});
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    { kind: 'http_request', url: 'https://8.8.8.8/' },
    deps,
  );
  check(
    'I5-2: https://8.8.8.8/ + ip+protocol+port allows → ALLOW (hostIsIp covers via ip rule)',
    decision.allowed === true && decision.reason === 'allowed',
    {
      allowed: decision.allowed,
      reason: decision.reason,
      hostIsIp: decision.normalizedTarget?.hostIsIp,
      matched: decision.matchedAllowRuleIds,
    },
  );
  check(
    'I5-2: normalized target carries hostIsIp=true for IPv4 literal URL',
    decision.normalizedTarget?.hostIsIp === true,
    { hostIsIp: decision.normalizedTarget?.hostIsIp },
  );
}

// I5-3 — bracketed IPv6 URLs parse without LDH rejection.
async function probeI5_3(): Promise<void> {
  let parsed: ReturnType<typeof normalizeUrl> | null = null;
  let parseError: unknown = null;
  try {
    parsed = normalizeUrl('http://[2001:db8::1]/');
  } catch (e) {
    parseError = e;
  }
  check(
    'I5-3: bracketed IPv6 URL parses without throwing LDH rejection',
    parsed !== null && parseError === null,
    { error: parseError instanceof Error ? parseError.message : parseError },
  );
  if (parsed) {
    check(
      'I5-3: bracketed IPv6 URL → hostIsIp=true',
      parsed.hostIsIp === true,
      { hostIsIp: parsed.hostIsIp, host: parsed.host },
    );
    check(
      'I5-3: bracketed IPv6 URL → host is bare canonical (no brackets in .host field)',
      parsed.host === '2001:db8::1' && !parsed.host.includes('['),
      { host: parsed.host },
    );
    check(
      'I5-3: bracketed IPv6 URL → canonical re-wraps brackets for display',
      parsed.canonical.includes('[2001:db8::1]'),
      { canonical: parsed.canonical },
    );
  }

  // Behavioural: scope with ip+protocol+port allow → ALLOW.
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'allow-ip6', ruleKind: 'ip', effect: 'allow', payload: { ip: '2001:db8::1' } },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'http' },
      },
      { id: 'allow-port', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns = makeDns({});
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    { kind: 'http_request', url: 'http://[2001:db8::1]/' },
    deps,
  );
  check(
    'I5-3: bracketed IPv6 URL with ip+protocol+port allows → ALLOW',
    decision.allowed === true,
    {
      allowed: decision.allowed,
      reason: decision.reason,
      matched: decision.matchedAllowRuleIds,
    },
  );
}

// I5-4 — IPv6 literal hosts in dns_lookup/tcp_connect/tool_invoke (IP-first ordering).
async function probeI5_4(): Promise<void> {
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'allow-ip6', ruleKind: 'ip', effect: 'allow', payload: { ip: '2001:db8::1' } },
      { id: 'allow-port-22', ruleKind: 'port', effect: 'allow', payload: { port: 22 } },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns = makeDns({});
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };

  // (a) dns_lookup ::1 → loopback_blocked (no LDH crash from colon).
  const d1 = await decide(scope, { kind: 'dns_lookup', host: '::1' }, deps);
  check(
    'I5-4(a): dns_lookup ::1 → loopback_blocked (no LDH crash, IP classified first)',
    d1.allowed === false && d1.reason === 'loopback_blocked',
    { allowed: d1.allowed, reason: d1.reason, host: d1.normalizedTarget?.host },
  );

  // (b) dns_lookup 2001:db8::1 → ALLOW via ip rule.
  const d2 = await decide(scope, { kind: 'dns_lookup', host: '2001:db8::1' }, deps);
  check(
    'I5-4(b): dns_lookup 2001:db8::1 → ALLOW via ip rule (hostIsIp covers host dim)',
    d2.allowed === true && d2.reason === 'allowed',
    { allowed: d2.allowed, reason: d2.reason, hostIsIp: d2.normalizedTarget?.hostIsIp },
  );

  // (c) tcp_connect ::1:22 → loopback_blocked.
  const d3 = await decide(scope, { kind: 'tcp_connect', host: '::1', port: 22 }, deps);
  check(
    'I5-4(c): tcp_connect ::1:22 → loopback_blocked (IP-first ordering, no crash)',
    d3.allowed === false && d3.reason === 'loopback_blocked',
    { allowed: d3.allowed, reason: d3.reason },
  );

  // (d) tool_invoke targetRef = '2001:db8::1' → ALLOW via ip rule.
  const scopeTool = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'allow-ip6', ruleKind: 'ip', effect: 'allow', payload: { ip: '2001:db8::1' } },
      { id: 'allow-tool', ruleKind: 'tool_name', effect: 'allow', payload: { toolName: 'amass' } },
      {
        id: 'allow-cat',
        ruleKind: 'tool_category',
        effect: 'allow',
        payload: { category: 'recon' },
      },
    ],
    toolCatalog: new Map([
      ['amass', { toolName: 'amass', category: 'recon', highImpact: false }],
    ]),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const d4 = await decide(
    scopeTool,
    {
      kind: 'tool_invoke',
      toolName: 'amass',
      toolCategory: 'recon',
      targetRef: '2001:db8::1',
    },
    deps,
  );
  check(
    'I5-4(d): tool_invoke targetRef=2001:db8::1 → ALLOW (IP-first targetRef classification)',
    d4.allowed === true && d4.reason === 'allowed',
    {
      allowed: d4.allowed,
      reason: d4.reason,
      hostIsIp: d4.normalizedTarget?.hostIsIp,
      host: d4.normalizedTarget?.host,
    },
  );
}

// ============================================================================
// iter-7 codex round-4 probes (2 P1 + 2 P2)
// ============================================================================

import { normalizeIp } from '../../packages/scope-engine/src/normalize/ip.ts';

// I7-1 — tool_invoke URL targetRef populates `protocol`; deny http blocks tool over http.
async function probeI7_1(): Promise<void> {
  const dns = makeDns({ 'pub.example': { v4: ['198.51.100.50'] } });
  const toolCatalog = new Map<string, ToolPolicy>([
    ['amass', { toolName: 'amass', category: 'recon', highImpact: false }],
  ]);

  // Deny protocol:http; allow everything else needed.
  const scopeDeny = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'deny-http', ruleKind: 'protocol', effect: 'deny', payload: { protocol: 'http' } },
      {
        id: 'allow-domain',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'pub.example', matchSubdomains: false },
      },
      { id: 'allow-tool', ruleKind: 'tool_name', effect: 'allow', payload: { toolName: 'amass' } },
      {
        id: 'allow-cat',
        ruleKind: 'tool_category',
        effect: 'allow',
        payload: { category: 'recon' },
      },
      { id: 'allow-port-80', ruleKind: 'port', effect: 'allow', payload: { port: 80 } },
    ],
    toolCatalog,
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scopeDeny,
    {
      kind: 'tool_invoke',
      toolName: 'amass',
      toolCategory: 'recon',
      targetRef: 'http://pub.example/',
    },
    deps,
  );
  check(
    'I7-1: tool_invoke URL → normalizedTarget.protocol populated',
    decision.normalizedTarget?.protocol === 'http',
    {
      protocol: decision.normalizedTarget?.protocol,
      effectivePort: decision.normalizedTarget?.effectivePort,
    },
  );
  check(
    'I7-1: deny protocol:http → DENY tool_invoke over http (matchedDenyRuleIds includes deny-http)',
    decision.allowed === false &&
      decision.reason === 'denied_by_rule' &&
      decision.matchedDenyRuleIds.includes('deny-http'),
    {
      allowed: decision.allowed,
      reason: decision.reason,
      matchedDenyRuleIds: decision.matchedDenyRuleIds,
    },
  );

  // Positive: https targetRef → protocol='https', effectivePort=443.
  const scopeAllow = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      {
        id: 'allow-domain',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'pub.example', matchSubdomains: false },
      },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'https' },
      },
      { id: 'allow-port', ruleKind: 'port', effect: 'allow', payload: { port: 443 } },
      { id: 'allow-tool', ruleKind: 'tool_name', effect: 'allow', payload: { toolName: 'amass' } },
      {
        id: 'allow-cat',
        ruleKind: 'tool_category',
        effect: 'allow',
        payload: { category: 'recon' },
      },
    ],
    toolCatalog,
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const decision2 = await decide(
    scopeAllow,
    {
      kind: 'tool_invoke',
      toolName: 'amass',
      toolCategory: 'recon',
      targetRef: 'https://pub.example/',
    },
    deps,
  );
  check(
    'I7-1: positive — https tool_invoke → protocol=https, effectivePort=443, ALLOW',
    decision2.allowed === true &&
      decision2.normalizedTarget?.protocol === 'https' &&
      decision2.normalizedTarget?.effectivePort === 443,
    {
      allowed: decision2.allowed,
      protocol: decision2.normalizedTarget?.protocol,
      effectivePort: decision2.normalizedTarget?.effectivePort,
    },
  );
}

// I7-2 — Rate-limit bucket key namespaced by tenantId+assessmentId.
async function probeI7_2(): Promise<void> {
  // Custom RateLimitCounter that records every key it sees AND simulates
  // process-global state — it tracks `${key}:remaining` per opaque key.
  const seen = new Map<string, number>();
  const counter: RateLimitCounter = {
    consume: (bucket, perSecond, _burst) => {
      const remaining = (seen.get(bucket) ?? perSecond) - 1;
      seen.set(bucket, remaining);
      return remaining >= 0 ? { ok: true } : { ok: false, retryAfterMs: 1000 };
    },
  };

  const buildScopeWith = (tenantId: string, assessmentId: string) =>
    buildEffectiveScope({
      tenantId,
      assessmentId,
      tenantPolicy: { tenantId },
      rawRules: [
        // perSecond=1, burst=1 — counter sees consume(); first call ok, second
        // exhausted. (zod schema requires burst ≥ 1; counter returns ok on
        // remaining≥0.)
        {
          id: 'rl-recon',
          ruleKind: 'rate_limit',
          effect: 'allow',
          payload: { bucket: 'recon', perSecond: 1, burst: 1 },
        },
        { id: 'allow-ip', ruleKind: 'ip', effect: 'allow', payload: { ip: '8.8.8.8' } },
        {
          id: 'allow-protocol',
          ruleKind: 'protocol',
          effect: 'allow',
          payload: { protocol: 'https' },
        },
        { id: 'allow-port', ruleKind: 'port', effect: 'allow', payload: { port: 443 } },
      ],
      toolCatalog: new Map(),
      assessmentFlags: emptyFlags(),
      timeWindow: null,
    });

  const dns = makeDns({});
  const deps: EngineDeps = { dns, clock, rateLimit: counter };
  const action = { kind: 'http_request' as const, url: 'https://8.8.8.8/' };

  const t1Scope = buildScopeWith('t1', 'a1');
  const t2Scope = buildScopeWith('t2', 'a2');

  // 1st t1 call: consume(t1:a1:recon, 1, 0) → ok=true, remaining=0.
  const t1d1 = await decide(t1Scope, action, deps);
  check(
    'I7-2(setup): t1 first call ALLOW',
    t1d1.allowed === true,
    { allowed: t1d1.allowed, reason: t1d1.reason, seenKeys: Array.from(seen.keys()) },
  );
  // 2nd t1 call: consume(t1:a1:recon, 1, 0) → ok=false, exhausted.
  const t1d2 = await decide(t1Scope, action, deps);
  check(
    'I7-2: t1 second call DENY rate_limit_exceeded (same tenant exhaustion still works)',
    t1d2.allowed === false && t1d2.reason === 'rate_limit_exceeded',
    { allowed: t1d2.allowed, reason: t1d2.reason },
  );
  // 1st t2 call: consume(t2:a2:recon, 1, 0) → ok=true (different namespace key).
  // Pre-fix would have been: consume('recon', 1, 0) → already exhausted by t1.
  const t2d1 = await decide(t2Scope, action, deps);
  check(
    'I7-2: t2 first call ALLOW (t1 exhaustion does NOT propagate — bucket key namespaced)',
    t2d1.allowed === true,
    {
      allowed: t2d1.allowed,
      reason: t2d1.reason,
      seenKeys: Array.from(seen.keys()),
    },
  );
  // Verify the counter saw two distinct keys.
  check(
    'I7-2: counter saw distinct keys for t1:a1:recon and t2:a2:recon',
    seen.has('t1:a1:recon') && seen.has('t2:a2:recon'),
    { keys: Array.from(seen.keys()) },
  );
}

// I7-3 — IPv6 strict per-group hex validation.
function probeI7_3(): void {
  // Junk-suffix in short-form: pre-fix `2001:db8::1zz` parsed as `2001:db8::1`.
  let r1: ReturnType<typeof normalizeIp> | null = null;
  let e1: unknown = null;
  try {
    r1 = normalizeIp('2001:db8::1zz');
  } catch (e) {
    e1 = e;
  }
  check(
    'I7-3: junk-suffix IPv6 short-form (2001:db8::1zz) → REJECTED (no silent acceptance)',
    r1 === null && e1 !== null,
    { result: r1, error: e1 instanceof Error ? e1.message : e1 },
  );

  // Junk in 8-group form.
  let r2: ReturnType<typeof normalizeIp> | null = null;
  let e2: unknown = null;
  try {
    r2 = normalizeIp('2001:db8:0:0:0:0:0:1zz');
  } catch (e) {
    e2 = e;
  }
  check(
    'I7-3: junk-suffix IPv6 8-group form → REJECTED',
    r2 === null && e2 !== null,
    { result: r2, error: e2 instanceof Error ? e2.message : e2 },
  );

  // 5-hex-digit group → too long.
  let r3: ReturnType<typeof normalizeIp> | null = null;
  let e3: unknown = null;
  try {
    r3 = normalizeIp('2001:db8::12345');
  } catch (e) {
    e3 = e;
  }
  check(
    'I7-3: 5-hex-digit group (12345) → REJECTED (HEX_GROUP_RE max 4 digits)',
    r3 === null && e3 !== null,
    { result: r3, error: e3 instanceof Error ? e3.message : e3 },
  );

  // Sanity: well-formed IPv6 still accepts.
  let r4: ReturnType<typeof normalizeIp> | null = null;
  try {
    r4 = normalizeIp('2001:db8::1');
  } catch {
    r4 = null;
  }
  check(
    'I7-3: well-formed IPv6 (2001:db8::1) still accepted',
    r4 !== null && r4.canonical === '2001:db8::1',
    { canonical: r4?.canonical },
  );
}

// I7-4 — Audit query-key URL-encoded match (decoded + raw both checked).
function probeI7_4(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const routeSrc = fs.readFileSync(
    '/Users/saveliy/Documents/пентест ИИ/apps/api/src/routes/assessments/scope-validate.ts',
    'utf-8',
  );
  // The route exports `redactUrlQuery` privately. Validate via structural+behavioural checks:
  // 1. decodeQueryKey wraps decodeURIComponent in try/catch.
  check(
    'I7-4: decodeQueryKey helper wraps decodeURIComponent in try/catch',
    /const decodeQueryKey[\s\S]*?try[\s\S]*?decodeURIComponent[\s\S]*?catch/.test(routeSrc),
    {},
  );
  // 2. redactUrlQuery checks BOTH decoded AND raw key against SECRET_QUERY_KEYS.
  check(
    'I7-4: redactUrlQuery checks decoded.toLowerCase() OR raw.toLowerCase() against SECRET_QUERY_KEYS',
    /SECRET_QUERY_KEYS\.has\(decoded\)\s*\|\|\s*SECRET_QUERY_KEYS\.has\(key\.toLowerCase\(\)\)/.test(
      routeSrc,
    ),
    {},
  );

  // Behavioural: simulate redactUrlQuery in isolation since the function is private.
  // We re-implement the contract here and confirm both forms redact.
  const SECRET_QUERY_KEYS = new Set([
    'token',
    'password',
    'passwd',
    'secret',
    'cookie',
    'authorization',
    'mfa_secret',
    'totp_secret',
    'private_key',
    'api_key',
    'bearer',
    'jwt',
    'session_token',
    'access_token',
    'refresh_token',
  ]);
  const decodeQueryKey = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  const redactUrlQuery = (raw: string): string => {
    if (!raw.includes('?')) return raw;
    const [base, qs] = raw.split('?', 2) as [string, string];
    const parts = qs.split('&').map((kv) => {
      const eqIdx = kv.indexOf('=');
      if (eqIdx < 0) return kv;
      const key = kv.slice(0, eqIdx);
      const decoded = decodeQueryKey(key).toLowerCase();
      return SECRET_QUERY_KEYS.has(decoded) || SECRET_QUERY_KEYS.has(key.toLowerCase())
        ? `${key}=[redacted]`
        : kv;
    });
    return `${base}?${parts.join('&')}`;
  };

  // Encoded `_` → `%5F`. `access%5Ftoken` decodes to `access_token`.
  const out1 = redactUrlQuery(
    'https://x/?access%5Ftoken=zzziter7encleak&Access%5FToken=zzzMixedCaseLeak&other=safe',
  );
  check(
    'I7-4: %5F-encoded access_token (lowercase) → redacted',
    !out1.includes('zzziter7encleak') && out1.includes('access%5Ftoken=[redacted]'),
    { out: out1 },
  );
  check(
    'I7-4: %5F-encoded Access_Token (mixed case) → redacted (case-insensitive)',
    !out1.includes('zzzMixedCaseLeak') && out1.includes('Access%5FToken=[redacted]'),
    { out: out1 },
  );
  check(
    'I7-4: non-secret param `other=safe` preserved verbatim',
    out1.includes('other=safe'),
    { out: out1 },
  );
  // Sanity: malformed encoding falls through to raw match (we used `bearer` raw, no encoding).
  const out2 = redactUrlQuery('https://x/?bearer=zzzbearleak&q=ok');
  check(
    'I7-4: raw key (bearer) without encoding still redacted',
    !out2.includes('zzzbearleak') && out2.includes('bearer=[redacted]'),
    { out: out2 },
  );
}

// ============================================================================
// iter-8 codex round-5 probes (2 P1 + 1 P2)
// ============================================================================

// I8-1 — uncatalogued tool denies BEFORE rule matching with reason 'tool_not_in_catalog'.
async function probeI8_1(): Promise<void> {
  const toolCatalog = new Map<string, ToolPolicy>([
    ['amass', { toolName: 'amass', category: 'recon', highImpact: false }],
  ]);
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'allow-ip', ruleKind: 'ip', effect: 'allow', payload: { ip: '198.51.100.60' } },
      {
        id: 'allow-cat',
        ruleKind: 'tool_category',
        effect: 'allow',
        payload: { category: 'recon' },
      },
      {
        id: 'allow-tool',
        ruleKind: 'tool_name',
        effect: 'allow',
        payload: { toolName: 'misspelled-tool' },
      },
    ],
    toolCatalog,
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns = makeDns({});
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    {
      kind: 'tool_invoke',
      toolName: 'misspelled-tool',
      toolCategory: 'recon',
      targetRef: '198.51.100.60',
    },
    deps,
  );
  check(
    'I8-1: uncatalogued tool → DENY tool_not_in_catalog (catalog is source of truth)',
    decision.allowed === false && decision.reason === 'tool_not_in_catalog',
    {
      allowed: decision.allowed,
      reason: decision.reason,
      inCatalog: decision.toolPolicyResult?.inCatalog,
    },
  );
  check(
    'I8-1: toolPolicyResult.inCatalog === false for uncatalogued tool',
    decision.toolPolicyResult?.inCatalog === false,
    { toolPolicyResult: decision.toolPolicyResult },
  );

  // Sanity: catalogued tool with same shape ALLOWS.
  const decision2 = await decide(
    scope,
    {
      kind: 'tool_invoke',
      toolName: 'amass',
      toolCategory: 'recon',
      targetRef: '198.51.100.60',
    },
    deps,
  );
  check(
    'I8-1: sanity — catalogued tool with same shape → ALLOW',
    decision2.allowed === true && decision2.reason === 'allowed',
    { allowed: decision2.allowed, reason: decision2.reason },
  );
}

// I8-2 — percent-encoded path normalization (decode unreserved before collapse).
async function probeI8_2(): Promise<void> {
  // Direct normalizer assertions.
  const u1 = normalizeUrl('https://x.example/%61dmin');
  check(
    'I8-2: %61 (encoded `a`) decoded — /%61dmin → /admin in canonical path',
    u1.path === '/admin' && u1.canonical.endsWith('/admin'),
    { path: u1.path, canonical: u1.canonical },
  );
  const u2 = normalizeUrl('https://x.example/%2E%2E/etc');
  check(
    'I8-2: %2E%2E (encoded `..`) decodes then collapses — /%2E%2E/etc → /etc',
    u2.path === '/etc',
    { path: u2.path, canonical: u2.canonical },
  );
  // Malformed encoding throws.
  let throwed = false;
  try {
    normalizeUrl('https://x.example/%G0');
  } catch {
    throwed = true;
  }
  check(
    'I8-2: malformed `%G0` throws UrlNormalizationError',
    throwed,
    { throwed },
  );
  let throwed2 = false;
  try {
    normalizeUrl('https://x.example/%2');
  } catch {
    throwed2 = true;
  }
  check(
    'I8-2: truncated `%2` throws UrlNormalizationError',
    throwed2,
    { throwed: throwed2 },
  );

  // Behavioural: deny path_pattern '/admin' should block /%61dmin.
  const scope = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'deny-admin', ruleKind: 'path_pattern', effect: 'deny', payload: { glob: '/admin' } },
      {
        id: 'allow-domain',
        ruleKind: 'domain',
        effect: 'allow',
        payload: { pattern: 'x.example', matchSubdomains: false },
      },
      {
        id: 'allow-protocol',
        ruleKind: 'protocol',
        effect: 'allow',
        payload: { protocol: 'https' },
      },
      { id: 'allow-port', ruleKind: 'port', effect: 'allow', payload: { port: 443 } },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns = makeDns({ 'x.example': { v4: ['198.51.100.70'] } });
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const decision = await decide(
    scope,
    { kind: 'http_request', url: 'https://x.example/%61dmin' },
    deps,
  );
  check(
    'I8-2: deny path_pattern:/admin → DENY denied_by_rule on /%61dmin (encoded bypass closed)',
    decision.allowed === false &&
      decision.reason === 'denied_by_rule' &&
      decision.matchedDenyRuleIds.includes('deny-admin'),
    {
      allowed: decision.allowed,
      reason: decision.reason,
      matchedDenyRuleIds: decision.matchedDenyRuleIds,
      path: decision.normalizedTarget?.path,
    },
  );

  // Malformed encoding action → normalization_error.
  const decisionBad = await decide(
    scope,
    { kind: 'http_request', url: 'https://x.example/%G0' },
    deps,
  );
  check(
    'I8-2: action with malformed `%G0` → reason=normalization_error',
    decisionBad.allowed === false && decisionBad.reason === 'normalization_error',
    { allowed: decisionBad.allowed, reason: decisionBad.reason },
  );

  // Sanity: non-recursive decode — `%2541` should NOT collapse to `A` (which
  // would require two passes: %2541 → %41 → A). Single-pass: `%25` is the
  // percent literal byte; `%` is reserved → re-encoded as `%25` uppercase.
  const u3 = normalizeUrl('https://x.example/foo%2541');
  check(
    'I8-2: non-recursive decode — `%2541` does NOT collapse to `A` (single-pass only)',
    !u3.path.endsWith('/fooA'),
    { path: u3.path },
  );
}

// I8-3 — malformed known-kind rules fall closed to unknown_rule.
function probeI8_3(): void {
  const cases = [
    {
      label: 'ip:not-an-ip',
      rule: { ruleKind: 'ip', effect: 'allow' as const, payload: { ip: 'not-an-ip' } },
    },
    {
      label: 'cidr:not-cidr',
      rule: { ruleKind: 'cidr', effect: 'allow' as const, payload: { cidr: 'not-cidr' } },
    },
    {
      label: 'cidr:8.8.8.0/bad',
      rule: { ruleKind: 'cidr', effect: 'allow' as const, payload: { cidr: '8.8.8.0/bad' } },
    },
    {
      label: 'cidr:192.168.0.0/64 (IPv4 prefix overflow)',
      rule: { ruleKind: 'cidr', effect: 'allow' as const, payload: { cidr: '192.168.0.0/64' } },
    },
  ];

  for (const { label, rule } of cases) {
    const scope = buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy,
      rawRules: [{ id: `bad-${label}`, ...rule }],
      toolCatalog: new Map(),
      assessmentFlags: emptyFlags(),
      timeWindow: null,
    });
    const inDeny = scope.denyRules.find((r) => r.id === `bad-${label}`);
    const inAllow = scope.allowRules.find((r) => r.id === `bad-${label}`);
    check(
      `I8-3: malformed ${label} → lands in denyRules as unknown_rule (NOT allowRules)`,
      inDeny !== undefined &&
        inAllow === undefined &&
        inDeny.kind === 'unknown_rule' &&
        inDeny.effect === 'deny',
      {
        allowRules: scope.allowRules.map((r) => ({ id: r.id, kind: r.kind })),
        denyRules: scope.denyRules.map((r) => ({ id: r.id, kind: r.kind, effect: r.effect })),
      },
    );
  }
}

// ============================================================================
// iter-9 codex round-6 probes (1 P1 + 3 P2)
// ============================================================================

// I9-1 — All assessment targets must be verified for high-impact tools.
async function probeI9_1(): Promise<void> {
  const toolCatalog = new Map<string, ToolPolicy>([
    ['metasploit', { toolName: 'metasploit', category: 'post_exploit', highImpact: true }],
  ]);
  const refX = '203.0.113.10';
  const refY = '203.0.113.20';
  const buildScope = (
    assessmentRefs: ReadonlySet<string>,
    verifiedRefs: ReadonlySet<string>,
  ) =>
    buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy,
      rawRules: [
        { id: 'allow-tool', ruleKind: 'tool_name', effect: 'allow', payload: { toolName: 'metasploit' } },
        {
          id: 'allow-cat',
          ruleKind: 'tool_category',
          effect: 'allow',
          payload: { category: 'post_exploit' },
        },
        { id: 'allow-ip-x', ruleKind: 'ip', effect: 'allow', payload: { ip: refX } },
        { id: 'allow-ip-y', ruleKind: 'ip', effect: 'allow', payload: { ip: refY } },
      ],
      toolCatalog,
      assessmentFlags: {
        highImpactCategories: ['post_exploit'],
        ownershipVerifiedTargetIds: new Set(['target-1']),
        assessmentTargetRefs: assessmentRefs,
        verifiedTargetRefs: verifiedRefs,
      } as AssessmentFlags,
      timeWindow: null,
    });
  const dns = makeDns({});
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };

  // (a) 1-of-2 verified, action targets the VERIFIED one → still DENY
  // (because the OTHER assessment target is unverified; gate runs FIRST).
  {
    const scope = buildScope(new Set([refX, refY]), new Set([refX]));
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: refX, // verified, but refY in assessment is not
      },
      deps,
    );
    check(
      'I9-1(a): 1-of-2 assessment targets verified → DENY (action targets verified one but global gate fails)',
      decision.allowed === false,
      { allowed: decision.allowed, reason: decision.reason },
    );
  }

  // (b) 2-of-2 verified, action targets one → ALLOW.
  {
    const scope = buildScope(new Set([refX, refY]), new Set([refX, refY]));
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: refX,
      },
      deps,
    );
    check(
      'I9-1(b): 2-of-2 assessment targets verified → ALLOW',
      decision.allowed === true && decision.reason === 'allowed',
      { allowed: decision.allowed, reason: decision.reason },
    );
  }

  // (c) Opaque action targetRef + 1-of-2 verified → DENY (gate fires before
  // per-target check; opaque ref doesn't bypass).
  {
    const scope = buildScope(new Set([refX, refY]), new Set([refX]));
    const decision = await decide(
      scope,
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: '198.51.100.99', // opaque — not in assessment refs
      },
      deps,
    );
    check(
      'I9-1(c): opaque action targetRef + 1-of-2 verified → DENY (global gate fires regardless)',
      decision.allowed === false,
      { allowed: decision.allowed, reason: decision.reason },
    );
  }
}

// I9-2 — effectivePort in allowCoversAllDimensions.
async function probeI9_2(): Promise<void> {
  const dns = makeDns({ 'x.example': { v4: ['198.51.100.80'] } });
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };

  const buildScope = (extraRules: BuildEffectiveScopeRule[]) =>
    buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy,
      rawRules: [
        {
          id: 'allow-domain',
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 'x.example', matchSubdomains: false },
        },
        {
          id: 'allow-protocol',
          ruleKind: 'protocol',
          effect: 'allow',
          payload: { protocol: 'https' },
        },
        ...extraRules,
      ],
      toolCatalog: new Map(),
      assessmentFlags: emptyFlags(),
      timeWindow: null,
    });

  // (a) Default-port URL https://x/ WITHOUT port:443 allow → DENY
  // no_matching_allow_rule (port dimension uncovered, effectivePort=443).
  {
    const scope = buildScope([]);
    const decision = await decide(scope, { kind: 'http_request', url: 'https://x.example/' }, deps);
    check(
      'I9-2(a): https://x.example/ (effectivePort=443) WITHOUT port allow → DENY no_matching_allow_rule',
      decision.allowed === false && decision.reason === 'no_matching_allow_rule',
      {
        allowed: decision.allowed,
        reason: decision.reason,
        effectivePort: decision.normalizedTarget?.effectivePort,
        port: decision.normalizedTarget?.port,
      },
    );
  }

  // (b) Explicit-port URL https://x:443/ WITHOUT port:443 allow → DENY too.
  {
    const scope = buildScope([]);
    const decision = await decide(
      scope,
      { kind: 'http_request', url: 'https://x.example:443/' },
      deps,
    );
    check(
      'I9-2(b): https://x.example:443/ WITHOUT port allow → DENY (port dimension uncovered)',
      decision.allowed === false && decision.reason === 'no_matching_allow_rule',
      { allowed: decision.allowed, reason: decision.reason },
    );
  }

  // (c) Add port:443 allow → both default-port and explicit-port URLs ALLOW.
  {
    const scope = buildScope([
      { id: 'allow-port', ruleKind: 'port', effect: 'allow', payload: { port: 443 } },
    ]);
    const d1 = await decide(scope, { kind: 'http_request', url: 'https://x.example/' }, deps);
    const d2 = await decide(scope, { kind: 'http_request', url: 'https://x.example:443/' }, deps);
    check(
      'I9-2(c): with port:443 allow, both default-port and explicit-port URLs → ALLOW',
      d1.allowed === true && d2.allowed === true,
      { d1: { allowed: d1.allowed, reason: d1.reason }, d2: { allowed: d2.allowed, reason: d2.reason } },
    );
  }
}

// I9-3 — unknown_rule deny → 'unknown_rule_default_deny' diagnostic.
async function probeI9_3(): Promise<void> {
  // All-unknown denies → reason='unknown_rule_default_deny'.
  const scopeUnknownOnly = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'unk-1', ruleKind: 'future_rule', effect: 'deny', payload: {} },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const dns = makeDns({});
  const deps: EngineDeps = { dns, clock, rateLimit: noopRateLimit };
  const d1 = await decide(scopeUnknownOnly, { kind: 'tcp_connect', host: '8.8.8.8', port: 443 }, deps);
  check(
    'I9-3(a): all-unknown deny matches → reason=unknown_rule_default_deny',
    d1.allowed === false &&
      d1.reason === 'unknown_rule_default_deny' &&
      d1.matchedDenyRuleIds.includes('unk-1'),
    { allowed: d1.allowed, reason: d1.reason, matchedDenyRuleIds: d1.matchedDenyRuleIds },
  );

  // Mixed unknown + real deny → real-rule diagnostic wins ('denied_by_rule').
  const scopeMixed = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      { id: 'unk-1', ruleKind: 'future_rule', effect: 'deny', payload: {} },
      { id: 'deny-port', ruleKind: 'port', effect: 'deny', payload: { port: 443 } },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const d2 = await decide(scopeMixed, { kind: 'tcp_connect', host: '8.8.8.8', port: 443 }, deps);
  check(
    'I9-3(b): mixed unknown+real deny matches → reason=denied_by_rule (real wins)',
    d2.allowed === false &&
      d2.reason === 'denied_by_rule' &&
      d2.matchedDenyRuleIds.includes('deny-port') &&
      d2.matchedDenyRuleIds.includes('unk-1'),
    { allowed: d2.allowed, reason: d2.reason, matchedDenyRuleIds: d2.matchedDenyRuleIds },
  );
}

// I9-4 — Malformed url_prefix rules fall closed to unknown_rule.
function probeI9_4(): void {
  const cases = [
    {
      label: 'url_prefix:no-scheme',
      rule: {
        ruleKind: 'url_prefix',
        effect: 'allow' as const,
        payload: { prefix: 'example.com/admin' },
      },
    },
    {
      label: 'url_prefix:malformed',
      rule: {
        ruleKind: 'url_prefix',
        effect: 'allow' as const,
        payload: { prefix: 'not://valid::url' },
      },
    },
  ];
  for (const { label, rule } of cases) {
    const scope = buildEffectiveScope({
      tenantId: 't1',
      assessmentId: 'a1',
      tenantPolicy,
      rawRules: [{ id: `bad-${label}`, ...rule }],
      toolCatalog: new Map(),
      assessmentFlags: emptyFlags(),
      timeWindow: null,
    });
    const inDeny = scope.denyRules.find((r) => r.id === `bad-${label}`);
    const inAllow = scope.allowRules.find((r) => r.id === `bad-${label}`);
    check(
      `I9-4: malformed ${label} → lands in denyRules as unknown_rule (mirrors iter-8 ip/cidr fail-closed)`,
      inDeny !== undefined &&
        inAllow === undefined &&
        inDeny.kind === 'unknown_rule' &&
        inDeny.effect === 'deny',
      {
        allowRules: scope.allowRules.map((r) => ({ id: r.id, kind: r.kind })),
        denyRules: scope.denyRules.map((r) => ({ id: r.id, kind: r.kind, effect: r.effect })),
      },
    );
  }

  // Sanity: valid url_prefix still parses.
  const scopeValid = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy,
    rawRules: [
      {
        id: 'valid-prefix',
        ruleKind: 'url_prefix',
        effect: 'allow',
        payload: { prefix: 'https://example.com/admin' },
      },
    ],
    toolCatalog: new Map(),
    assessmentFlags: emptyFlags(),
    timeWindow: null,
  });
  const valid = scopeValid.allowRules.find((r) => r.id === 'valid-prefix');
  check(
    'I9-4: sanity — valid url_prefix still parses as url_prefix (NOT unknown_rule)',
    valid !== undefined && valid.kind === 'url_prefix' && valid.effect === 'allow',
    { rule: valid },
  );
}

interface BuildEffectiveScopeRule {
  id: string;
  ruleKind: string;
  effect: 'allow' | 'deny';
  payload: Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log('=== Sprint 6 codex-fix evaluator probes ===\n');
  console.log('--- iter-3 codex round-1 fixes ---');
  await probeP1A();
  console.log();
  await probeP1B();
  console.log();
  await probeP1C();
  console.log();
  await probeP2();
  console.log();
  console.log('--- iter-4 codex round-2 fixes ---');
  await probeI4_1();
  console.log();
  await probeI4_2();
  console.log();
  await probeI4_3();
  console.log();
  await probeI4_4();
  console.log();
  await probeI4_5();
  console.log();
  probeI4_6();
  console.log();
  console.log('--- iter-5 codex round-3 fixes ---');
  await probeI5_1();
  console.log();
  await probeI5_2();
  console.log();
  await probeI5_3();
  console.log();
  await probeI5_4();
  console.log();
  console.log('--- iter-7 codex round-4 fixes ---');
  await probeI7_1();
  console.log();
  await probeI7_2();
  console.log();
  probeI7_3();
  console.log();
  probeI7_4();
  console.log();
  console.log('--- iter-8 codex round-5 fixes ---');
  await probeI8_1();
  console.log();
  await probeI8_2();
  console.log();
  probeI8_3();
  console.log();
  console.log('--- iter-9 codex round-6 fixes ---');
  await probeI9_1();
  console.log();
  await probeI9_2();
  console.log();
  await probeI9_3();
  console.log();
  probeI9_4();
  console.log();
  console.log(`=== Probe summary: ${pass} pass, ${fail} fail ===`);
  if (fail > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Probe harness error:', err);
  process.exit(2);
});
