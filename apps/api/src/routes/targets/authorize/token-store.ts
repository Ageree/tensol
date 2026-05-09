import type { Database } from '@cyberstrike/db';
import type { Kysely } from 'kysely';
import type { TokenStore } from './whois-verifier.ts';

const sha256Hex = async (plaintext: string): Promise<string> => {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(plaintext));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
};

export const createDbTokenStore = (db: Kysely<Database>): TokenStore => ({
  findByPlaintext: async (token, _nowMs) => {
    const hash = await sha256Hex(token);
    const row = await db
      .selectFrom('target_authorizations')
      .select(['id', 'target_id', 'status', 'expires_at'])
      .where('token_hash', '=', hash)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      targetId: row.target_id,
      status: row.status,
      expiresAt: new Date(row.expires_at),
    };
  },

  markVerified: async (id, nowMs) => {
    const now = new Date(nowMs);
    await db
      .updateTable('target_authorizations')
      .set({
        status: 'verified',
        verified_at: now,
        consumed_at: now,
        token_plaintext: null,
        updated_at: now,
      })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .execute();
  },
});
