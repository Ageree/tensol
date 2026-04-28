import { describe, expect, test } from 'bun:test';
import {
  HIGH_IMPACT_CATEGORIES,
  assessmentCreateSchema,
  assessmentPatchSchema,
} from './assessments.ts';

const validUuid = '00000000-0000-4000-8000-000000000001';

const validBody = {
  name: 'A1',
  testingWindow: null,
  highImpactCategories: [] as ReadonlyArray<string>,
  targetIds: [validUuid],
  scopeRules: [{ ruleKind: 'host_in_scope', effect: 'allow', payload: {} }],
};

describe('contracts :: assessments DTOs', () => {
  test('HIGH_IMPACT_CATEGORIES = c2|post_exploit|ad|credential_audit', () => {
    expect([...HIGH_IMPACT_CATEGORIES]).toEqual(['c2', 'post_exploit', 'ad', 'credential_audit']);
  });

  test('create accepts a minimal valid body', () => {
    expect(assessmentCreateSchema.safeParse(validBody).success).toBe(true);
  });

  test('create rejects empty targetIds (min 1)', () => {
    expect(assessmentCreateSchema.safeParse({ ...validBody, targetIds: [] }).success).toBe(false);
  });

  test('create rejects empty scopeRules (min 1)', () => {
    expect(assessmentCreateSchema.safeParse({ ...validBody, scopeRules: [] }).success).toBe(false);
  });

  test('DoS cap: targetIds.length > 1000 rejected', () => {
    const big = Array.from({ length: 1001 }, () => validUuid);
    expect(assessmentCreateSchema.safeParse({ ...validBody, targetIds: big }).success).toBe(false);
  });

  test('DoS cap: scopeRules.length > 1000 rejected', () => {
    const big = Array.from({ length: 1001 }, () => ({
      ruleKind: 'k',
      effect: 'allow' as const,
      payload: {},
    }));
    expect(assessmentCreateSchema.safeParse({ ...validBody, scopeRules: big }).success).toBe(false);
  });

  test('testingWindow accepts null OR { start, end }', () => {
    expect(assessmentCreateSchema.safeParse(validBody).success).toBe(true);
    expect(
      assessmentCreateSchema.safeParse({
        ...validBody,
        testingWindow: { start: '2026-04-27T00:00:00Z', end: '2026-05-04T00:00:00Z' },
      }).success,
    ).toBe(true);
  });

  test('highImpactCategories rejects unknown values', () => {
    expect(
      assessmentCreateSchema.safeParse({ ...validBody, highImpactCategories: ['rogue'] }).success,
    ).toBe(false);
  });

  test('patch is fully optional', () => {
    expect(assessmentPatchSchema.safeParse({}).success).toBe(true);
  });

  test('patch rejects unknown keys (.strict)', () => {
    expect(assessmentPatchSchema.safeParse({ surprise: 1 }).success).toBe(false);
  });
});
