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

// HIGH_IMPACT_CATEGORIES from decide.ts:38-43 — aggressive only; others get empty list.
const HIGH_IMPACT_MAP: Record<ScanTier, string[]> = {
  light: [],
  medium: [],
  aggressive: ['c2', 'post_exploit', 'ad', 'credential_audit'],
};

const categoryMap: Record<ScanTier, ToolCategory[]> = {
  light: LIGHT_CATEGORIES,
  medium: MEDIUM_CATEGORIES,
  aggressive: AGGRESSIVE_CATEGORIES,
};

export function tierToHighImpactCategories(tier: ScanTier): string[] {
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

  return [...toolRules, ...domainRules];
}
