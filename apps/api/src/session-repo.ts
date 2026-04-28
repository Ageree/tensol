// Session repository — Sprint 3 contract C17/C20/C23.
//
// The cookie value is opaque random hex; the SERVER stores `bcrypt(token)` as
// `user_sessions.token_hash`. To look up by cookie value the verifier must
// scan candidate sessions for the user (the bcrypt-hash is non-deterministic
// — a salt is baked in).
//
// Slice strategy: a safer-than-bcrypt alternative for the *index* would be
// `sha256(token || HMAC_KEY)`. But Sprint 3 contract C20 explicitly says
// bcrypt(token). The cookie value carries `<userId>.<plaintext>` so the
// server can locate the candidate row by user_id and then verify with
// `Bun.password.verify(plaintext, token_hash)`.

import type { PasswordHasher } from '@cyberstrike/authz';
import type { Database, UserSessionsTable } from '@cyberstrike/db';
import type { Kysely, Selectable } from 'kysely';

export interface SessionLookup {
  readonly session: Selectable<UserSessionsTable>;
}

export interface SessionRepoOptions {
  readonly hasher: PasswordHasher;
}

export class SessionRepo {
  private readonly db: Kysely<Database>;
  private readonly hasher: PasswordHasher;

  constructor(db: Kysely<Database>, opts: SessionRepoOptions) {
    this.db = db;
    this.hasher = opts.hasher;
  }

  /**
   * Cookie format: `${userId}.${plaintext}` (userId is a UUID string, then a
   * literal `.`, then the 32-byte hex token).
   */
  static formatCookieValue(userId: string, plaintext: string): string {
    return `${userId}.${plaintext}`;
  }

  static parseCookieValue(value: string): { userId: string; plaintext: string } | null {
    const dot = value.indexOf('.');
    if (dot < 1) return null;
    const userId = value.slice(0, dot);
    const plaintext = value.slice(dot + 1);
    // UUID v4 format check.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(userId)) return null;
    if (plaintext.length !== 64 || !/^[0-9a-f]+$/i.test(plaintext)) return null;
    return { userId, plaintext };
  }

  async findByCookieValue(cookieValue: string): Promise<SessionLookup | null> {
    const parsed = SessionRepo.parseCookieValue(cookieValue);
    if (!parsed) return null;

    const candidates = await this.db
      .selectFrom('user_sessions')
      .selectAll()
      .where('user_id', '=', parsed.userId)
      .execute();

    for (const candidate of candidates) {
      const ok = await this.hasher.verify(parsed.plaintext, candidate.token_hash);
      if (ok) return { session: candidate };
    }
    return null;
  }

  async issue(args: {
    tenantId: string;
    userId: string;
    plaintext: string;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ id: string }> {
    const tokenHash = await this.hasher.hash(args.plaintext);
    const row = await this.db
      .insertInto('user_sessions')
      .values({
        tenant_id: args.tenantId,
        user_id: args.userId,
        token_hash: tokenHash,
        expires_at: args.expiresAt,
        ip: args.ip ?? null,
        user_agent: args.userAgent ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id };
  }

  async invalidateById(sessionId: string): Promise<{ deleted: number }> {
    const result = await this.db
      .deleteFrom('user_sessions')
      .where('id', '=', sessionId)
      .executeTakeFirst();
    return { deleted: Number(result.numDeletedRows ?? 0n) };
  }

  async invalidateAllForUser(userId: string): Promise<{ deleted: number }> {
    const result = await this.db
      .deleteFrom('user_sessions')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return { deleted: Number(result.numDeletedRows ?? 0n) };
  }
}
