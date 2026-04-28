import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  PASSWORD_RESET_TOKEN_BYTES,
  PASSWORD_RESET_TOKEN_HEX_LENGTH,
  PASSWORD_RESET_TTL_MS,
  generateResetToken,
  hashResetToken,
} from './password-reset.ts';

describe('packages/authz :: password-reset token shape (C16)', () => {
  test('token plaintext is 64-char hex (32 random bytes)', () => {
    const t = generateResetToken();
    expect(t.plaintext).toMatch(/^[0-9a-f]{64}$/);
    expect(t.plaintext.length).toBe(PASSWORD_RESET_TOKEN_HEX_LENGTH);
    expect(PASSWORD_RESET_TOKEN_BYTES).toBe(32);
  });

  test('token_hash is sha256(plaintext) hex', () => {
    const t = generateResetToken();
    const expected = createHash('sha256').update(t.plaintext).digest('hex');
    expect(t.tokenHash).toBe(expected);
    expect(t.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('expiresAtMs is exactly 15 minutes from generation', () => {
    const now = 1700_000_000_000;
    const t = generateResetToken(now);
    expect(t.expiresAtMs).toBe(now + 15 * 60 * 1000);
    expect(PASSWORD_RESET_TTL_MS).toBe(15 * 60 * 1000);
  });

  test('two consecutive tokens differ', () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  test('hashResetToken is stable for the same input', () => {
    const t = 'aaaa';
    expect(hashResetToken(t)).toBe(hashResetToken(t));
  });

  test('hashResetToken differs for different inputs', () => {
    expect(hashResetToken('a')).not.toBe(hashResetToken('b'));
  });
});
