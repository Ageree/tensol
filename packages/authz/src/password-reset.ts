// Sprint 3 contract C16 (R3 rewrite) — password reset token primitives.
//
// Token format: 32 bytes from `crypto.randomBytes`, hex-encoded → 64-char
// hex string. The client receives the plaintext token (delivered out-of-band
// — e.g. email — but for the slice it lands in audit_events). The DB stores
// only `sha256(token)` as the PRIMARY KEY of `password_reset_tokens`.
//
// Single-use redemption is enforced atomically by:
//
//   UPDATE password_reset_tokens
//      SET consumed_at = now()
//    WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
//   RETURNING user_id, tenant_id;
//
// The repo wrapper lives in packages/db. This file provides the pure
// token-generation + hashing helpers that the route layer wires up.

import { createHash, randomBytes } from 'node:crypto';

export const PASSWORD_RESET_TOKEN_BYTES = 32 as const;
export const PASSWORD_RESET_TOKEN_HEX_LENGTH = 64 as const;
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;

export interface IssuedResetToken {
  /** Hex token delivered to the user (NEVER stored). */
  readonly plaintext: string;
  /** SHA-256 hex digest stored as `password_reset_tokens.token_hash`. */
  readonly tokenHash: string;
  /** UNIX millis when the token must be rejected by the redemption query. */
  readonly expiresAtMs: number;
}

export const generateResetToken = (nowMs: number = Date.now()): IssuedResetToken => {
  const bytes = randomBytes(PASSWORD_RESET_TOKEN_BYTES);
  const plaintext = bytes.toString('hex');
  const tokenHash = sha256Hex(plaintext);
  return {
    plaintext,
    tokenHash,
    expiresAtMs: nowMs + PASSWORD_RESET_TTL_MS,
  };
};

export const hashResetToken = (plaintext: string): string => sha256Hex(plaintext);

const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');
