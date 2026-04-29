import { describe, expect, test } from 'bun:test';
import { DECISION_REASONS, decisionSchema, scopeValidateRequestSchema } from './scope-validate.ts';

describe('contracts :: scope-validate DTOs', () => {
  test('DECISION_REASONS is a non-empty closed set', () => {
    expect(DECISION_REASONS.length).toBeGreaterThan(10);
    expect(new Set(DECISION_REASONS).size).toBe(DECISION_REASONS.length);
    expect(DECISION_REASONS).toContain('allowed');
    expect(DECISION_REASONS).toContain('metadata_ip_blocked');
    expect(DECISION_REASONS).toContain('unknown_rule_default_deny');
  });

  test('decisionSchema accepts a minimal allow', () => {
    const result = decisionSchema.safeParse({
      allowed: true,
      reason: 'allowed',
      matchedAllowRuleIds: ['r1'],
      matchedDenyRuleIds: [],
    });
    expect(result.success).toBe(true);
  });

  test('decisionSchema accepts a minimal deny', () => {
    const result = decisionSchema.safeParse({
      allowed: false,
      reason: 'denied_by_rule',
      matchedAllowRuleIds: [],
      matchedDenyRuleIds: ['d7'],
    });
    expect(result.success).toBe(true);
  });

  test('decisionSchema accepts diagnostic side fields', () => {
    expect(
      decisionSchema.safeParse({
        allowed: false,
        reason: 'metadata_ip_blocked',
        matchedAllowRuleIds: [],
        matchedDenyRuleIds: [],
        normalizedTarget: { url: 'http://169.254.169.254/' },
        toolPolicyResult: { effective: false },
        timeWindowResult: { ok: false },
      }).success,
    ).toBe(true);
  });

  test('decisionSchema rejects unknown reason', () => {
    expect(
      decisionSchema.safeParse({
        allowed: false,
        reason: 'cosmic_rays',
        matchedAllowRuleIds: [],
        matchedDenyRuleIds: [],
      }).success,
    ).toBe(false);
  });

  test('decisionSchema rejects extra keys (.strict)', () => {
    expect(
      decisionSchema.safeParse({
        allowed: true,
        reason: 'allowed',
        matchedAllowRuleIds: [],
        matchedDenyRuleIds: [],
        sneaky: 1,
      }).success,
    ).toBe(false);
  });

  test('scopeValidateRequestSchema parses a well-formed request', () => {
    expect(
      scopeValidateRequestSchema.safeParse({
        action: { kind: 'http_request', url: 'https://example.com/' },
      }).success,
    ).toBe(true);
  });

  test('scopeValidateRequestSchema rejects empty body', () => {
    expect(scopeValidateRequestSchema.safeParse({}).success).toBe(false);
  });

  test('scopeValidateRequestSchema rejects extra keys (.strict)', () => {
    expect(
      scopeValidateRequestSchema.safeParse({
        action: { kind: 'dns_lookup', host: 'x.io' },
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
