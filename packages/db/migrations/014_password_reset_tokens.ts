import { type Kysely, sql } from 'kysely';

// Migration 014 — password_reset_tokens (Sprint 3 contract C16/R3).
//
// Mutable (NOT append-only): redemption flips `consumed_at` from NULL to
// now() in a single atomic UPDATE so single-use is enforced at the DB
// level via row-count semantics:
//
//   UPDATE password_reset_tokens
//      SET consumed_at = now()
//    WHERE token_hash = $1
//      AND consumed_at IS NULL
//      AND expires_at > now()
//   RETURNING user_id, tenant_id;
//
// Row count 0 → unknown / expired / already-consumed → reject.
//
// PRIMARY KEY is `token_hash` (sha256(plaintext) hex, CHAR(64)). The plain
// token never reaches the DB.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('password_reset_tokens')
    .addColumn('token_hash', sql`char(64)`, (c) =>
      c.primaryKey().check(sql`token_hash ~ '^[a-f0-9]{64}$'`),
    )
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('consumed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`CREATE INDEX idx_password_reset_tokens_user_expires
    ON password_reset_tokens (user_id, expires_at)`.execute(db);
  await sql`CREATE INDEX idx_password_reset_tokens_tenant
    ON password_reset_tokens (tenant_id)`.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('password_reset_tokens').ifExists().execute();
};
