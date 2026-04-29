// R1 — Per-kind matcher matrix. Each of the 16 RULE_KINDS gets ≥1 positive
// and ≥1 negative matcher case, generated from a single fixture table so
// drift in the union or matcher dispatch fails CI.

import { describe, expect, test } from 'bun:test';
import { type NormalizedRule, RULE_KINDS, type ResolvedTarget } from '../types.ts';
import { matchRule } from './matchers.ts';

interface FixtureCase {
  readonly rule: NormalizedRule;
  readonly target: ResolvedTarget;
  readonly expected: boolean;
}

interface KindFixture {
  readonly positive: FixtureCase;
  readonly negative: FixtureCase;
}

const FIXTURES: Record<(typeof RULE_KINDS)[number], KindFixture> = {
  domain: {
    positive: {
      rule: {
        id: 'd1',
        kind: 'domain',
        effect: 'allow',
        pattern: 'example.com',
        matchSubdomains: true,
      },
      target: { host: 'api.example.com' },
      expected: true,
    },
    negative: {
      rule: {
        id: 'd2',
        kind: 'domain',
        effect: 'allow',
        pattern: 'example.com',
        matchSubdomains: false,
      },
      target: { host: 'api.example.com' },
      expected: false,
    },
  },
  subdomain: {
    positive: {
      rule: { id: 's1', kind: 'subdomain', effect: 'allow', parent: 'example.com' },
      target: { host: 'api.example.com' },
      expected: true,
    },
    negative: {
      rule: { id: 's2', kind: 'subdomain', effect: 'allow', parent: 'example.com' },
      target: { host: 'unrelated.org' },
      expected: false,
    },
  },
  url_prefix: {
    positive: {
      rule: {
        id: 'u1',
        kind: 'url_prefix',
        effect: 'allow',
        prefix: 'https://example.com/api',
      },
      target: { url: 'https://example.com/api/v1/users' },
      expected: true,
    },
    negative: {
      rule: {
        id: 'u2',
        kind: 'url_prefix',
        effect: 'allow',
        prefix: 'https://example.com/api',
      },
      target: { url: 'https://example.com/admin' },
      expected: false,
    },
  },
  ip: {
    positive: {
      rule: { id: 'i1', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
      target: {
        resolvedIps: [{ family: 'ipv4', canonical: '8.8.8.8', classification: 'public' }],
      },
      expected: true,
    },
    negative: {
      rule: { id: 'i2', kind: 'ip', effect: 'allow', ip: '8.8.8.8' },
      target: {
        resolvedIps: [{ family: 'ipv4', canonical: '1.1.1.1', classification: 'public' }],
      },
      expected: false,
    },
  },
  cidr: {
    positive: {
      rule: { id: 'c1', kind: 'cidr', effect: 'allow', cidr: '10.0.0.0/8' },
      target: {
        resolvedIps: [{ family: 'ipv4', canonical: '10.1.2.3', classification: 'private' }],
      },
      expected: true,
    },
    negative: {
      rule: { id: 'c2', kind: 'cidr', effect: 'allow', cidr: '10.0.0.0/8' },
      target: {
        resolvedIps: [{ family: 'ipv4', canonical: '11.1.2.3', classification: 'public' }],
      },
      expected: false,
    },
  },
  port: {
    positive: {
      rule: { id: 'p1', kind: 'port', effect: 'allow', port: 443 },
      target: { port: 443 },
      expected: true,
    },
    negative: {
      rule: { id: 'p2', kind: 'port', effect: 'allow', port: 443 },
      target: { port: 80 },
      expected: false,
    },
  },
  protocol: {
    positive: {
      rule: { id: 'pr1', kind: 'protocol', effect: 'allow', protocol: 'https' },
      target: { protocol: 'https' },
      expected: true,
    },
    negative: {
      rule: { id: 'pr2', kind: 'protocol', effect: 'allow', protocol: 'https' },
      target: { protocol: 'http' },
      expected: false,
    },
  },
  cloud_account: {
    positive: {
      rule: {
        id: 'ca1',
        kind: 'cloud_account',
        effect: 'allow',
        provider: 'aws',
        accountId: '123',
      },
      target: { cloudProvider: 'aws', cloudAccountId: '123' },
      expected: true,
    },
    negative: {
      rule: {
        id: 'ca2',
        kind: 'cloud_account',
        effect: 'allow',
        provider: 'aws',
        accountId: '123',
      },
      target: { cloudProvider: 'aws', cloudAccountId: '999' },
      expected: false,
    },
  },
  kubernetes_namespace: {
    positive: {
      rule: {
        id: 'k1',
        kind: 'kubernetes_namespace',
        effect: 'allow',
        cluster: 'prod',
        namespace: 'app',
      },
      target: { k8sCluster: 'prod', k8sNamespace: 'app' },
      expected: true,
    },
    negative: {
      rule: {
        id: 'k2',
        kind: 'kubernetes_namespace',
        effect: 'allow',
        cluster: 'prod',
        namespace: 'app',
      },
      target: { k8sCluster: 'prod', k8sNamespace: 'kube-system' },
      expected: false,
    },
  },
  repository: {
    positive: {
      rule: {
        id: 'r1',
        kind: 'repository',
        effect: 'allow',
        vcs: 'github',
        owner: 'acme',
        name: 'service',
      },
      target: { vcs: 'github', repoOwner: 'acme', repoName: 'service' },
      expected: true,
    },
    negative: {
      rule: {
        id: 'r2',
        kind: 'repository',
        effect: 'allow',
        vcs: 'github',
        owner: 'acme',
        name: 'service',
      },
      target: { vcs: 'github', repoOwner: 'acme', repoName: 'other' },
      expected: false,
    },
  },
  time_window: {
    // Matchers return false for time_window — evaluated by decide().
    positive: {
      rule: {
        id: 't1',
        kind: 'time_window',
        effect: 'allow',
        start: '2026-04-28T00:00:00.000Z',
        end: '2026-04-29T00:00:00.000Z',
      },
      target: {},
      expected: false,
    },
    negative: {
      rule: {
        id: 't2',
        kind: 'time_window',
        effect: 'allow',
        start: '2026-04-28T00:00:00.000Z',
        end: '2026-04-29T00:00:00.000Z',
      },
      target: { host: 'x.io' },
      expected: false,
    },
  },
  rate_limit: {
    // Matchers return false for rate_limit — evaluated by decide().
    positive: {
      rule: {
        id: 'rl1',
        kind: 'rate_limit',
        effect: 'allow',
        bucket: 'b',
        perSecond: 5,
        burst: 10,
      },
      target: {},
      expected: false,
    },
    negative: {
      rule: {
        id: 'rl2',
        kind: 'rate_limit',
        effect: 'allow',
        bucket: 'b',
        perSecond: 5,
        burst: 10,
      },
      target: { host: 'x.io' },
      expected: false,
    },
  },
  tool_category: {
    positive: {
      rule: { id: 'tc1', kind: 'tool_category', effect: 'allow', category: 'recon' },
      target: { toolCategory: 'recon' },
      expected: true,
    },
    negative: {
      rule: { id: 'tc2', kind: 'tool_category', effect: 'allow', category: 'recon' },
      target: { toolCategory: 'web' },
      expected: false,
    },
  },
  tool_name: {
    positive: {
      rule: { id: 'tn1', kind: 'tool_name', effect: 'allow', toolName: 'nuclei' },
      target: { toolName: 'nuclei' },
      expected: true,
    },
    negative: {
      rule: { id: 'tn2', kind: 'tool_name', effect: 'allow', toolName: 'nuclei' },
      target: { toolName: 'metasploit' },
      expected: false,
    },
  },
  http_method: {
    positive: {
      rule: { id: 'm1', kind: 'http_method', effect: 'allow', method: 'GET' },
      target: { method: 'GET' },
      expected: true,
    },
    negative: {
      rule: { id: 'm2', kind: 'http_method', effect: 'allow', method: 'GET' },
      target: { method: 'POST' },
      expected: false,
    },
  },
  path_pattern: {
    positive: {
      rule: { id: 'pp1', kind: 'path_pattern', effect: 'allow', glob: '/api/v1/**' },
      target: { path: '/api/v1/users/42' },
      expected: true,
    },
    negative: {
      rule: { id: 'pp2', kind: 'path_pattern', effect: 'allow', glob: '/api/v1/**' },
      target: { path: '/admin' },
      expected: false,
    },
  },
};

describe('scope-engine :: rules/matchers — R1 cardinality + matrix', () => {
  test('R1 — RULE_KINDS = 16 (engine-side, excludes unknown_rule sentinel)', () => {
    expect(RULE_KINDS.length).toBe(16);
    expect(new Set(RULE_KINDS).size).toBe(16);
  });

  test('R1 — fixture table covers every kind', () => {
    for (const kind of RULE_KINDS) {
      expect(FIXTURES[kind]).toBeDefined();
      expect(FIXTURES[kind].positive).toBeDefined();
      expect(FIXTURES[kind].negative).toBeDefined();
    }
  });

  // Generated table-driven assertions — cardinality 16 × 2 = 32 (R1 floor).
  for (const kind of RULE_KINDS) {
    const f = FIXTURES[kind];
    test(`R1 — matchRule[${kind}] positive case`, () => {
      expect(matchRule(f.positive.rule, f.positive.target)).toBe(f.positive.expected);
    });
    test(`R1 — matchRule[${kind}] negative case`, () => {
      expect(matchRule(f.negative.rule, f.negative.target)).toBe(f.negative.expected);
    });
  }

  test('unknown_rule with effect=deny matches (default-deny per A-SE-Pri-3)', () => {
    expect(
      matchRule({ id: 'unk1', kind: 'unknown_rule', effect: 'deny', rawRuleKind: 'gibberish' }, {}),
    ).toBe(true);
  });

  test('unknown_rule with effect=allow does NOT match (defense-in-depth)', () => {
    expect(
      matchRule(
        { id: 'unk2', kind: 'unknown_rule', effect: 'allow', rawRuleKind: 'gibberish' },
        {},
      ),
    ).toBe(false);
  });

  test('R4 — IPv6 zone-id smuggling: action with %eth0 cannot evade ip rule on stripped canonical', () => {
    // The action's resolvedIps already has zone-stripped canonical (from
    // normalizeIp). Rule is `fe80::1`. Match fires.
    const rule: NormalizedRule = { id: 'z1', kind: 'ip', effect: 'deny', ip: 'fe80::1' };
    const target: ResolvedTarget = {
      resolvedIps: [
        { family: 'ipv6', canonical: 'fe80::1', zoneId: 'eth0', classification: 'link_local' },
      ],
    };
    expect(matchRule(rule, target)).toBe(true);
  });
});

describe('scope-engine :: rules/matchers — branch coverage', () => {
  test('domain matcher: empty host returns false', () => {
    const rule: NormalizedRule = {
      id: 'd-empty',
      kind: 'domain',
      effect: 'allow',
      pattern: 'example.com',
      matchSubdomains: true,
    };
    expect(matchRule(rule, {})).toBe(false);
  });

  test('subdomain matcher: empty host returns false', () => {
    const rule: NormalizedRule = {
      id: 's-empty',
      kind: 'subdomain',
      effect: 'allow',
      parent: 'example.com',
    };
    expect(matchRule(rule, {})).toBe(false);
  });

  test('cidr /0 matches everything (IPv4)', () => {
    const rule: NormalizedRule = {
      id: 'c0',
      kind: 'cidr',
      effect: 'allow',
      cidr: '0.0.0.0/0',
    };
    expect(
      matchRule(rule, {
        resolvedIps: [{ family: 'ipv4', canonical: '8.8.8.8', classification: 'public' }],
      }),
    ).toBe(true);
  });

  test('cidr matcher: IPv6 CIDR match', () => {
    const rule: NormalizedRule = {
      id: 'c-v6',
      kind: 'cidr',
      effect: 'allow',
      cidr: 'fc00::/7',
    };
    expect(
      matchRule(rule, {
        resolvedIps: [{ family: 'ipv6', canonical: 'fc00::1', classification: 'private' }],
      }),
    ).toBe(true);
  });

  test('cidr matcher: malformed CIDR (no slash) returns false', () => {
    const rule: NormalizedRule = {
      id: 'c-bad',
      kind: 'cidr',
      effect: 'allow',
      cidr: 'not-cidr',
    };
    expect(
      matchRule(rule, {
        resolvedIps: [{ family: 'ipv4', canonical: '8.8.8.8', classification: 'public' }],
      }),
    ).toBe(false);
  });

  test('cidr matcher: invalid IPv4 prefix length returns false', () => {
    const rule: NormalizedRule = {
      id: 'c-bad2',
      kind: 'cidr',
      effect: 'allow',
      cidr: '10.0.0.0/99',
    };
    expect(
      matchRule(rule, {
        resolvedIps: [{ family: 'ipv4', canonical: '10.0.0.1', classification: 'private' }],
      }),
    ).toBe(false);
  });

  test('cidr matcher: invalid IPv6 prefix length returns false', () => {
    const rule: NormalizedRule = {
      id: 'c-bad3',
      kind: 'cidr',
      effect: 'allow',
      cidr: 'fc00::/200',
    };
    expect(
      matchRule(rule, {
        resolvedIps: [{ family: 'ipv6', canonical: 'fc00::1', classification: 'private' }],
      }),
    ).toBe(false);
  });

  test('path_pattern with single-segment * does not cross /', () => {
    const rule: NormalizedRule = {
      id: 'p-single',
      kind: 'path_pattern',
      effect: 'allow',
      glob: '/api/*/edit',
    };
    expect(matchRule(rule, { path: '/api/users/edit' })).toBe(true);
    expect(matchRule(rule, { path: '/api/users/42/edit' })).toBe(false);
  });

  test('path_pattern with ? matches single char', () => {
    const rule: NormalizedRule = {
      id: 'p-q',
      kind: 'path_pattern',
      effect: 'allow',
      glob: '/v?/users',
    };
    expect(matchRule(rule, { path: '/v1/users' })).toBe(true);
    expect(matchRule(rule, { path: '/v12/users' })).toBe(false);
  });

  test('path_pattern with regex special chars escaped', () => {
    const rule: NormalizedRule = {
      id: 'p-special',
      kind: 'path_pattern',
      effect: 'allow',
      glob: '/api/v1/items.json',
    };
    expect(matchRule(rule, { path: '/api/v1/items.json' })).toBe(true);
    expect(matchRule(rule, { path: '/api/v1/itemsXjson' })).toBe(false);
  });

  test('time_window/rate_limit kinds always return false from matcher', () => {
    const tw: NormalizedRule = {
      id: 'tw',
      kind: 'time_window',
      effect: 'allow',
      start: '2026-04-28T00:00:00.000Z',
      end: '2026-04-29T00:00:00.000Z',
    };
    const rl: NormalizedRule = {
      id: 'rl',
      kind: 'rate_limit',
      effect: 'allow',
      bucket: 'b',
      perSecond: 5,
      burst: 10,
    };
    expect(matchRule(tw, {})).toBe(false);
    expect(matchRule(rl, {})).toBe(false);
  });
});
