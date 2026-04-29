// Sprint 6 — decide(scope, action, deps) → Decision.
//
// Algorithm (A-SE-Pri-1):
//   1. Normalize action (DNS via injected resolver).
//   2. Apply platform-policy guards FIRST: metadata-IP block, private-IP block.
//      Any private/metadata IP in resolvedIps without an explicit allow short-
//      circuits to deny.
//   3. Mixed-script host (OQ-8) defaults to deny unless an explicit `domain`
//      allow names the punycode form.
//   4. Time-window AND-composition (OQ-4):
//        - Assessment-level window must contain `clock.now()`.
//        - Any `time_window`-kind rule of effect=allow must contain now;
//          any `time_window`-kind rule of effect=deny in-window denies.
//   5. Rate-limit rules: `rate_limit` rules consult the injected counter.
//      An exhausted bucket on a deny-effect rule denies; on an allow-effect
//      rule is a deny via `rate_limit_exceeded`.
//   6. Tool-category high-impact gate: if the action has a high-impact tool
//      category and the assessment doesn't list it OR ownership is not
//      verified for all targets → deny.
//   7. Deny rules — collect all matchers; any match → deny.
//   8. Allow rules — collect all matchers; require at least one match for the
//      decision to be `allowed`. If no allow matches → `no_matching_allow_rule`.

import type { ScopeActionInput, ToolCategory } from '@cyberstrike/contracts';
import { normalizeAction } from './normalize/index.ts';
import { matchRule } from './rules/matchers.ts';
import type {
  Decision,
  EffectiveScope,
  EngineDeps,
  NormalizedAction,
  NormalizedRule,
  ResolvedTarget,
  TimeWindowResult,
  ToolPolicyResult,
} from './types.ts';

const HIGH_IMPACT_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  'c2',
  'post_exploit',
  'ad',
  'credential_audit',
]);

// ============================================================================
// Helpers
// ============================================================================

const inWindow = (now: Date, start: string, end: string): boolean => {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;
  const nowMs = now.getTime();
  // Half-open [start, end) per R3.
  return nowMs >= startMs && nowMs < endMs;
};

interface PlatformGuardResult {
  readonly violation: 'metadata' | 'private' | 'loopback' | 'link_local' | null;
  readonly violatingIp?: string;
}

const platformIpGuard = (
  target: ResolvedTarget,
  scope: EffectiveScope,
  denyRules: readonly NormalizedRule[],
  allowRules: readonly NormalizedRule[],
): PlatformGuardResult => {
  const ips = target.resolvedIps ?? [];
  for (const ip of ips) {
    if (ip.classification === 'metadata') {
      // Override only via explicit `ip` allow + platform flag.
      if (!scope.platformPolicy.allowMetadataIpExplicit) {
        return { violation: 'metadata', violatingIp: ip.canonical };
      }
      const explicitAllow = allowRules.some((r) => r.kind === 'ip' && r.ip === ip.canonical);
      if (!explicitAllow) return { violation: 'metadata', violatingIp: ip.canonical };
    }
    if (ip.classification === 'private') {
      if (!scope.platformPolicy.allowPrivateIpExplicit) {
        const explicitAllow = allowRules.some(
          (r) =>
            (r.kind === 'ip' && r.ip === ip.canonical) ||
            (r.kind === 'cidr' && matchRule(r, { resolvedIps: [ip] })),
        );
        if (!explicitAllow) return { violation: 'private', violatingIp: ip.canonical };
      }
    }
    if (ip.classification === 'loopback') {
      const explicitAllow = allowRules.some(
        (r) =>
          (r.kind === 'ip' && r.ip === ip.canonical) ||
          (r.kind === 'cidr' && matchRule(r, { resolvedIps: [ip] })),
      );
      if (!explicitAllow) return { violation: 'loopback', violatingIp: ip.canonical };
    }
    if (ip.classification === 'link_local') {
      const explicitAllow = allowRules.some(
        (r) =>
          (r.kind === 'ip' && r.ip === ip.canonical) ||
          (r.kind === 'cidr' && matchRule(r, { resolvedIps: [ip] })),
      );
      if (!explicitAllow) return { violation: 'link_local', violatingIp: ip.canonical };
    }
  }
  // Suppress unused — denyRules participate in caller logic, not here.
  void denyRules;
  return { violation: null };
};

