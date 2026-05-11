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

  const domainRules: StrictScopeRule[] = targetDomains.map((domain) => ({
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
  const portRules: StrictScopeRule[] = [
    { ruleKind: 'port' as const, effect: 'allow' as const, port: 443 },
    { ruleKind: 'port' as const, effect: 'allow' as const, port: 80 },
  ];
  const methodRules: StrictScopeRule[] = (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const).map(
    (method) => ({
      ruleKind: 'http_method' as const,
      effect: 'allow' as const,
      method,
    }),
  );

  return [...toolRules, ...domainRules, ...protocolRules, ...portRules, ...methodRules];
}
