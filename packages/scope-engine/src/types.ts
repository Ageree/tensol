// Sprint 6 — Engine type surface.
//
// Pure types only. No I/O. The engine's normalized rule shape (after the
// loose-or-strict decode handled by `effective-scope.ts`) is a discriminated
// union over the 16 closed-set ruleKinds AND a synthetic `unknown_rule`
// sentinel emitted when a persisted row uses a ruleKind outside the set
// (A-SE-Pri-3 / A-SE-Compat-1).

import type {
  CloudProvider,
  DecisionReason,
  HttpMethod,
  Protocol,
  ScopeActionKind,
  ToolCategory,
  VcsProvider,
} from '@cyberstrike/contracts';

// ============================================================================
// Rule kinds (engine-side) — 16 closed-set + 1 `unknown_rule` sentinel
// ============================================================================

export const ENGINE_RULE_KINDS = [
  'domain',
  'subdomain',
  'url_prefix',
  'ip',
  'cidr',
  'port',
  'protocol',
  'cloud_account',
  'kubernetes_namespace',
  'repository',
  'time_window',
  'rate_limit',
  'tool_category',
  'tool_name',
  'http_method',
  'path_pattern',
  'unknown_rule',
] as const;

export type EngineRuleKind = (typeof ENGINE_RULE_KINDS)[number];

/**
 * 16-kind closed set used for cardinality assertions in tests (R1).
 * Excludes the `unknown_rule` synthetic sentinel.
 */
export const RULE_KINDS = ENGINE_RULE_KINDS.filter(
  (k): k is Exclude<EngineRuleKind, 'unknown_rule'> => k !== 'unknown_rule',
) as readonly Exclude<EngineRuleKind, 'unknown_rule'>[];

export type RuleKind = (typeof RULE_KINDS)[number];

// ============================================================================
// NormalizedRule discriminated union
// ============================================================================

export type Effect = 'allow' | 'deny';

export interface RuleBase {
  readonly id: string;
  readonly effect: Effect;
}

export type NormalizedRule =
  | (RuleBase & { kind: 'domain'; pattern: string; matchSubdomains: boolean })
  | (RuleBase & { kind: 'subdomain'; parent: string })
  | (RuleBase & { kind: 'url_prefix'; prefix: string })
  | (RuleBase & { kind: 'ip'; ip: string })
  | (RuleBase & { kind: 'cidr'; cidr: string })
  | (RuleBase & { kind: 'port'; port: number })
  | (RuleBase & { kind: 'protocol'; protocol: Protocol })
  | (RuleBase & { kind: 'cloud_account'; provider: CloudProvider; accountId: string })
  | (RuleBase & { kind: 'kubernetes_namespace'; cluster: string; namespace: string })
  | (RuleBase & {
      kind: 'repository';
      vcs: VcsProvider;
      owner: string;
      name: string;
    })
  | (RuleBase & { kind: 'time_window'; start: string; end: string })
  | (RuleBase & { kind: 'rate_limit'; bucket: string; perSecond: number; burst: number })
  | (RuleBase & { kind: 'tool_category'; category: ToolCategory })
  | (RuleBase & { kind: 'tool_name'; toolName: string })
  | (RuleBase & { kind: 'http_method'; method: HttpMethod })
  | (RuleBase & { kind: 'path_pattern'; glob: string })
  | (RuleBase & { kind: 'unknown_rule'; rawRuleKind: string });

// ============================================================================
// Time window
// ============================================================================

export interface TimeWindow {
  readonly start: string; // ISO-8601
  readonly end: string; // ISO-8601 — half-open [start, end) per R3.
}

// ============================================================================
// Tool catalog
// ============================================================================

export interface ToolPolicy {
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly highImpact: boolean;
}

// ============================================================================
// Assessment-level flags
// ============================================================================

export interface AssessmentFlags {
  readonly highImpactCategories: readonly ToolCategory[];
  /**
   * Set of target IDs whose `ownership_status` is `'verified'` at the time the
   * effective scope is built. Used to gate high-impact tool categories
   * (A-SE-Pri step 7).
   */
  readonly ownershipVerifiedTargetIds: ReadonlySet<string>;
  /**
   * Canonical target-ref values (host / IP / url) for assessment targets whose
   * `ownership_status` is `'verified'`. Populated by `build-scope`. Used by the
   * engine to enforce per-target verification on tool_invoke actions whose
   * targetRef maps to an assessment target (codex P1).
   */
  readonly verifiedTargetRefs?: ReadonlySet<string>;
  /**
   * Canonical target-ref values for ALL assessment targets (verified or not).
   * Used to detect "action targets an assessment target": if the action's
   * targetRef appears here AND not in `verifiedTargetRefs`, the high-impact
   * gate denies with `high_impact_target_unverified`.
   */
  readonly assessmentTargetRefs?: ReadonlySet<string>;
  /**
   * codex iter-10 P1 — All target IDs in the assessment. The all-targets-
   * verified gate compares this against `verifiedTargetIds` so that two
   * targets with the same canonical ref (e.g. URL `https://example.com/`
   * and domain `example.com` both → ref `example.com`) don't dedupe and
   * mask an unverified target.
   */
  readonly assessmentTargetIds?: ReadonlySet<string>;
  /**
   * codex iter-10 P1 — Target IDs whose ownership_status='verified'. Mirror
   * of `ownershipVerifiedTargetIds` but exposed as the canonical ID-set
   * companion to `assessmentTargetIds` for the all-targets-verified rule.
   */
  readonly verifiedTargetIds?: ReadonlySet<string>;
}

// ============================================================================
// Tenant + platform policies
// ============================================================================