const evaluateTimeWindow = (scope: EffectiveScope, now: Date): TimeWindowResult => {
  if (!scope.timeWindow) {
    return { hasWindow: false, inWindow: true, checkedAt: now.toISOString() };
  }
  return {
    hasWindow: true,
    inWindow: inWindow(now, scope.timeWindow.start, scope.timeWindow.end),
    start: scope.timeWindow.start,
    end: scope.timeWindow.end,
    checkedAt: now.toISOString(),
  };
};

const evaluateTimeWindowRules = (
  rules: readonly NormalizedRule[],
  now: Date,
): { allowOk: boolean; denyHit: NormalizedRule | null } => {
  let allowOk = true;
  let denyHit: NormalizedRule | null = null;
  for (const r of rules) {
    if (r.kind !== 'time_window') continue;
    const within = inWindow(now, r.start, r.end);
    if (r.effect === 'allow' && !within) {
      // Allow rule whose window does NOT contain now.
      allowOk = false;
    }
    if (r.effect === 'deny' && within) {
      denyHit = r;
      break;
    }
  }
  return { allowOk, denyHit };
};

type ToolPolicyVerdict = 'ok' | 'category_mismatch' | 'unverified_ownership' | 'target_unverified';

interface ExtendedToolPolicyResult extends ToolPolicyResult {
  readonly verdict: ToolPolicyVerdict;
}

