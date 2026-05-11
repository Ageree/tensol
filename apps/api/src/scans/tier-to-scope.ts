import { HIGH_IMPACT_CATEGORIES } from '@cyberstrike/contracts';
import type { StrictScopeRule, ToolCategory } from '@cyberstrike/contracts';

export type ScanTier = 'light' | 'medium' | 'aggressive';

const LIGHT_CATEGORIES: ToolCategory[] = ['recon', 'web'];
const MEDIUM_CATEGORIES: ToolCategory[] = ['recon', 'web', 'cloud'];
const AGGRESSIVE_CATEGORIES: ToolCategory[] = [
  'recon',
  'web',
  'cloud',
  'ad',
  'c2',
  'post_exploit',
  'credential_audit',
];

// HIGH_IMPACT_CATEGORIES imported from @cyberstrike/contracts — B-26-himportcleanup.
const HIGH_IMPACT_MAP: Record<ScanTier, readonly string[]> = {
  light: [],
  medium: [],
  aggressive: HIGH_IMPACT_CATEGORIES,
};

const categoryMap: Record<ScanTier, ToolCategory[]> = {
  light: LIGHT_CATEGORIES,
  medium: MEDIUM_CATEGORIES,
  aggressive: AGGRESSIVE_CATEGORIES,
};

export function tierToHighImpactCategories(tier: ScanTier): readonly string[] {
  return HIGH_IMPACT_MAP[tier];
}

export function tierToScopeRules(tier: ScanTier, targetDomains: string[]): StrictScopeRule[] {
  const categories = categoryMap[tier];

  const toolRules: StrictScopeRule[] = categories.map((category) => ({
    ruleKind: 'tool_category' as const,
    effect: 'allow' as const,
    category,
  }));

  // 2026-05-12 — bug fix from second-smoke: when target.value is a URL like
  // `http://192.168.100.10:3030/`, naively passing it as `domain` rule pattern
  // makes the engine normalise it as `http` (the URL scheme parsed as host).
  // Extract host part properly: URL → host; bare domain stays as-is; IP literal
  // hosts emit only the `ip` rule below (no domain rule).
  const isIpLiteral = (h: string): boolean =>
    /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':');
  const domainHostsForRules = new Set<string>();
  for (const v of targetDomains) {
    let host: string | null = null;
    try {
      const u = new URL(v);
      host = u.hostname.replace(/^\[|\]$/g, '');
    } catch {
      host = v; // bare domain
    }
    if (host && !isIpLiteral(host)) {
      domainHostsForRules.add(host);
    }
  }
  const domainRules: StrictScopeRule[] = [...domainHostsForRules].map((domain) => ({
    ruleKind: 'domain' as const,
    effect: 'allow' as const,
    pattern: domain,
    matchSubdomains: true,
  }));

  // EE-3 (2026-05-12) — minimum protocol/port/method allow set so the
  // coordinator's targetToActionInput (http_request method=GET) passes the
  // scope-engine gate. Without these the engine returns no_matching_allow_rule
  // for any HTTP probe even when the domain is allow-listed. Matches the
  // shape used by tests/integration/decepticon/helpers.ts:allowExampleComScopeRules.
  const protocolRules: StrictScopeRule[] = [
    { ruleKind: 'protocol' as const, effect: 'allow' as const, protocol: 'https' },
    { ruleKind: 'protocol' as const, effect: 'allow' as const, protocol: 'http' },
  ];
  // 2026-05-12 second-smoke: derive ports from URL targets (kind='url' with
  // explicit port like http://host:3030/). Domain-only targets fall back to
  // standard 80/443.
  const portSet = new Set<number>([80, 443]);
  for (const v of targetDomains) {
    try {
      const u = new URL(v);
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      if (Number.isFinite(port) && port > 0 && port < 65536) portSet.add(port);
    } catch {
      // not a URL — domain-only string, skip
    }
  }
  const portRules: StrictScopeRule[] = [...portSet].map((port) => ({
    ruleKind: 'port' as const,
    effect: 'allow' as const,
    port,
  }));
  // 2026-05-12 — also derive literal IPs from URL targets. scope-engine
  // fail-closes on RFC1918/loopback/link-local unless either platformPolicy.
  // allowPrivateIpExplicit OR an explicit `ip` allow rule covers the IP. We
  // emit per-IP allow rules so private targets like LAN-hosted juice-shop
  // (http://192.168.100.10:3030/) work without flipping the platform policy.
  // Only literal IP hosts are covered here; domain → IP resolution happens
  // at scope-engine layer and uses platformPolicy + per-IP rules from there.
  const literalIps = new Set<string>();
  for (const v of targetDomains) {
    try {
      const u = new URL(v);
      const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
        literalIps.add(host);
      }
    } catch {
      // not a URL
    }
  }
  const ipRules: StrictScopeRule[] = [...literalIps].map((ip) => ({
    ruleKind: 'ip' as const,
    effect: 'allow' as const,
    ip,
  }));
  const methodRules: StrictScopeRule[] = (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const).map(
    (method) => ({
      ruleKind: 'http_method' as const,
      effect: 'allow' as const,
      method,
    }),
  );

  return [
    ...toolRules,
    ...domainRules,
    ...protocolRules,
    ...portRules,
    ...methodRules,
    ...ipRules,
  ];
}
