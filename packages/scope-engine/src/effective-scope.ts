// Sprint 6 — buildEffectiveScope: pure rule normalization + freeze.
//
// Inputs include both legacy (Sprint 5 open-payload) and strict (Sprint 6
// discriminated union) rule rows. Out-of-set ruleKinds map to `unknown_rule`
// (A-SE-Pri-3 / A-SE-Compat-1 default-deny).

import {
  RULE_KINDS as CONTRACT_RULE_KINDS,
  type LegacyScopeRule,
  type StrictScopeRule,
  strictScopeRuleSchema,
} from '@cyberstrike/contracts';
import { normalizeHost } from './normalize/host.ts';
import { normalizeIp } from './normalize/ip.ts';
import { normalizeUrl } from './normalize/url.ts';
import type {
  AssessmentFlags,
  EffectiveScope,
  NormalizedRule,
  PlatformPolicy,
  TenantPolicy,
  TimeWindow,
  ToolPolicy,
} from './types.ts';

// We accept the broader contract type even though `legacyScopeRulePayload` is
// not exported from the index — the loose decode is defensive.
type LegacyLike = {
  ruleKind: string;
  effect: 'allow' | 'deny';
  payload: Record<string, unknown>;
};

const STRICT_KINDS = new Set<string>(CONTRACT_RULE_KINDS);

/**
 * codex iter-10 P2 — translate well-known legacy payload shapes to the
 * strict shape BEFORE strict zod parse. Sprint-5-era persisted `domain` /
 * `subdomain` rows used `{domain: '...'}` instead of `{pattern}` / `{parent}`;
 * without this translation those rows fall through to the unknown_rule
 * fail-closed branch — a backward-compat regression that turns existing
 * legitimate `allow domain` rules into hard denies.
 *
 * Forward-shape (`pattern`/`parent`) wins when both forms are present.
 */
const translateLegacyPayload = (
  ruleKind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  const p = payload as {
    pattern?: unknown;
    parent?: unknown;
    domain?: unknown;
    matchSubdomains?: unknown;
  };
  if (ruleKind === 'domain' && p.pattern === undefined && typeof p.domain === 'string') {
    return {
      pattern: p.domain,
      matchSubdomains: p.matchSubdomains ?? false,
    };
  }
  if (ruleKind === 'subdomain' && p.parent === undefined && typeof p.domain === 'string') {
    return { parent: p.domain };
  }
  return payload;
};

/** Decode a single persisted scope rule row (strict path then legacy fallback). */
const decodeRule = (
  id: string,
  row: { ruleKind: string; effect: 'allow' | 'deny'; payload: Record<string, unknown> },
): NormalizedRule => {
  // If the row's ruleKind is in the closed set, attempt strict decode by
  // flattening payload onto the discriminated union shape. This matches what
  // the API write path produces (Sprint 6 onwards).
  if (STRICT_KINDS.has(row.ruleKind)) {
    const translated = translateLegacyPayload(row.ruleKind, row.payload);
    const flat = { ruleKind: row.ruleKind, effect: row.effect, ...translated };
    const parsed = strictScopeRuleSchema.safeParse(flat);
    if (parsed.success) {
      // codex iter-8 P2 — even if zod accepts the shape, semantic validation
      // (e.g. cidr `8.8.8.0/bad` parses zod-wise but is unparseable) may fail.
      // materializeStrict returns null on semantic failure; we then fall
      // through to the unknown_rule fail-closed branch below.
      const materialized = materializeStrict(id, parsed.data);
      if (materialized !== null) return materialized;
    }
  }
  // Out-of-set, legacy payload that fails strict zod, OR semantically invalid
  // known-kind row → unknown_rule sentinel. Force effect:'deny' so unknown
  // rules surface in `denyRules` / `matchedDenyRuleIds` and contribute to the
  // deny-overrides-allow contract regardless of the caller-supplied effect
  // (codex P2 round-1 + iter-8 — fail-closed for forward-compat AND for
  // malformed known-kind rows).
  return { id, kind: 'unknown_rule', effect: 'deny', rawRuleKind: row.ruleKind };
};

