// Sprint 7 — per-kind payload schemas (A-Q-Env-1 inline note).

import { describe, expect, test } from 'bun:test';
import { assessmentStartPayloadSchema, reconPlaceholderPayloadSchema } from './payloads.ts';

describe('assessmentStartPayloadSchema', () => {
  const valid = {
    assessmentId: '11111111-1111-1111-1111-111111111111',
    targetIds: ['22222222-2222-2222-2222-222222222222'],
  };
  test('accepts valid payload', () => {
    expect(assessmentStartPayloadSchema.safeParse(valid).success).toBe(true);
  });
  test('rejects empty targetIds', () => {
    expect(assessmentStartPayloadSchema.safeParse({ ...valid, targetIds: [] }).success).toBe(false);
  });
  test('rejects malformed UUIDs', () => {
    expect(
      assessmentStartPayloadSchema.safeParse({ ...valid, assessmentId: 'not-a-uuid' }).success,
    ).toBe(false);
    expect(assessmentStartPayloadSchema.safeParse({ ...valid, targetIds: ['x'] }).success).toBe(
      false,
    );
  });
  test('rejects null and missing fields', () => {
    expect(assessmentStartPayloadSchema.safeParse(null).success).toBe(false);
    expect(assessmentStartPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('reconPlaceholderPayloadSchema', () => {
  const valid = {
    targetId: '11111111-1111-1111-1111-111111111111',
    targetUrl: 'https://example.com',
    parentJobId: '22222222-2222-2222-2222-222222222222',
  };
  test('accepts valid payload', () => {
    expect(reconPlaceholderPayloadSchema.safeParse(valid).success).toBe(true);
  });
  test('rejects empty targetUrl', () => {
    expect(reconPlaceholderPayloadSchema.safeParse({ ...valid, targetUrl: '' }).success).toBe(
      false,
    );
  });
  test('rejects missing parentJobId', () => {
    const partial = { targetId: valid.targetId, targetUrl: valid.targetUrl };
    expect(reconPlaceholderPayloadSchema.safeParse(partial).success).toBe(false);
  });
});
