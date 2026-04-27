import { type Kysely, sql } from 'kysely';

// Migration 001 — tenants. The platform-level table; no tenant_id column
// because it IS the tenant.

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  await db.schema
    .createTable('tenants')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('status', 'text', (c) =>
      c.notNull().defaultTo('active').check(sql`status IN ('active', 'suspended', 'archived')`),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
};

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('tenants').ifExists().execute();
};
