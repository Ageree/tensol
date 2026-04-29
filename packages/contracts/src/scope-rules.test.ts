import { describe, expect, test } from 'bun:test';
import {
  HTTP_METHODS,
  PROTOCOLS,
  RULE_KINDS,
  SCOPE_EFFECTS,
  TOOL_CATEGORIES,
  scopeRuleSchema,
  strictScopeRuleSchema,
} from './scope-rules.ts';

describe('contracts :: scope-rules DTO (Sprint 5 loose schema — backward compat)', () => {
  test('SCOPE_EFFECTS = [allow, deny]', () => {
    expect([...SCOPE_EFFECTS]).toEqual(['allow', 'deny']);
  });

  test('parses a well-formed rule', () => {
    expect(
      scopeRuleSchema.safeParse({
        ruleKind: 'host_in_scope',
        effect: 'allow',
        payload: { host: 'x.io' },
      }).success,
    ).toBe(true);
  });

  test('rejects unknown effect', () => {
    expect(scopeRuleSchema.safeParse({ ruleKind: 'k', effect: 'maybe', payload: {} }).success).toBe(
      false,
    );
  });

  test('rejects extra keys (.strict)', () => {
    expect(
      scopeRuleSchema.safeParse({
        ruleKind: 'k',
        effect: 'allow',
        payload: {},
        surprise: 1,
      }).success,
    ).toBe(false);
  });

  test('payload accepts arbitrary nested JSON', () => {
    expect(
      scopeRuleSchema.safeParse({
        ruleKind: 'k',
        effect: 'allow',
        payload: { a: { b: [1, 'two', null, true] } },
      }).success,
    ).toBe(true);
  });
});

