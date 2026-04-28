import { describe, expect, test } from 'bun:test';
import {
  PRE_AUTH_TOKEN_BYTES,
  PRE_AUTH_TOKEN_TTL_MS,
  createPreAuthStore,
} from './pre-auth-tokens.ts';

describe('apps/api :: pre-auth-tokens (C22)', () => {
  test('issue returns a 64-char hex token + 60s TTL', () => {
    const store = createPreAuthStore();
    const issued = store.issue({ userId: 'u1', tenantId: 't1' });
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.expiresInSeconds).toBe(60);
    expect(PRE_AUTH_TOKEN_TTL_MS).toBe(60_000);
    expect(PRE_AUTH_TOKEN_BYTES).toBe(32);
  });

  test('redeem returns the principal on first call', () => {
    const store = createPreAuthStore();
    const issued = store.issue({ userId: 'u1', tenantId: 't1' });
    const redeemed = store.redeem(issued.token);
    expect(redeemed).toEqual({ userId: 'u1', tenantId: 't1' });
  });

  test('redeem rejects on the second call (single-use)', () => {
    const store = createPreAuthStore();
    const issued = store.issue({ userId: 'u1', tenantId: 't1' });
    store.redeem(issued.token);
    expect(store.redeem(issued.token)).toBeNull();
  });

  test('redeem rejects expired tokens', () => {
    const store = createPreAuthStore();
    const issued = store.issue({ userId: 'u1', tenantId: 't1', nowMs: 1000 });
    expect(store.redeem(issued.token, 1000 + PRE_AUTH_TOKEN_TTL_MS + 1)).toBeNull();
  });

  test('redeem rejects unknown tokens', () => {
    const store = createPreAuthStore();
    expect(store.redeem('00'.repeat(32))).toBeNull();
  });

  test('LRU eviction caps stored entries', () => {
    const store = createPreAuthStore(3);
    store.issue({ userId: 'u1', tenantId: 't' });
    store.issue({ userId: 'u2', tenantId: 't' });
    store.issue({ userId: 'u3', tenantId: 't' });
    store.issue({ userId: 'u4', tenantId: 't' });
    expect(store.size()).toBe(3);
  });
});
