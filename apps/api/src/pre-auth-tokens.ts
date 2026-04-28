// Sprint 3 contract C22 (R2) — pre-auth-token in-memory LRU.
//
// Step-1 login (POST /auth/login) returns an opaque 32-byte hex token when
// the user has MFA enrolled. The token is stored in this LRU keyed by the
// hex value with `{userId, expiresAt, consumedAt}`. Step-2 (POST /auth/login/mfa)
// looks up the entry, verifies non-consumed + non-expired, runs TOTP, marks
// consumed. The contract specifies 60-second TTL.
//
// LIMITATION (ADR 0003 §Limitations): per-process. Sprint 7 swap to Redis.

import { randomBytes } from 'node:crypto';

export const PRE_AUTH_TOKEN_TTL_MS = 60_000;
export const PRE_AUTH_TOKEN_BYTES = 32;

export interface PreAuthEntry {
  readonly userId: string;
  readonly tenantId: string;
  readonly expiresAtMs: number;
  consumedAt: number | null;
}

export interface PreAuthIssued {
  readonly token: string;
  readonly expiresInSeconds: number;
}

export interface PreAuthStore {
  issue(args: { userId: string; tenantId: string; nowMs?: number }): PreAuthIssued;
  redeem(token: string, nowMs?: number): { userId: string; tenantId: string } | null;
  size(): number;
}

interface LruEntry {
  data: PreAuthEntry;
}

class InMemoryPreAuthStore implements PreAuthStore {
  private readonly capacity: number;
  private readonly entries = new Map<string, LruEntry>();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  issue(args: { userId: string; tenantId: string; nowMs?: number }): PreAuthIssued {
    const nowMs = args.nowMs ?? Date.now();
    const token = randomBytes(PRE_AUTH_TOKEN_BYTES).toString('hex');
    const expiresAtMs = nowMs + PRE_AUTH_TOKEN_TTL_MS;
    this.entries.set(token, {
      data: {
        userId: args.userId,
        tenantId: args.tenantId,
        expiresAtMs,
        consumedAt: null,
      },
    });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return { token, expiresInSeconds: Math.floor(PRE_AUTH_TOKEN_TTL_MS / 1000) };
  }

  redeem(token: string, nowMs?: number): { userId: string; tenantId: string } | null {
    const current = nowMs ?? Date.now();
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.data.consumedAt !== null) return null;
    if (entry.data.expiresAtMs <= current) {
      this.entries.delete(token);
      return null;
    }
    entry.data.consumedAt = current;
    return { userId: entry.data.userId, tenantId: entry.data.tenantId };
  }

  size(): number {
    return this.entries.size;
  }
}

export const createPreAuthStore = (capacity = 1024): PreAuthStore =>
  new InMemoryPreAuthStore(capacity);
