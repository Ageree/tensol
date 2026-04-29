// Sprint 5 — scope rule DTOs (open-payload, preserved for backward compat).
// Sprint 6 — strict discriminated union over the 16 closed-set rule kinds
//            (additive — does not replace the Sprint 5 schema).
//
// Scope rules persist to `assessment_scope_rules` (migration 004). Sprint 5
// callers (assessmentCreateSchema, assessmentPatchSchema) continue to use the
// loose `scopeRuleSchema` so existing IT remains green. Sprint 6's engine
// (@cyberstrike/scope-engine) consumes `strictScopeRuleSchema` — a
// discriminated union over 16 kinds. Persisted Sprint 5 rows whose ruleKind is
// outside the 16-closed-set decode via the loose schema → engine maps them to
// `unknown_rule` (default-deny per A-SE-Pri-3 / A-SE-Compat-1).

import { z } from 'zod';

// ============================================================================
// Effects (Sprint 5 carry-forward — unchanged)
// ============================================================================

export const SCOPE_EFFECTS = ['allow', 'deny'] as const;
export type ScopeEffect = (typeof SCOPE_EFFECTS)[number];

// ============================================================================
// Sprint 5 loose schema (preserved verbatim for backward compat)
// ============================================================================

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const scopeRuleSchema = z
  .object({
    ruleKind: z.string().min(1).max(64),
    effect: z.enum(SCOPE_EFFECTS),
    payload: z.record(jsonValueSchema),
  })
  .strict();

export type ScopeRule = z.infer<typeof scopeRuleSchema>;

// ============================================================================
// Sprint 6 — 16 closed-set ruleKinds (R1 cardinality assertion target)
// ============================================================================

export const RULE_KINDS = [
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
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

// ============================================================================
// Closed enums for rule fields (R7 — tool_category zod boundary check)
// ============================================================================

export const PROTOCOLS = ['http', 'https', 'tcp', 'udp', 'ws', 'wss'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const CLOUD_PROVIDERS = ['aws', 'gcp', 'azure', 'yandex'] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const VCS_PROVIDERS = ['github', 'gitlab', 'bitbucket'] as const;
export type VcsProvider = (typeof VCS_PROVIDERS)[number];

export const TOOL_CATEGORIES = [
  'recon',
  'web',
  'cloud',
  'ad',
  'c2',
  'post_exploit',
  'credential_audit',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// ============================================================================
// Per-kind payload schemas (strict — Sprint 6)
// ============================================================================

const baseRule = { effect: z.enum(SCOPE_EFFECTS) } as const;

const domainRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('domain'),
    pattern: z.string().min(1).max(253),
    matchSubdomains: z.boolean(),
  })
  .strict();

const subdomainRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('subdomain'),
    parent: z.string().min(1).max(253),
  })
  .strict();

const urlPrefixRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('url_prefix'),
    prefix: z.string().min(1).max(2048),
  })
  .strict();

const ipRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('ip'),
    ip: z.string().min(1).max(45),
  })
  .strict();

const cidrRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('cidr'),
    cidr: z.string().min(1).max(49),
  })
  .strict();

const portRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('port'),
    port: z.number().int().min(1).max(65535),
  })
  .strict();

const protocolRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('protocol'),
    protocol: z.enum(PROTOCOLS),
  })
  .strict();

const cloudAccountRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('cloud_account'),
    provider: z.enum(CLOUD_PROVIDERS),
    accountId: z.string().min(1).max(128),
  })
  .strict();

const kubernetesNamespaceRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('kubernetes_namespace'),
    cluster: z.string().min(1).max(253),
    namespace: z.string().min(1).max(63),
  })
  .strict();

const repositoryRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('repository'),
    vcs: z.enum(VCS_PROVIDERS),
    owner: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
  })
  .strict();

const timeWindowRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('time_window'),
    start: z.string().datetime(),
    end: z.string().datetime(),
  })
  .strict();

const rateLimitRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('rate_limit'),
    bucket: z.string().min(1).max(128),
    perSecond: z.number().positive().max(10_000),
    burst: z.number().int().min(1).max(100_000),
  })
  .strict();

const toolCategoryRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('tool_category'),
    category: z.enum(TOOL_CATEGORIES),
  })
  .strict();

const toolNameRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('tool_name'),
    toolName: z.string().min(1).max(128),
  })
  .strict();

const httpMethodRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('http_method'),
    method: z.enum(HTTP_METHODS),
  })
  .strict();

const pathPatternRule = z
  .object({
    ...baseRule,
    ruleKind: z.literal('path_pattern'),
    glob: z.string().min(1).max(2048),
  })
  .strict();

// ============================================================================
// Strict discriminated union — Sprint 6 (R1 cardinality target)
// ============================================================================

export const strictScopeRuleSchema = z.discriminatedUnion('ruleKind', [
  domainRule,
  subdomainRule,
  urlPrefixRule,
  ipRule,
  cidrRule,
  portRule,
  protocolRule,
  cloudAccountRule,
  kubernetesNamespaceRule,
  repositoryRule,
  timeWindowRule,
  rateLimitRule,
  toolCategoryRule,
  toolNameRule,
  httpMethodRule,
  pathPatternRule,
]);

export type StrictScopeRule = z.infer<typeof strictScopeRuleSchema>;

// ============================================================================
// Legacy compat schema — A-SE-Compat-1 (R6)
// ============================================================================
//
// Sprint 5 IT seeded rows with arbitrary `ruleKind` strings + record-shape
// payload. This schema is intended for read-side decoding only — write paths
// use `strictScopeRuleSchema`. The engine maps any row that doesn't fit the
// strict union to `unknown_rule` (default-deny per A-SE-Pri-3).

export const legacyScopeRulePayload = z
  .object({
    ruleKind: z.string().min(1).max(64),
    effect: z.enum(SCOPE_EFFECTS),
    payload: z.record(jsonValueSchema),
  })
  .strict();

export type LegacyScopeRule = z.infer<typeof legacyScopeRulePayload>;