const evaluateToolPolicy = (
  target: ResolvedTarget,
  scope: EffectiveScope,
): ExtendedToolPolicyResult => {
  const callerCategory = target.toolCategory;
  const name = target.toolName;
  const catalogEntry = name !== undefined ? scope.toolCatalog.get(name) : undefined;
  const inCatalog = catalogEntry !== undefined;
  // codex P1 — when the tool is in the catalog, the catalog is the source of
  // truth for both `category` and `highImpact`. A caller cannot mislabel a
  // post_exploit tool as `web` to bypass HIGH_IMPACT_CATEGORIES.
  const effectiveCategory: ToolCategory | undefined = inCatalog
    ? catalogEntry.category
    : callerCategory;
  const highImpact = inCatalog
    ? catalogEntry.highImpact
    : effectiveCategory !== undefined && HIGH_IMPACT_CATEGORIES.has(effectiveCategory);

  // Mismatch detection — caller said one category, catalog says another.
  const categoryMismatch =
    inCatalog && callerCategory !== undefined && callerCategory !== catalogEntry.category;

  let highImpactGateOk = true;
  let verdict: ToolPolicyVerdict = 'ok';
  if (highImpact && effectiveCategory !== undefined) {
    const declared = scope.assessmentFlags.highImpactCategories.includes(effectiveCategory);
    if (!declared) {
      highImpactGateOk = false;
      verdict = 'unverified_ownership'; // legacy reason kept for declared-mismatch path
    } else {
      // codex iter-9 P1 — product-spec invariant #4 requires EVERY assessment
      // target is verified.
      // codex iter-10 P1 — gate compares target IDs, not canonical refs.
      // Two targets with the same canonical ref (e.g. URL `https://example.com/`
      // and domain `example.com` both → ref `example.com`) would dedupe in
      // a Set<ref> and silently mask an unverified target. ID sets keep
      // them distinct so the all-verified rule actually holds.
      const verifiedIds = scope.assessmentFlags.ownershipVerifiedTargetIds;
      const assessmentRefs = scope.assessmentFlags.assessmentTargetRefs;
      const verifiedRefs = scope.assessmentFlags.verifiedTargetRefs;
      const assessmentTargetIds = scope.assessmentFlags.assessmentTargetIds;
      const verifiedTargetIds = scope.assessmentFlags.verifiedTargetIds;
      if (verifiedIds.size === 0) {
        highImpactGateOk = false;
        verdict = 'unverified_ownership';
      } else if (
        // Primary gate (codex iter-10 P1): by target ID.
        assessmentTargetIds !== undefined &&
        verifiedTargetIds !== undefined &&
        assessmentTargetIds.size > 0 &&
        ![...assessmentTargetIds].every((id) => verifiedTargetIds.has(id))
      ) {
        highImpactGateOk = false;
        verdict = 'target_unverified';
      } else if (
        // Belt-and-suspenders: legacy ref-set gate retained when ID sets
        // aren't provided (older callers / unit-test fixtures).
        (assessmentTargetIds === undefined || verifiedTargetIds === undefined) &&
        assessmentRefs !== undefined &&
        verifiedRefs !== undefined &&
        assessmentRefs.size > 0 &&
        ![...assessmentRefs].every((r) => verifiedRefs.has(r))
      ) {
        highImpactGateOk = false;
        verdict = 'target_unverified';
      } else {
        // Per-target check: if the action has a targetRef matching an
        // assessment target, that target must be verified. Retained for
        // belt-and-suspenders semantics on the URL→canonical-host case.
        const refs = collectTargetRefs(target);
        if (refs.length > 0 && assessmentRefs && assessmentRefs.size > 0) {
          const hitsAssessment = refs.some((r) => assessmentRefs.has(r));
          if (hitsAssessment) {
            const hitsVerified = verifiedRefs ? refs.some((r) => verifiedRefs.has(r)) : false;
            if (!hitsVerified) {
              highImpactGateOk = false;
              verdict = 'target_unverified';
            }
          }
        }
      }
    }
  }
  // codex P1 — surface category mismatch as a deny verdict (overrides 'ok').
  if (verdict === 'ok' && categoryMismatch) {
    highImpactGateOk = false;
    verdict = 'category_mismatch';
  }

  return {
    ...(name !== undefined ? { toolName: name } : {}),
    ...(effectiveCategory !== undefined ? { category: effectiveCategory } : {}),
    inCatalog,
    highImpact,
    highImpactGateOk,
    verdict,
  };
};

// Collect the canonical target-ref values for the action (host, url, IP
// canonicals). Used to compare against assessmentFlags.{verified,assessment}TargetRefs.
const collectTargetRefs = (target: ResolvedTarget): readonly string[] => {
  const refs: string[] = [];
  if (target.host !== undefined) refs.push(target.host);
  if (target.url !== undefined) refs.push(target.url);
  if (target.resolvedIps !== undefined) {
    for (const ip of target.resolvedIps) refs.push(ip.canonical);
  }
  return refs;
};