/**
 * Materialize a strict-validated rule into the engine's NormalizedRule shape.
 * Returns null when the payload is zod-valid but semantically invalid
 * (e.g. ip = '999.999.999.999' or cidr = '8.8.8.0/bad') — codex iter-8 P2 has
 * decodeRule fail closed by routing such rows to `unknown_rule`. Hostname-shaped
 * fields (domain.pattern, subdomain.parent) keep their lossy lowercasing
 * fallback for compatibility with sprint-5 IT seeds.
 */
const materializeStrict = (id: string, rule: StrictScopeRule): NormalizedRule | null => {
  switch (rule.ruleKind) {
    case 'domain': {
      const hostNorm = (() => {
        try {
          return normalizeHost(rule.pattern).canonical;
        } catch {
          return rule.pattern.toLowerCase();
        }
      })();
      return {
        id,
        kind: 'domain',
        effect: rule.effect,
        pattern: hostNorm,
        matchSubdomains: rule.matchSubdomains,
      };
    }
    case 'subdomain': {
      const parent = (() => {
        try {
          return normalizeHost(rule.parent).canonical;
        } catch {
          return rule.parent.toLowerCase();
        }
      })();
      return { id, kind: 'subdomain', effect: rule.effect, parent };
    }
    case 'url_prefix': {
      // codex iter-9 P2 — malformed URL-prefix rules used to be preserved as
      // a no-op url_prefix rule that matched nothing. Now they fall through
      // to the unknown_rule fail-closed branch (effect:'deny') via
      // decodeRule's null handling.
      try {
        const prefix = normalizeUrl(rule.prefix).canonical;
        return { id, kind: 'url_prefix', effect: rule.effect, prefix };
      } catch {
        return null;
      }
    }
    case 'ip': {
      try {
        const canonical = normalizeIp(rule.ip).canonical;
        return { id, kind: 'ip', effect: rule.effect, ip: canonical };
      } catch {
        // codex iter-8 P2 — malformed IP → fall through to unknown_rule fail-closed.
        return null;
      }
    }
    case 'cidr': {
      const canonical = canonicalizeCidrStrict(rule.cidr);
      if (canonical === null) return null; // codex iter-8 P2 — malformed CIDR
      return { id, kind: 'cidr', effect: rule.effect, cidr: canonical };
    }
    case 'port':
      return { id, kind: 'port', effect: rule.effect, port: rule.port };
    case 'protocol':
      return { id, kind: 'protocol', effect: rule.effect, protocol: rule.protocol };
    case 'cloud_account':
      return {
        id,
        kind: 'cloud_account',
        effect: rule.effect,
        provider: rule.provider,
        accountId: rule.accountId,
      };
    case 'kubernetes_namespace':
      return {
        id,
        kind: 'kubernetes_namespace',
        effect: rule.effect,
        cluster: rule.cluster,
        namespace: rule.namespace,
      };
    case 'repository':
      return {
        id,
        kind: 'repository',
        effect: rule.effect,
        vcs: rule.vcs,
        owner: rule.owner,
        name: rule.name,
      };
    case 'time_window': {
      // codex iter-10 P2 — inverted (start >= end) or unparseable datetime
      // ranges used to materialize as a normal rule whose `inWindow()` is
      // always false → deny never fires. Overlapping allow could permit
      // traffic the deny was meant to block. Now: invalid range returns
      // null → routes to unknown_rule fail-closed (effect:'deny').
      const startMs = Date.parse(rule.start);
      const endMs = Date.parse(rule.end);
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
        return null;
      }
      return { id, kind: 'time_window', effect: rule.effect, start: rule.start, end: rule.end };
    }
    case 'rate_limit':
      return {
        id,
        kind: 'rate_limit',
        effect: rule.effect,
        bucket: rule.bucket,
        perSecond: rule.perSecond,
        burst: rule.burst,
      };
    case 'tool_category':
      return { id, kind: 'tool_category', effect: rule.effect, category: rule.category };
    case 'tool_name':
      return { id, kind: 'tool_name', effect: rule.effect, toolName: rule.toolName };
    case 'http_method':
      return { id, kind: 'http_method', effect: rule.effect, method: rule.method };
    case 'path_pattern':
      return { id, kind: 'path_pattern', effect: rule.effect, glob: rule.glob };
  }
};

