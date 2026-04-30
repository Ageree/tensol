import { describe, expect, test } from 'bun:test';
import { decryptCredential, encryptCredential, parseKek } from './crypto.ts';
import { ConfigError, DecryptionError } from './errors.ts';

const TEST_KEK_HEX = 'a'.repeat(64);
const TEST_KEK = Buffer.from(TEST_KEK_HEX, 'hex');

describe('crypto :: parseKek', () => {
  test('accepts valid 64-char hex', () => {
    const kek = parseKek(TEST_KEK_HEX);
    expect(kek.length).toBe(32);
  });

  test('throws ConfigError when undefined', () => {
    expect(() => parseKek(undefined)).toThrow(ConfigError);
  });

  test('throws ConfigError for 63-char hex', () => {
    expect(() => parseKek('a'.repeat(63))).toThrow(ConfigError);
  });

  test('throws ConfigError for 65-char hex', () => {
    expect(() => parseKek('a'.repeat(65))).toThrow(ConfigError);
  });

  test('throws ConfigError for non-hex characters', () => {
    expect(() => parseKek('z'.repeat(64))).toThrow(ConfigError);
  });
});

describe('crypto :: encryptCredential + decryptCredential', () => {
  test('round-trip returns original plaintext', () => {
    const plaintext = JSON.stringify({ username: 'user', password: 'pass' });
    const blob = encryptCredential(plaintext, TEST_KEK);
    const result = decryptCredential(blob, TEST_KEK);
    expect(result).toBe(plaintext);
  });

  test('produces different IV on every call', () => {
    const plaintext = 'test';
    const blob1 = encryptCredential(plaintext, TEST_KEK);
    const blob2 = encryptCredential(plaintext, TEST_KEK);
    expect(blob1.iv.equals(blob2.iv)).toBe(false);
  });

  test('IV is 12 bytes (96 bits)', () => {
    const blob = encryptCredential('test', TEST_KEK);
    expect(blob.iv.length).toBe(12);
  });

  test('authTag is 16 bytes', () => {
    const blob = encryptCredential('test', TEST_KEK);
    expect(blob.authTag.length).toBe(16);
  });

  test('throws DecryptionError when authTag is tampered', () => {
    const blob = encryptCredential('secret', TEST_KEK);
    const tamperedTag = Buffer.from(blob.authTag);
    tamperedTag[0] ^= 0xff;
    expect(() => decryptCredential({ ...blob, authTag: tamperedTag }, TEST_KEK)).toThrow(
      DecryptionError,
    );
  });

  test('throws DecryptionError when ciphertext is tampered', () => {
    const blob = encryptCredential('secret', TEST_KEK);
    const tampered = Buffer.from(blob.ciphertext);
    tampered[0] ^= 0xff;
    expect(() => decryptCredential({ ...blob, ciphertext: tampered }, TEST_KEK)).toThrow(
      DecryptionError,
    );
  });

  test('throws DecryptionError with wrong key', () => {
    const blob = encryptCredential('secret', TEST_KEK);
    const wrongKek = Buffer.from('b'.repeat(64), 'hex');
    expect(() => decryptCredential(blob, wrongKek)).toThrow(DecryptionError);
  });
});
