import { describe, expect, test } from 'bun:test';
import type { Database } from '@cyberstrike/db';
import type { Kysely } from 'kysely';
import { AuditCardinalityError, assertExactlyOneAuditRow } from './testing.ts';

const buildFakeDb = (count: number): Kysely<Database> => {
  const result = { count: String(count) };
  // The real chain has a fluid where(...).where(...).where(...) structure;
  // we make the stub idempotent so any number of where calls converges.
  const terminal = {
    executeTakeFirstOrThrow: async () => result,
  };
  // biome-ignore lint/suspicious/noExplicitAny: nested fluent stub
  const chain: any = {
    where: () => chain,
    ...terminal,
  };
  // biome-ignore lint/suspicious/noExplicitAny: nested fluent stub
  const fake: any = {
    selectFrom: () => ({
      select: () => chain,
    }),
  };
  return fake as Kysely<Database>;
};

describe('packages/audit :: assertExactlyOneAuditRow (A18)', () => {
  test('count=1 → resolves silently', async () => {
    const db = buildFakeDb(1);
    await expect(
      assertExactlyOneAuditRow(db, { action: 'auth.register' }),
    ).resolves.toBeUndefined();
  });

  test('count=0 → throws AuditCardinalityError naming observed and predicate', async () => {
    const db = buildFakeDb(0);
    try {
      await assertExactlyOneAuditRow(db, { action: 'auth.register' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditCardinalityError);
      const e = err as AuditCardinalityError;
      expect(e.observed).toBe(0);
      expect(e.expected).toBe(1);
      expect(e.predicate.action).toBe('auth.register');
    }
  });

  test('count=2 → throws AuditCardinalityError', async () => {
    const db = buildFakeDb(2);
    try {
      await assertExactlyOneAuditRow(db, { action: 'auth.register' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditCardinalityError);
      expect((err as AuditCardinalityError).observed).toBe(2);
    }
  });
});