// Dimension-coverage check for allow rules. Each present dimension on the
// target needs at least one matching allow rule. We only require coverage on
// dimensions that actually exist in the target — e.g. if there's no port,
// we don't require a port allow. Dimensions: host (domain/subdomain), url,
// ip/cidr, port, protocol, tool, http_method, path, cloud, k8s, repo.
const allowCoversAllDimensions = (
  target: ResolvedTarget,
  matchedAllowRules: readonly NormalizedRule[],
): boolean => {
  const has = (kinds: NormalizedRule['kind'][]): boolean =>
    matchedAllowRules.some((r) => kinds.includes(r.kind));

  // codex iter-5 P2 — IP-literal hosts (`https://8.8.8.8/`,
  // `http://[2001:db8::1]/`, `tcp_connect ::1`) are naturally covered by
  // ip/cidr allow rules. Don't demand a domain/subdomain/url_prefix rule
  // for them.
  if (target.host !== undefined) {
    if (target.hostIsIp === true) {
      if (!has(['ip', 'cidr', 'domain', 'subdomain', 'url_prefix'])) return false;
    } else if (!has(['domain', 'subdomain', 'url_prefix'])) {
      return false;
    }
  }
  if (
    target.resolvedIps !== undefined &&
    target.resolvedIps.length > 0 &&
    !has(['ip', 'cidr', 'domain', 'subdomain', 'url_prefix'])
  ) {
    return false;
  }
  // codex iter-9 P2 — effectivePort is the canonical port dimension for
  // policy coverage. normalizeUrl populates it for default-port-elided URLs
  // (e.g. `https://x/` → effectivePort=443) so port restrictions apply to
  // the most common URL forms. `target.port` covers the explicit-port and
  // tcp_connect cases — whichever fires first.
  if (
    (target.effectivePort !== undefined || target.port !== undefined) &&
    !has(['port', 'url_prefix'])
  ) {
    return false;
  }
  if (target.protocol !== undefined && !has(['protocol', 'url_prefix'])) return false;
  if (target.toolName !== undefined && !has(['tool_name', 'tool_category'])) return false;
  if (target.toolCategory !== undefined && !has(['tool_category', 'tool_name'])) {
    return false;
  }
  if (target.method !== undefined && !has(['http_method', 'url_prefix'])) return false;
  if (target.path !== undefined && target.path !== '/' && !has(['path_pattern', 'url_prefix'])) {
    return false;
  }
  if (
    target.cloudProvider !== undefined &&
    target.cloudAccountId !== undefined &&
    !has(['cloud_account'])
  ) {
    return false;
  }
  if (
    target.k8sCluster !== undefined &&
    target.k8sNamespace !== undefined &&
    !has(['kubernetes_namespace'])
  ) {
    return false;
  }
  if (target.vcs !== undefined && target.repoOwner !== undefined && !has(['repository'])) {
    return false;
  }
  return true;
};

// ============================================================================
// Public entry
// ============================================================================

