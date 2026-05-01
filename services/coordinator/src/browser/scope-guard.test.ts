// Sprint 9 — scope-guard unit tests. Verifies the wrap honours decide()
// allow/deny behaviour on http_request actions.

import { describe, expect, test } from 'bun:test';
import {
  type Clock,
  DEFAULT_PLATFORM_POLICY,
  type DnsResolver,
  type EffectiveScope,
  type NormalizedRule,
  type RateLimitCounter,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { type ScopeGuardDeps, checkNavigation } from './scope-guard.ts';

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });
const okRateLimit = (): RateLimitCounter => ({ consume: () => ({ ok: true }) });
const recordingDns = (table: Record<string, string[]>): DnsResolver => ({
  resolveA: async (host) => table[host] ?? [],
  resolveAAAA: async () => [],
});

const baseScope = (overrides: {
  allowRules?: NormalizedRule[];
  denyRules?: NormalizedRule[];
}): EffectiveScope => {
  const built = buildEffectiveScope({
    tenantId: 't1',
    assessmentId: 'a1',
    tenantPolicy: { tenantId: 't1' },
    platformPolicy: DEFAULT_PLATFORM_POLICY,
    rawRules: [],
    toolCatalog: new Map<string, ToolPolicy>(),
    assessmentFlags: {
      highImpactCategories: [],
      ownershipVerifiedTargetIds: new Set(),
    },
    timeWindow: null,
  });
  return Object.freeze({
    ...built,
    allowRules: Object.freeze([...(overrides.allowRules ?? [])]) as readonly NormalizedRule[],
    denyRules: Object.freeze([...(overrides.denyRules ?? [])]) as readonly NormalizedRule[],
  });
};

const allowExampleScope = (): EffectiveScope =>
  baseScope({
    allowRules: [
      { id: 'a1', kind: 'domain', effect: 'allow', pattern: 'example.com', matchSubdomains: false },
      { id: 'a2', kind: 'ip', effect: 'allow', ip: '93.184.216.34' },
      { id: 'a3', kind: 'port', effect: 'allow', port: 443 },
      { id: 'a4', kind: 'protocol', effect: 'allow', protocol: 'https' },
      { id: 'a5', kind: 'http_method', effect: 'allow', method: 'GET' },
    ],
  });

const deps: ScopeGuardDeps = {
  dns: recordingDns({ 'example.com': ['93.184.216.34'] }),
  clock: fixedClock('2026-04-29T12:00:00.000Z'),
  rateLimit: okRateLimit(),
};

describe('checkNavigation (scope-guard)', () => {
  test('allow path: example.com is permitted with full coverage rules', async () => {
    const decision = await checkNavigation(allowExampleScope(), 'https://example.com/', deps);
    expect(decision.allowed).toBe(true);
  });

  test('deny path: out-of-scope evil.example denies', async () => {
    const decision = await checkNavigation(allowExampleScope(), 'https://evil.example/', {
      ...deps,
      dns: recordingDns({ 'evil.example': ['203.0.113.1'] }),
    });
    expect(decision.allowed).toBe(false);
  });

  test('explicit deny rule overrides allow', async () => {
    const scope = baseScope({
      allowRules: [
        {
          id: 'a1',
          kind: 'domain',
          effect: 'allow',
          pattern: 'example.com',
          matchSubdomains: false,
        },
        { id: 'a2', kind: 'ip', effect: 'allow', ip: '93.184.216.34' },
        { id: 'a3', kind: 'port', effect: 'allow', port: 443 },
        { id: 'a4', kind: 'protocol', effect: 'allow', protocol: 'https' },
        { id: 'a5', kind: 'http_method', effect: 'allow', method: 'GET' },
      ],
      denyRules: [
        {
          id: 'd1',
          kind: 'domain',
          effect: 'deny',
          pattern: 'example.com',
          matchSubdomains: false,
        },
      ],
    });
    const decision = await checkNavigation(scope, 'https://example.com/', deps);
    expect(decision.allowed).toBe(false);
  });
});