describe('contracts :: strict scope-rules DTO (Sprint 6, R1 cardinality)', () => {
  test('R1 — RULE_KINDS cardinality is exactly 16', () => {
    expect(RULE_KINDS.length).toBe(16);
    expect(new Set(RULE_KINDS).size).toBe(16);
  });

  test('PROTOCOLS, TOOL_CATEGORIES, HTTP_METHODS — closed sets', () => {
    expect(PROTOCOLS).toEqual(['http', 'https', 'tcp', 'udp', 'ws', 'wss']);
    expect(TOOL_CATEGORIES).toEqual([
      'recon',
      'web',
      'cloud',
      'ad',
      'c2',
      'post_exploit',
      'credential_audit',
    ]);
    expect(HTTP_METHODS).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  });

  // Per-kind positive fixture: parses successfully.
  const positiveFixtures: Record<(typeof RULE_KINDS)[number], unknown> = {
    domain: { ruleKind: 'domain', effect: 'allow', pattern: 'example.com', matchSubdomains: true },
    subdomain: { ruleKind: 'subdomain', effect: 'deny', parent: 'internal.example.com' },
    url_prefix: { ruleKind: 'url_prefix', effect: 'allow', prefix: 'https://example.com/api' },
    ip: { ruleKind: 'ip', effect: 'deny', ip: '192.0.2.1' },
    cidr: { ruleKind: 'cidr', effect: 'allow', cidr: '10.0.0.0/8' },
    port: { ruleKind: 'port', effect: 'allow', port: 443 },
    protocol: { ruleKind: 'protocol', effect: 'deny', protocol: 'http' },
    cloud_account: {
      ruleKind: 'cloud_account',
      effect: 'allow',
      provider: 'aws',
      accountId: '123456789012',
    },
    kubernetes_namespace: {
      ruleKind: 'kubernetes_namespace',
      effect: 'allow',
      cluster: 'prod-east',
      namespace: 'payments',
    },
    repository: {
      ruleKind: 'repository',
      effect: 'allow',
      vcs: 'github',
      owner: 'acme',
      name: 'service',
    },
    time_window: {
      ruleKind: 'time_window',
      effect: 'allow',
      start: '2026-04-28T00:00:00.000Z',
      end: '2026-04-29T00:00:00.000Z',
    },
    rate_limit: {
      ruleKind: 'rate_limit',
      effect: 'allow',
      bucket: 'recon:default',
      perSecond: 5,
      burst: 20,
    },
    tool_category: { ruleKind: 'tool_category', effect: 'allow', category: 'recon' },
    tool_name: { ruleKind: 'tool_name', effect: 'allow', toolName: 'nuclei' },
    http_method: { ruleKind: 'http_method', effect: 'deny', method: 'DELETE' },
    path_pattern: { ruleKind: 'path_pattern', effect: 'allow', glob: '/api/v1/**' },
  };

  // Per-kind negative fixture: required field missing or wrong type.
  const negativeFixtures: Record<(typeof RULE_KINDS)[number], unknown> = {
    domain: { ruleKind: 'domain', effect: 'allow', pattern: 'example.com' /* matchSubdomains */ },
    subdomain: { ruleKind: 'subdomain', effect: 'allow', parent: '' /* min 1 violated */ },
    url_prefix: { ruleKind: 'url_prefix', effect: 'allow', prefix: '' },
    ip: { ruleKind: 'ip', effect: 'allow', ip: '' },
    cidr: { ruleKind: 'cidr', effect: 'allow', cidr: '' },
    port: { ruleKind: 'port', effect: 'allow', port: 0 /* min 1 */ },
    protocol: { ruleKind: 'protocol', effect: 'allow', protocol: 'gopher' /* not in PROTOCOLS */ },
    cloud_account: {
      ruleKind: 'cloud_account',
      effect: 'allow',
      provider: 'oracle',
      accountId: 'x',
    },
    kubernetes_namespace: {
      ruleKind: 'kubernetes_namespace',
      effect: 'allow',
      cluster: 'c',
      namespace: '' /* min 1 */,
    },
    repository: {
      ruleKind: 'repository',
      effect: 'allow',
      vcs: 'gitea' /* not in VCS_PROVIDERS */,
      owner: 'a',
      name: 'b',
    },
    time_window: {
      ruleKind: 'time_window',
      effect: 'allow',
      start: 'not-a-date',
      end: 'also-not',
    },
    rate_limit: {
      ruleKind: 'rate_limit',
      effect: 'allow',
      bucket: 'b',
      perSecond: -1 /* positive() */,
      burst: 1,
    },
    tool_category: {
      ruleKind: 'tool_category',
      effect: 'allow',
      category: 'social_engineering' /* R7: not in TOOL_CATEGORIES */,
    },
    tool_name: { ruleKind: 'tool_name', effect: 'allow', toolName: '' },
    http_method: {
      ruleKind: 'http_method',
      effect: 'allow',
      method: 'CONNECT' /* not in HTTP_METHODS */,
    },
    path_pattern: { ruleKind: 'path_pattern', effect: 'allow', glob: '' },
  };

  test('R1 — positive fixture exists for every RuleKind', () => {
    for (const kind of RULE_KINDS) {
      expect(positiveFixtures[kind]).toBeDefined();
    }
    expect(Object.keys(positiveFixtures).length).toBe(RULE_KINDS.length);
  });

  test('R1 — negative fixture exists for every RuleKind', () => {
    for (const kind of RULE_KINDS) {
      expect(negativeFixtures[kind]).toBeDefined();
    }
    expect(Object.keys(negativeFixtures).length).toBe(RULE_KINDS.length);
  });

  for (const kind of RULE_KINDS) {
    test(`R1 — strict schema parses well-formed ${kind}`, () => {
      const result = strictScopeRuleSchema.safeParse(positiveFixtures[kind]);
      expect(result.success).toBe(true);
    });

    test(`R1 — strict schema rejects malformed ${kind}`, () => {
      expect(strictScopeRuleSchema.safeParse(negativeFixtures[kind]).success).toBe(false);
    });
  }

  test('rejects out-of-set ruleKind (defense-in-depth)', () => {
    expect(
      strictScopeRuleSchema.safeParse({
        ruleKind: 'unknown_thing',
        effect: 'allow',
      }).success,
    ).toBe(false);
  });

  test('R7 — tool_category enum rejects out-of-set category', () => {
    expect(
      strictScopeRuleSchema.safeParse({
        ruleKind: 'tool_category',
        effect: 'allow',
        category: 'phishing',
      }).success,
    ).toBe(false);
  });
});