export const decide = async (
  scope: EffectiveScope,
  action: ScopeActionInput,
  deps: EngineDeps,
): Promise<Decision> => {
  let normalized: NormalizedAction;
  try {
    normalized = await normalizeAction(action, deps);
  } catch (_err) {
    return {
      allowed: false,
      reason: 'normalization_error',
      matchedAllowRuleIds: [],
      matchedDenyRuleIds: [],
    };
  }

  const target = normalized.target;
  const now = deps.clock.now();

  // Step: assessment-level time window (OQ-4 AND-composition #1).
  const tw = evaluateTimeWindow(scope, now);
  if (!tw.inWindow) {
    return {
      allowed: false,
      reason: 'time_window_closed',
      matchedAllowRuleIds: [],
      matchedDenyRuleIds: [],
      normalizedTarget: target,
      timeWindowResult: tw,
    };
  }

  const allTargetsForCheck: readonly ResolvedTarget[] = [
    target,
    ...(target.redirectNormalizedTargets ?? []),
  ];

  // Step: mixed-script host default-deny (OQ-8). codex iter-4 — runs BEFORE
  // the DNS fail-closed gate because mixed-script is a homograph attack
  // signal that's deny-worthy regardless of whether DNS resolves.
  for (const t of allTargetsForCheck) {
    if (t.hostHasMixedScript) {
      const explicit = scope.allowRules.some((r) => {
        if (r.kind === 'domain' && t.host !== undefined) {
          return r.pattern === t.host;
        }
        return false;
      });
      if (!explicit) {
        return {
          allowed: false,
          reason: 'mixed_script_host_blocked',
          matchedAllowRuleIds: [],
          matchedDenyRuleIds: [],
          normalizedTarget: target,
          timeWindowResult: tw,
        };
      }
    }
  }

  // codex iter-4 P1 — fail closed when DNS was attempted but returned empty
  // (NXDOMAIN-like). Otherwise a domain/protocol allow can return `allowed`
  // for a resolvable-looking target whose IP coverage was never exercised,
  // and SSRF guards never get a chance to fire.
  const dnsFailedTarget = allTargetsForCheck.find((t) => t.dnsResolution === 'failed');
  if (dnsFailedTarget !== undefined) {
    return {
      allowed: false,
      reason: 'dns_resolution_failed',
      matchedAllowRuleIds: [],
      matchedDenyRuleIds: [],
      normalizedTarget: target,
      timeWindowResult: tw,
    };
  }

  // Step: platform-policy IP guards. codex iter-4 P1 — also runs on every
  // redirect normalized target so a redirect to a metadata/private IP denies
  // even if the primary target is on the public internet.
  for (const t of allTargetsForCheck) {
    const guard = platformIpGuard(t, scope, scope.denyRules, scope.allowRules);
    if (guard.violation) {
      const reason =
        guard.violation === 'metadata'
          ? ('metadata_ip_blocked' as const)
          : guard.violation === 'private'
            ? ('private_ip_blocked' as const)
            : guard.violation === 'loopback'
              ? ('loopback_blocked' as const)
              : ('link_local_blocked' as const);
      return {
        allowed: false,
        reason,
        matchedAllowRuleIds: [],
        matchedDenyRuleIds: [],
        normalizedTarget: target,
        timeWindowResult: tw,
      };
    }
  }

  // Step: time-window rules AND-compose (OQ-4 #2).
  const rulesTime = evaluateTimeWindowRules([...scope.allowRules, ...scope.denyRules], now);
  if (rulesTime.denyHit) {
    return {
      allowed: false,
      reason: 'denied_by_rule',
      matchedAllowRuleIds: [],
      matchedDenyRuleIds: [rulesTime.denyHit.id],
      normalizedTarget: target,
      timeWindowResult: tw,
    };
  }

  // Step: rate-limit rules (R8 / OQ-5).
  // codex iter-7 P1 — bucket key namespaced by tenantId+assessmentId so two
  // tenants using the same bucket name (e.g. 'recon') don't share tokens.
  // The injected `RateLimitCounter` MUST treat the namespaced key as opaque
  // and never share state across distinct keys. Hard tenant-isolation
  // invariant — never collapse the namespace.
  for (const r of [...scope.denyRules, ...scope.allowRules]) {
    if (r.kind !== 'rate_limit') continue;
    const namespacedBucket = `${scope.tenantId}:${scope.assessmentId}:${r.bucket}`;
    const consume = deps.rateLimit.consume(namespacedBucket, r.perSecond, r.burst);
    if (!consume.ok) {
      return {
        allowed: false,
        reason: 'rate_limit_exceeded',
        matchedAllowRuleIds: [],
        matchedDenyRuleIds: [r.id],
        normalizedTarget: target,
        timeWindowResult: tw,
      };
    }
  }

  // Step: tool policy.
  const fullToolPolicyResult = evaluateToolPolicy(target, scope);
  const { verdict, ...toolPolicyResult } = fullToolPolicyResult;
  // codex iter-8 P1 — uncatalogued tool denies BEFORE rule matching so a
  // broad `tool_category` allow can't smuggle a misspelled or off-list tool.
  // The toolCatalog is the source of truth: if the action names a tool, it
  // MUST be present in the catalog.
  if (
    action.kind === 'tool_invoke' &&
    target.toolName !== undefined &&
    toolPolicyResult.inCatalog === false
  ) {
    return {
      allowed: false,
      reason: 'tool_not_in_catalog',
      matchedAllowRuleIds: [],
      matchedDenyRuleIds: [],
      normalizedTarget: target,
      toolPolicyResult,
      timeWindowResult: tw,
    };
  }
  // codex P1 — category_mismatch denies even if the caller-supplied category
  // wasn't high-impact. The catalog is authoritative; lying is a deny.
  if (verdict === 'category_mismatch') {
    return {
      allowed: false,
      reason: 'tool_category_mismatch',
      matchedAllowRuleIds: [],
      matchedDenyRuleIds: [],
      normalizedTarget: target,
      toolPolicyResult,
      timeWindowResult: tw,
    };
  }
  if (toolPolicyResult.highImpact && !toolPolicyResult.highImpactGateOk) {
    const reason =
      verdict === 'unverified_ownership'
        ? // No declared category OR no verified target IDs at all.
          !scope.assessmentFlags.highImpactCategories.includes(
            toolPolicyResult.category as ToolCategory,
          )
          ? ('tool_category_high_impact_unverified_targets' as const)
          : ('high_impact_unverified_ownership' as const)
        : verdict === 'target_unverified'
          ? ('high_impact_target_unverified' as const)
          : ('tool_category_high_impact_unverified_targets' as const);
    return {
      allowed: false,
      reason,
      matchedAllowRuleIds: [],
      matchedDenyRuleIds: [],
      normalizedTarget: target,
      toolPolicyResult,
      timeWindowResult: tw,
    };
  }

  // Step: deny rules — exhaustive iteration on PRIMARY target AND every
  // redirect normalized target (codex iter-4 P1). Any matched deny on any
  // URL in the chain → overall DENY.
  const matchedDenyRules: NormalizedRule[] = [];
  for (const t of allTargetsForCheck) {
    for (const r of scope.denyRules) {
      if (matchRule(r, t) && !matchedDenyRules.some((a) => a.id === r.id)) {
        matchedDenyRules.push(r);
      }
    }
  }
  if (matchedDenyRules.length > 0) {
    // codex iter-9 P2 — surface a sharper diagnostic when ALL matched deny
    // rules are unknown_rule sentinels (forward-compat fallback). Mixed
    // (some unknown + some real) keeps `denied_by_rule` since a real rule
    // fired. Audit consumers can distinguish "real deny rule fired" from
    // "fallback caught unknown rule".
    const allUnknown = matchedDenyRules.every((r) => r.kind === 'unknown_rule');
    return {
      allowed: false,
      reason: allUnknown ? 'unknown_rule_default_deny' : 'denied_by_rule',
      matchedAllowRuleIds: [],
      matchedDenyRuleIds: matchedDenyRules.map((r) => r.id),
      normalizedTarget: target,
      toolPolicyResult,
      timeWindowResult: tw,
    };
  }

  // Step: allow rules — every URL in the chain (primary + each redirect) MUST
  // independently satisfy the allow-coverage check. A single redirect to an
  // out-of-scope destination → no_matching_allow_rule (codex iter-4 P1).
  const allMatchedAllowRules: NormalizedRule[] = [];
  for (const t of allTargetsForCheck) {
    const ms = scope.allowRules.filter((r) => matchRule(r, t));
    for (const r of ms) {
      if (!allMatchedAllowRules.some((a) => a.id === r.id)) allMatchedAllowRules.push(r);
    }
  }
  const matchedAllowRuleIds = allMatchedAllowRules.map((r) => r.id);
  if (!rulesTime.allowOk) {
    return {
      allowed: false,
      reason: 'time_window_closed',
      matchedAllowRuleIds,
      matchedDenyRuleIds: [],
      normalizedTarget: target,
      toolPolicyResult,
      timeWindowResult: tw,
    };
  }
  for (const t of allTargetsForCheck) {
    const matchedForT = scope.allowRules.filter((r) => matchRule(r, t));
    if (matchedForT.length === 0 || !allowCoversAllDimensions(t, matchedForT)) {
      return {
        allowed: false,
        reason: 'no_matching_allow_rule',
        matchedAllowRuleIds,
        matchedDenyRuleIds: [],
        normalizedTarget: target,
        toolPolicyResult,
        timeWindowResult: tw,
      };
    }
  }

  return {
    allowed: true,
    reason: 'allowed',
    matchedAllowRuleIds,
    matchedDenyRuleIds: [],
    normalizedTarget: target,
    toolPolicyResult,
    timeWindowResult: tw,
  };
};