export interface TenantPolicy {
  readonly tenantId: string;
  /** Reserved for future tenant-wide knobs (Sprint 7+). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface PlatformPolicy {
  /**
   * Default-on guard against SSRF metadata-IPs (`169.254.169.254`,
   * `100.100.100.200`, etc.). Setting this `true` requires an explicit
   * platform_admin override (Phase 9 — currently no surface to flip it).
   */
  readonly allowMetadataIpExplicit: boolean;
  /**
   * Default-on guard against private/loopback/link-local IPs in the resolved
   * destination. Override requires an explicit `cidr` or `ip` allow rule.
   */
  readonly allowPrivateIpExplicit: boolean;
}

// ============================================================================
// Effective scope (frozen at construction)
// ============================================================================

export interface EffectiveScope {
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly allowRules: readonly NormalizedRule[];
  readonly denyRules: readonly NormalizedRule[];
  readonly toolCatalog: ReadonlyMap<string, ToolPolicy>;
  readonly assessmentFlags: AssessmentFlags;
  readonly timeWindow: TimeWindow | null;
  readonly platformPolicy: PlatformPolicy;
  readonly tenantPolicy: TenantPolicy;
}

// ============================================================================
// Normalized action (post-DNS, post-canonicalization)
// ============================================================================

export type IpClassification =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link_local'
  | 'metadata'
  | 'reserved';

export interface NormalizedIp {
  readonly family: 'ipv4' | 'ipv6';
  readonly canonical: string; // R4 — does NOT include zone-id
  readonly zoneId?: string;
  readonly classification: IpClassification;
}

/**
 * codex iter-4 P1 — DNS resolution outcome.
 *  - 'success': DNS attempted, returned ≥1 IP.
 *  - 'failed': DNS attempted, returned empty (NXDOMAIN-like) → fail-closed.
 *  - 'not_applicable': target had no host needing resolution (raw IP, opaque ref).
 */
export type DnsResolutionStatus = 'success' | 'failed' | 'not_applicable';

export interface ResolvedTarget {
  readonly host?: string; // canonical (lowercase ASCII, IDN→punycode, or IPv4/IPv6 literal)
  readonly hostHasMixedScript?: boolean; // OQ-8 — homograph signal
  /**
   * codex iter-5 P2 — true when the host is an IP literal (IPv4 or IPv6,
   * brackets stripped). decide.allowCoversAllDimensions treats IP-literal
   * hosts as covered by ip/cidr allow rules instead of demanding domain rules.
   */
  readonly hostIsIp?: boolean;
  readonly resolvedIps?: readonly NormalizedIp[];
  /** codex iter-4 P1 — DNS outcome sentinel; decide() fails closed on 'failed'. */
  readonly dnsResolution?: DnsResolutionStatus;
  readonly url?: string; // canonical URL when applicable
  readonly port?: number;
  /**
   * codex iter-4 P1 — port used for policy matching. Equals `port` when the
   * caller specified an explicit port; falls back to the scheme's default
   * (http→80, https→443, ws→80, wss→443) when default-port elision would
   * otherwise drop the dimension. Port-rule matchers consult this.
   */
  readonly effectivePort?: number;
  readonly protocol?: Protocol;
  readonly path?: string;
  readonly method?: HttpMethod;
  readonly redirectTargets?: readonly string[]; // canonical URLs (audit/evidence only)
  /**
   * codex iter-4 P1 — independently-normalized redirect destinations.
   * decide() runs the full allow/deny matcher on each entry; any deny on any
   * entry → overall DENY with all matched deny rule ids.
   */
  readonly redirectNormalizedTargets?: readonly ResolvedTarget[];
  readonly toolName?: string;
  readonly toolCategory?: ToolCategory;
  readonly cloudProvider?: CloudProvider;
  readonly cloudAccountId?: string;
  readonly k8sCluster?: string;
  readonly k8sNamespace?: string;
  readonly vcs?: VcsProvider;
  readonly repoOwner?: string;
  readonly repoName?: string;
}

export interface NormalizedAction {
  readonly kind: ScopeActionKind;
  readonly target: ResolvedTarget;
}

export interface NormalizationError {
  readonly kind: 'normalization_error';
  readonly message: string;
}

// ============================================================================
// Engine deps — injected interfaces (zero I/O imports inside the engine)
// ============================================================================

export interface DnsResolver {
  resolveA(host: string): Promise<string[]>;
  resolveAAAA(host: string): Promise<string[]>;
}

export interface Clock {
  now(): Date;
}

export interface RateLimitConsumeResult {
  readonly ok: boolean;
  readonly retryAfterMs?: number;
}

export interface RateLimitCounter {
  consume(bucket: string, perSecond: number, burst: number): RateLimitConsumeResult;
}

export interface EngineDeps {
  readonly dns: DnsResolver;
  readonly clock: Clock;
  readonly rateLimit: RateLimitCounter;
}

// ============================================================================
// Decision shape (mirror of contracts.Decision but with NormalizedAction)
// ============================================================================

export interface ToolPolicyResult {
  readonly toolName?: string;
  readonly category?: ToolCategory;
  readonly inCatalog: boolean;
  readonly highImpact: boolean;
  readonly highImpactGateOk: boolean;
}

export interface TimeWindowResult {
  readonly hasWindow: boolean;
  readonly inWindow: boolean;
  readonly start?: string;
  readonly end?: string;
  readonly checkedAt: string;
}

export interface Decision {
  readonly allowed: boolean;
  readonly reason: DecisionReason;
  readonly matchedAllowRuleIds: readonly string[];
  readonly matchedDenyRuleIds: readonly string[];
  readonly normalizedTarget?: ResolvedTarget;
  readonly toolPolicyResult?: ToolPolicyResult;
  readonly timeWindowResult?: TimeWindowResult;
}
