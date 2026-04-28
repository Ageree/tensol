// PasswordResetTokensRepo — Sprint 3 contract C16/R3.
//
// This table has a non-standard PK (`token_hash` CHAR(64) instead of `id` UUID),
// so it does not fit the generic MutableRepository<TableName> contract. The
// repo exposes ONLY the operations C16 calls for:
//   - issue: INSERT a fresh row
//   - redeem: atomic UPDATE that flips consumed_at, single-use, time-bounded
//   - findByHash: read-only view (test fixtures use it; production routes
//     normally only call redeem)
//
// Single-use redemption query (R3):
//
//   UPDATE password_reset_tokens
//      SET consumed_at = now(), updated_at = now()
//    WHERE token_hash = $1
//      AND consumed_at IS NULL
//      AND expires_at > now()
//   RETURNING user_id, tenant_id;
//
// Row count 0 → token unknown / expired / already consumed → reject.

import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, PasswordResetTokensTable } from '../schema.ts';

export interface RedeemedResetToken {
  readonly userId: string;
  readonly tenantId: string;
}

export class PasswordResetTokensRepo {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  async issue(args: {
    tokenHash: string;
    userId: string;
    tenantId: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db
      .insertInto('password_reset_tokens')
      .values({
        token_hash: args.tokenHash,
        user_id: args.userId,
        tenant_id: args.tenantId,
        expires_at: args.expiresAt,
      })
      .execute();
  }

  /**
   * Atomic single-use redemption. Returns the redeemed token's principal on
   * success; null on miss (token unknown, expired, or already consumed).
   */
  async redeem(tokenHash: string): Promise<RedeemedResetToken | null> {
    const result = await sql<{ user_id: string; tenant_id: string }>`
      UPDATE password_reset_tokens
         SET consumed_at = now(), updated_at = now()
       WHERE token_hash = ${tokenHash}
         AND consumed_at IS NULL
         AND expires_at > now()
       RETURNING user_id, tenant_id
    `.execute(this.db);

    const row = result.rows[0];
    if (!row) return null;
    return { userId: row.user_id, tenantId: row.tenant_id };
  }

  async findByHash(tokenHash: string): Promise<Selectable<PasswordResetTokensTable> | null> {
    const row = await this.db
      .selectFrom('password_reset_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    return row ?? null;
  }
}