/**
 * codex iter-8 P2 — strict CIDR validation. Returns null if the input is not
 * a parseable CIDR (missing slash, malformed IP, non-numeric prefix, prefix
 * out of range). decodeRule routes null to the unknown_rule fail-closed
 * fallback so malformed deny rules still surface in matchedDenyRuleIds.
 */
const canonicalizeCidrStrict = (cidr: string): string | null => {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx < 0) return null;
  const ipPart = cidr.slice(0, slashIdx);
  const prefixStr = cidr.slice(slashIdx + 1);
  const prefix = Number.parseInt(prefixStr, 10);
  if (Number.isNaN(prefix) || !/^\d+$/.test(prefixStr)) return null;
  if (prefix < 0 || prefix > 128) return null;
  try {
    const ip = normalizeIp(ipPart);
    // IPv4 prefixes 0-32, IPv6 prefixes 0-128.
    if (ip.family === 'ipv4' && prefix > 32) return null;
    return `${ip.canonical}/${prefix}`;
  } catch {
    return null;
  }
};

// ============================================================================
// Build inputs
// ============================================================================

export interface BuildEffectiveScopeInputs {
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly tenantPolicy: TenantPolicy;
  readonly platformPolicy?: PlatformPolicy;
  readonly rawRules: ReadonlyArray<{
    id: string;
    ruleKind: string;
    effect: 'allow' | 'deny';
    payload: Record<string, unknown>;
  }>;
  readonly toolCatalog: ReadonlyMap<string, ToolPolicy>;
  readonly assessmentFlags: AssessmentFlags;
  readonly timeWindow: TimeWindow | null;
}

export const DEFAULT_PLATFORM_POLICY: PlatformPolicy = Object.freeze({
  allowMetadataIpExplicit: false,
  allowPrivateIpExplicit: false,
});

export const buildEffectiveScope = (input: BuildEffectiveScopeInputs): EffectiveScope => {
  const allowRules: NormalizedRule[] = [];
  const denyRules: NormalizedRule[] = [];
  for (const row of input.rawRules) {
    const decoded = decodeRule(row.id, row);
    if (decoded.effect === 'allow') allowRules.push(decoded);
    else denyRules.push(decoded);
  }
  const scope: EffectiveScope = {
    tenantId: input.tenantId,
    assessmentId: input.assessmentId,
    allowRules: Object.freeze([...allowRules]) as readonly NormalizedRule[],
    denyRules: Object.freeze([...denyRules]) as readonly NormalizedRule[],
    toolCatalog: input.toolCatalog,
    assessmentFlags: input.assessmentFlags,
    timeWindow: input.timeWindow,
    platformPolicy: input.platformPolicy ?? DEFAULT_PLATFORM_POLICY,
    tenantPolicy: input.tenantPolicy,
  };
  return Object.freeze(scope);
};

// Helper: legacy-typed shim for callers that pass strict-typed LegacyScopeRule
// already (kept for IT readability).
export const legacyToRaw = (
  rules: ReadonlyArray<LegacyScopeRule & { id: string }>,
): BuildEffectiveScopeInputs['rawRules'] =>
  rules.map((r) => ({ id: r.id, ruleKind: r.ruleKind, effect: r.effect, payload: r.payload }));

// Re-export type for IT.
export type { LegacyLike };
