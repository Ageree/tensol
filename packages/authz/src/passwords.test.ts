import { describe, expect, test } from 'bun:test';
import {
  BCRYPT_DEFAULT_COST,
  BCRYPT_MIN_COST_NON_LOCAL,
  createBcryptHasher,
  defaultBcryptCostForEnv,
} from './passwords.ts';

describe('packages/authz :: passwords (C13)', () => {
  test('hash produces a bcrypt-format string ($2... prefix)', async () => {
    const hasher = createBcryptHasher({ cost: 4 });
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash.startsWith('$2')).toBe(true);
    expect(hash.length).toBeGreaterThan(20);
  });

  test('verify round-trips for the right password', async () => {
    const hasher = createBcryptHasher({ cost: 4 });
    const hash = await hasher.hash('hunter2');
    expect(await hasher.verify('hunter2', hash)).toBe(true);
  });

  test('verify rejects the wrong password', async () => {
    const hasher = createBcryptHasher({ cost: 4 });
    const hash = await hasher.hash('hunter2');
    expect(await hasher.verify('wrong', hash)).toBe(false);
  });

  test('verify against malformed hash returns false (no throw)', async () => {
    const hasher = createBcryptHasher({ cost: 4 });
    expect(await hasher.verify('any', 'not-a-bcrypt-hash')).toBe(false);
  });

  test('empty password rejected on hash', async () => {
    const hasher = createBcryptHasher({ cost: 4 });
    await expect(hasher.hash('')).rejects.toMatchObject({ name: 'AuthError' });
  });

  test('empty password returns false on verify', async () => {
    const hasher = createBcryptHasher({ cost: 4 });
    expect(await hasher.verify('', 'any')).toBe(false);
  });

  test('invalid cost rejected at construction', () => {
    expect(() => createBcryptHasher({ cost: 1 })).toThrow();
    expect(() => createBcryptHasher({ cost: 17 })).toThrow();
    expect(() => createBcryptHasher({ cost: 4.5 })).toThrow();
  });

  test('dummyVerify completes without throwing', async () => {
    const hasher = createBcryptHasher({ cost: 4 });
    await hasher.dummyVerify('anything');
  });

  test('BCRYPT_DEFAULT_COST is 12 (production)', () => {
    expect(BCRYPT_DEFAULT_COST).toBe(12);
  });

  test('BCRYPT_MIN_COST_NON_LOCAL is 10', () => {
    expect(BCRYPT_MIN_COST_NON_LOCAL).toBe(10);
  });
});

describe('packages/authz :: defaultBcryptCostForEnv (C13b)', () => {
  test('local → 4 (fast tests)', () => {
    expect(defaultBcryptCostForEnv('local')).toBe(4);
  });
  test('production → 12', () => {
    expect(defaultBcryptCostForEnv('production')).toBe(12);
  });
  test('dev/staging/internal-lab → 10', () => {
    expect(defaultBcryptCostForEnv('dev')).toBe(10);
    expect(defaultBcryptCostForEnv('staging')).toBe(10);
    expect(defaultBcryptCostForEnv('internal-lab')).toBe(10);
  });
});
