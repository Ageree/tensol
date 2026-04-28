// PlatformSettingsRepo — Sprint 3 contract C21b/R4.
//
// Singleton table; PK is `lock CHAR(1) CHECK (lock = 'x')`. Migration 015
// seeds the singleton row, so every read returns a row.
//
// Critical query (C21b consume-once invariant):
//
//   UPDATE platform_settings
//      SET bootstrap_consumed_at = now(), updated_at = now()
//    WHERE lock = 'x'
//      AND bootstrap_consumed_at IS NULL
//   RETURNING lock;
//
// Row count 0 → race lost OR already consumed → 410 Gone (route layer).

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../schema.ts';

export interface PlatformSettingsRow {
  readonly bootstrapConsumedAt: Date | null;
}

export class PlatformSettingsRepo {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  async read(): Promise<PlatformSettingsRow> {
    const row = await this.db
      .selectFrom('platform_settings')
      .select(['bootstrap_consumed_at'])
      .where('lock', '=', 'x')
      .executeTakeFirstOrThrow();
    return { bootstrapConsumedAt: row.bootstrap_consumed_at };
  }

  /**
   * Atomic consume-once. Returns true iff the caller successfully flipped
   * `bootstrap_consumed_at` from NULL → now(). Subsequent calls return false.
   */
  async consumeBootstrap(): Promise<boolean> {
    const result = await sql<{ lock: string }>`
      UPDATE platform_settings
         SET bootstrap_consumed_at = now(), updated_at = now()
       WHERE lock = 'x'
         AND bootstrap_consumed_at IS NULL
       RETURNING lock
    `.execute(this.db);
    return (result.rows.length ?? 0) > 0;
  }
}
