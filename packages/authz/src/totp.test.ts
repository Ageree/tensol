import { describe, expect, test } from 'bun:test';
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  TOTP_VERIFICATION_WINDOW,
  createTotpVerifier,
  requireValidTotp,
} from './totp.ts';

describe('packages/authz :: TOTP constants (C14)', () => {
  test('SHA1 / 6 digits / 30 seconds / ±1 step', () => {
    expect(TOTP_ALGORITHM).toBe('sha1');
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_STEP_SECONDS).toBe(30);
    expect(TOTP_VERIFICATION_WINDOW).toBe(1);
  });
});

describe('packages/authz :: TOTP verify (C14)', () => {
  test('valid code at the same window passes', () => {
    const v = createTotpVerifier();
    const secret = v.generateSecret();
    const nowMs = 1700_000_000_000;
    const code = v.generateCode(secret, nowMs);
    expect(v.verify({ userId: 'u1', secret, code, nowMs })).toBe(true);
  });

  test('non-numeric or wrong-length code is rejected immediately', () => {
    const v = createTotpVerifier();
    const secret = v.generateSecret();
    expect(v.verify({ userId: 'u1', secret, code: 'abcdef', nowMs: 0 })).toBe(false);
    expect(v.verify({ userId: 'u1', secret, code: '12345', nowMs: 0 })).toBe(false);
    expect(v.verify({ userId: 'u1', secret, code: '1234567', nowMs: 0 })).toBe(false);
  });

  test('code from previous step (within ±1 window) is accepted', () => {
    const v = createTotpVerifier();
    const secret = v.generateSecret();
    const nowMs = 1700_000_000_000;
    const codeOneStepBack = v.generateCode(secret, nowMs - TOTP_STEP_SECONDS * 1000);
    expect(v.verify({ userId: 'u1', secret, code: codeOneStepBack, nowMs })).toBe(true);
  });

  test('code from two steps back (outside ±1 window) is rejected', () => {
    const v = createTotpVerifier();
    const secret = v.generateSecret();
    const nowMs = 1700_000_000_000;
    const codeTwoStepsBack = v.generateCode(secret, nowMs - TOTP_STEP_SECONDS * 2 * 1000);
    expect(v.verify({ userId: 'u1', secret, code: codeTwoStepsBack, nowMs })).toBe(false);
  });

  test('wrong secret with right code is rejected', () => {
    const v = createTotpVerifier();
    const secretA = v.generateSecret();
    const secretB = v.generateSecret();
    const nowMs = 1700_000_000_000;
    const codeForA = v.generateCode(secretA, nowMs);
    expect(v.verify({ userId: 'u1', secret: secretB, code: codeForA, nowMs })).toBe(false);
  });
});

describe('packages/authz :: TOTP anti-replay LRU (C15)', () => {
  test('same code is accepted once and rejected on the second call within the same window', () => {
    const v = createTotpVerifier();
    const secret = v.generateSecret();
    const nowMs = 1700_000_000_000;
    const code = v.generateCode(secret, nowMs);
    expect(v.verify({ userId: 'u1', secret, code, nowMs })).toBe(true);
    // Second call in the same window — must be rejected.
    expect(v.verify({ userId: 'u1', secret, code, nowMs })).toBe(false);
  });

  test('replay protection is per-user (same code, different user is independent)', () => {
    const v = createTotpVerifier();
    const secret = v.generateSecret();
    const nowMs = 1700_000_000_000;
    const code = v.generateCode(secret, nowMs);
    expect(v.verify({ userId: 'u1', secret, code, nowMs })).toBe(true);
    expect(v.verify({ userId: 'u2', secret, code, nowMs })).toBe(true);
  });

  test('code accepted in one window can be re-presented in a later window if regenerated to match', () => {
    const v = createTotpVerifier();
    const secret = v.generateSecret();
    const t0 = 1700_000_000_000;
    const code0 = v.generateCode(secret, t0);
    expect(v.verify({ userId: 'u1', secret, code: code0, nowMs: t0 })).toBe(true);

    // Move forward by 60s — new window; if the new code happens to differ
    // (it should — TOTP changes per 30s) we should be able to verify it
    // again. Even if the LRU still holds the t0 entry, the windowStart key
    // differs.
    const t1 = t0 + 60_000;
    const code1 = v.generateCode(secret, t1);
    expect(v.verify({ userId: 'u1', secret, code: code1, nowMs: t1 })).toBe(true);
  });
});

describe('packages/authz :: requireValidTotp throws on failure', () => {
  test('throws MfaError when verify returns false', () => {
    const v = createTotpVerifier();
    expect(() =>
      requireValidTotp(v, { userId: 'u1', secret: 'JBSWY3DPEHPK3PXP', code: '000000', nowMs: 0 }),
    ).toThrow();
  });

  test('does not throw when verify returns true', () => {
    const v = createTotpVerifier();
    const secret = v.generateSecret();
    const nowMs = 1700_000_000_000;
    const code = v.generateCode(secret, nowMs);
    expect(() => requireValidTotp(v, { userId: 'u1', secret, code, nowMs })).not.toThrow();
  });
});
