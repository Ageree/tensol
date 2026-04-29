// Sprint 6 — Per-rule-kind matchers. Each `matchX(rule, target)` returns true
// iff the rule applies to the action's normalized target.
//
// The matchers are pure (no I/O, no time). Time-window evaluation is handled
// in `decide.ts` which has the injected Clock; rate-limit similarly delegates
// to the injected counter.

import type { HttpMethod, Protocol, ToolCategory } from '@cyberstrike/contracts';
import type { NormalizedIp, NormalizedRule, ResolvedTarget } from '../types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hostMatchesPattern = (
  host: string | undefined,
  pattern: string,
  matchSubdomains: boolean,
): boolean => {
  if (!host) return false;
  if (host === pattern) return true;
  if (matchSubdomains) {
    return host.endsWith(`.${pattern}`);
  }
  return false;
};

const isSubdomainOf = (host: string | undefined, parent: string): boolean => {
  if (!host) return false;
  return host === parent || host.endsWith(`.${parent}`);
};

const ipv4ToInt = (canonical: string): number | null => {
  const parts = canonical.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  // Use unsigned right shift to coerce to uint32.
  return (
    (((parts[0] ?? 0) << 24) >>> 0) |
    ((parts[1] ?? 0) << 16) |
    ((parts[2] ?? 0) << 8) |
    (parts[3] ?? 0)
  );
};

const ipv4InCidr = (ip: string, cidr: string): boolean => {
  const slash = cidr.indexOf('/');
  if (slash < 0) return false;
  const networkPart = cidr.slice(0, slash);
  const prefixLen = Number.parseInt(cidr.slice(slash + 1), 10);
  if (Number.isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(networkPart);
  if (ipInt === null || netInt === null) return false;
  if (prefixLen === 0) return true;
  const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
};

const ipv6Groups = (canonical: string): number[] | null => {
  // Re-expand canonical (may contain `::`).
  let s = canonical;
  if (s.includes('::')) {
    const [left, right] = s.split('::');
    const lParts = (left ?? '') === '' ? [] : (left ?? '').split(':');
    const rParts = (right ?? '') === '' ? [] : (right ?? '').split(':');
    const zeros = new Array(8 - lParts.length - rParts.length).fill('0');
    s = [...lParts, ...zeros, ...rParts].join(':');
  }
  const parts = s.split(':');
  if (parts.length !== 8) return null;
  return parts.map((p) => Number.parseInt(p, 16));
};

const ipv6InCidr = (ip: string, cidr: string): boolean => {
  const slash = cidr.indexOf('/');
  if (slash < 0) return false;
  const networkPart = cidr.slice(0, slash);
  const prefixLen = Number.parseInt(cidr.slice(slash + 1), 10);
  if (Number.isNaN(prefixLen) || prefixLen < 0 || prefixLen > 128) return false;
  const ipG = ipv6Groups(ip);
  const netG = ipv6Groups(networkPart);
  if (!ipG || !netG) return false;
  let bitsLeft = prefixLen;
  for (let i = 0; i < 8; i += 1) {
    if (bitsLeft <= 0) return true;
    const groupBits = Math.min(16, bitsLeft);
    const mask = groupBits === 16 ? 0xffff : (0xffff << (16 - groupBits)) & 0xffff;
    if (((ipG[i] ?? 0) & mask) !== ((netG[i] ?? 0) & mask)) return false;
    bitsLeft -= groupBits;
  }
  return true;
};

const ipInCidr = (ip: NormalizedIp, cidr: string): boolean => {
  if (ip.family === 'ipv4') return ipv4InCidr(ip.canonical, cidr);
  return ipv6InCidr(ip.canonical, cidr);
};

const cidrFamily = (cidr: string): 'ipv4' | 'ipv6' | null => {
  const slash = cidr.indexOf('/');
  if (slash < 0) return null;
  const networkPart = cidr.slice(0, slash);
  if (networkPart.includes(':')) return 'ipv6';
  if (/^[0-9.]+$/.test(networkPart)) return 'ipv4';
  return null;
};

const globToRegex = (glob: string): RegExp => {
  // Translate `*` (single segment) and `**` (multi-segment) to regex.
  let pattern = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      pattern += '.*';
      i += 2;
    } else if (ch === '*') {
      pattern += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      pattern += '.';
      i += 1;
    } else if (ch !== undefined && '.+^$(){}|[]\\'.includes(ch)) {
      pattern += `\\${ch}`;
      i += 1;
    } else {
      pattern += ch ?? '';
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
};

// ---------------------------------------------------------------------------
// Per-kind matchers
// ---------------------------------------------------------------------------

export const matchRule = (rule: NormalizedRule, target: ResolvedTarget): boolean => {
  switch (rule.kind) {
    case 'domain':
      return hostMatchesPattern(target.host, rule.pattern, rule.matchSubdomains);
    case 'subdomain':
      return isSubdomainOf(target.host, rule.parent);
    case 'url_prefix':
      return target.url?.startsWith(rule.prefix) ?? false;
    case 'ip': {
      const ips = target.resolvedIps ?? [];
      return ips.some((i) => i.canonical === rule.ip);
    }
    case 'cidr': {
      const ips = target.resolvedIps ?? [];
      const fam = cidrFamily(rule.cidr);
      return ips.some((ip) => ip.family === fam && ipInCidr(ip, rule.cidr));
    }
    case 'port':
      // codex iter-4 P1 — consult effectivePort first so default-port elision
      // (https://x/ → port=undefined, effectivePort=443) doesn't bypass rules.
      return (
        (target.effectivePort !== undefined && target.effectivePort === rule.port) ||
        target.port === rule.port
      );
    case 'protocol':
      return target.protocol === (rule.protocol as Protocol);
    case 'cloud_account':
      return target.cloudProvider === rule.provider && target.cloudAccountId === rule.accountId;
    case 'kubernetes_namespace':
      return target.k8sCluster === rule.cluster && target.k8sNamespace === rule.namespace;
    case 'repository':
      return (
        target.vcs === rule.vcs && target.repoOwner === rule.owner && target.repoName === rule.name
      );
    case 'tool_category':
      return target.toolCategory === (rule.category as ToolCategory);
    case 'tool_name':
      return target.toolName === rule.toolName;
    case 'http_method':
      return target.method === (rule.method as HttpMethod);
    case 'path_pattern':
      return target.path !== undefined && globToRegex(rule.glob).test(target.path);
    case 'time_window':
    case 'rate_limit':
      // Evaluated by decide(); matchers report false here so they don't
      // contribute to allow/deny set membership in the dimension-coverage check.
      return false;
    case 'unknown_rule':
      // A-SE-Pri-3: unknown rule is an *applicable* deny (always matches).
      return rule.effect === 'deny';
  }
};

export const matchAnyAllRules = (
  rules: readonly NormalizedRule[],
  target: ResolvedTarget,
): readonly string[] => rules.filter((r) => matchRule(r, target)).map((r) => r.id);

// Re-exports for tests.
export { hostMatchesPattern, isSubdomainOf, ipInCidr, globToRegex };
