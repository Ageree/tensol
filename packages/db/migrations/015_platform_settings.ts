import { type Kysely, sql } from 'kysely';

// Migration 015 — platform_settings singleton (Sprint 3 contract C21/R4).
//
// Singleton row enforced by a CHAR(1) primary key with CHECK (lock = 'x').
// The PG idiom: only one value 'x' is ever allowed → at most one row exists.
// The migration also seeds the singleton row so the platform_settings query
// is non-null on a fresh DB.
//
// Platform-scoped — NO tenant_id (the platform owns this table, not any
// individual tenant). It is excluded from TENANT_OWNED_TABLES in schema.ts.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('platform_settings')
    .addColumn('lock', sql`char(1)`, (c) =>
      c.primaryKey().defaultTo(sql`'x'`).check(sql`lock = 'x'`),
    )
    .addColumn('bootstrap_consumed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // Seed the singleton row so `SELECT bootstrap_consumed_at FROM platform_settings`
  // is always non-null on a fresh DB (C21b query expects it).
  await sql`INSERT INTO platform_settings (lock) VALUES ('x') ON CONFLICT DO NOTHING`.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('platform_settings').ifExists().execute();
};
