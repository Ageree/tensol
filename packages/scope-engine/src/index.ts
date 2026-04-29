// Sprint 6 — public surface for @cyberstrike/scope-engine.
//
// Pure package. Zero I/O. DNS, Clock, RateLimitCounter all injected via
// interfaces declared in `types.ts`.

export const name = 'packages/scope-engine' as const;

// Re-export contracts types frequently consumed by the engine's API surface.
export type {
  CloudProvider,
  HttpMethod,
  Protocol,
  ScopeActionKind,
  ToolCategory,
  VcsProvider,
} from '@cyberstrike/contracts';

export {
  ENGINE_RULE_KINDS,
  RULE_KINDS,
  type AssessmentFlags,
  type Clock,
  type Decision,
  type DnsResolver,
  type Effect,
  type EffectiveScope,
  type EngineDeps,
  type EngineRuleKind,
  type IpClassification,
  type NormalizationError,
  type NormalizedAction,
  type NormalizedIp,
  type NormalizedRule,
  type PlatformPolicy,
  type RateLimitConsumeResult,
  type RateLimitCounter,
  type ResolvedTarget,
  type RuleBase,
  type RuleKind,
  type TenantPolicy,
  type TimeWindow,
  type TimeWindowResult,
  type ToolPolicy,
  type ToolPolicyResult,
} from './types.ts';

export {
  ActionNormalizationError,
  normalizeAction,
  normalizeHost,
  normalizeIp,
  normalizeUrl,
} from './normalize/index.ts';

export { HostNormalizationError } from './normalize/host.ts';
export { IpNormalizationError } from './normalize/ip.ts';
export { UrlNormalizationError } from './normalize/url.ts';

export { matchRule } from './rules/matchers.ts';

export {
  DEFAULT_PLATFORM_POLICY,
  buildEffectiveScope,
  legacyToRaw,
  type BuildEffectiveScopeInputs,
} from './effective-scope.ts';

export { decide } from './decide.ts';
