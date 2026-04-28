import { describe, expect, test } from 'bun:test';
import {
  PROJECT_STATUSES,
  projectCreateSchema,
  projectListQuerySchema,
  projectPatchSchema,
} from './projects.ts';

describe('contracts :: projects DTOs', () => {
  test('PROJECT_STATUSES is exactly [active, archived]', () => {
    expect([...PROJECT_STATUSES]).toEqual(['active', 'archived']);
  });

  test('create rejects extra keys (.strict)', () => {
    const r = projectCreateSchema.safeParse({ name: 'P', surprise: 1 });
    expect(r.success).toBe(false);
  });

  test('create requires non-empty name', () => {
    expect(projectCreateSchema.safeParse({ name: '' }).success).toBe(false);
  });

  test('patch is fully optional', () => {
    expect(projectPatchSchema.safeParse({}).success).toBe(true);
  });

  test('list query defaults limit to 50, accepts cursor base64', () => {
    const r = projectListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(50);
    expect(projectListQuerySchema.safeParse({ cursor: 'abc==' }).success).toBe(true);
  });

  test('list query rejects unknown query keys (.strict)', () => {
    expect(projectListQuerySchema.safeParse({ random: 'x' }).success).toBe(false);
  });

  test('list query rejects out-of-range limit', () => {
    expect(projectListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(projectListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
