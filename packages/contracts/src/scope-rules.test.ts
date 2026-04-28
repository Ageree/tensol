import { describe, expect, test } from 'bun:test';
import { SCOPE_EFFECTS, scopeRuleSchema } from './scope-rules.ts';

describe('contracts :: scope-rules DTO', () => {
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
