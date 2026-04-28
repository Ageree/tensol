// Sprint 3 contract C14/C15 — TOTP via otplib with anti-replay LRU.
//
// Algorithm: SHA1 / 6 digits / 30s period / ±1 step verification window.
// Replay protection: an in-memory LRU keyed by `${userId}:${windowStart}`
// records consumed (userId, code, windowStart) triples. A second verify
// with the same code within the same step window is rejected.
//
// LIMITATION (R3 / ADR 0003 §Limitations): the LRU is per-process. In
// multi-process deployments a code accepted on process A could still be
// replayed on process B until the window rolls. Sprint 7 replaces with a
// shared store (Redis or PG row-keyed by user+windowStart).

import { HashAlgorithms } from '@otplib/core';
import { authenticator } from 'otplib';
import { MfaError } from './errors.ts';

authenticator.options = {
  algorithm: HashAlgorithms.SHA1,
  digits: 6,
  step: 30,
  window: 1,
};

export const TOTP_ALGORITHM = 'sha1' as const;
export const TOTP_DIGITS = 6 as const;
export const TOTP_STEP_SECONDS = 30 as const;
export const TOTP_VERIFICATION_WINDOW = 1 as const;

export interface TotpVerifyOptions {
  readonly userId: string;
  readonly secret: string;
  readonly code: string;
  /**
   * Test seam: override `Date.now()` for deterministic window arithmetic.
   * Production callers omit this and the verifier reads system time.
   */
  readonly nowMs?: number;
}

export interface TotpVerifier {
  verify(opts: TotpVerifyOptions): boolean;
  generateSecret(): string;
  /** Test/dev only — generate the current code for a secret. */
  generateCode(secret: string, nowMs?: number): string;
}

interface ReplayKey {
  readonly userId: string;
  readonly code: string;
  readonly windowStart: number;
}

class LruReplayCache {
  private readonly capacity: number;
  private readonly map = new Map<string, true>();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  has(key: ReplayKey): boolean {
    return this.map.has(this.toString(key));
  }

  add(key: ReplayKey): void {
    const k = this.toString(key);
    // Re-insertion to refresh LRU order.
    this.map.delete(k);
    this.map.set(k, true);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  private toString(k: ReplayKey): string {
    return `${k.userId}|${k.code}|${k.windowStart}`;
  }
}

class OtplibTotpVerifier implements TotpVerifier {
  private readonly cache: LruReplayCache;

  constructor(replayCacheCapacity = 4096) {
    this.cache = new LruReplayCache(replayCacheCapacity);
  }

  verify(opts: TotpVerifyOptions): boolean {
    if (opts.code.length !== TOTP_DIGITS || !/^\d+$/.test(opts.code)) {
      return false;
    }
    const nowMs = opts.nowMs ?? Date.now();
    const windowStart = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS) * TOTP_STEP_SECONDS;

    // Pre-check replay BEFORE running the verify so a replayed code never
    // gets the side-channel "verify time" of a fresh attempt.
    const replayKey: ReplayKey = {
      userId: opts.userId,
      code: opts.code,
      windowStart,
    };
    if (this.cache.has(replayKey)) {
      return false;
    }

    // Verify with epoch override so callers can use a fake clock in tests.
    // `authenticator.check` honors the ±window setting (=1 step here).
    let isValid = false;
    const baseOptions = {
      algorithm: HashAlgorithms.SHA1,
      digits: 6,
      step: 30,
      window: 1,
    };
    authenticator.options = { ...baseOptions, epoch: nowMs };
    try {
      isValid = authenticator.check(opts.code, opts.secret);
    } catch {
      isValid = false;
    } finally {
      authenticator.options = baseOptions;
    }

    if (isValid) {
      this.cache.add(replayKey);
      return true;
    }
    return false;
  }

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  generateCode(secret: string, nowMs?: number): string {
    const baseOptions = {
      algorithm: HashAlgorithms.SHA1,
      digits: 6,
      step: 30,
      window: 1,
    };
    if (nowMs !== undefined) {
      authenticator.options = { ...baseOptions, epoch: nowMs };
      try {
        return authenticator.generate(secret);
      } finally {
        authenticator.options = baseOptions;
      }
    }
    return authenticator.generate(secret);
  }
}

export const createTotpVerifier = (replayCacheCapacity?: number): TotpVerifier =>
  new OtplibTotpVerifier(replayCacheCapacity);

/**
 * Convenience helper that throws `MfaError` instead of returning `false`.
 * Used by the login flow when the TOTP step rejection should propagate as
 * an exception for clean error-handling semantics.
 */
export const requireValidTotp = (verifier: TotpVerifier, opts: TotpVerifyOptions): void => {
  if (!verifier.verify(opts)) {
    throw new MfaError('invalid TOTP code or replay', 'mfa_invalid');
  }
};
