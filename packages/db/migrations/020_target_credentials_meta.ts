import { type Kysely, sql } from 'kysely';

// Migration 020 — Sprint 17: target_credentials cosmetic name column + mutable
// usage-tracking sibling table.
//
// target_credentials is append-only (enforce_append_only triggers from 018).
// We cannot add a mutable column to it. So:
//   - ADD COLUMN name (immutable default '' — set once at create time via INSERT).
//   - NEW TABLE target_credential_usage (mutable): last_used_at, use_count.
//     Updated by browser-worker on every decryptCredential call (Phase 4).
//     No append-only triggers on this table.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await sql`ALTER TABLE target_credentials ADD COLUMN name text NOT NULL DEFAULT ''`.execute(db);

  await db.schema
    .createTable('target_credential_usage')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('credential_id', 'uuid', (c) => c.notNull().references('target_credentials.id'))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('last_used_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('use_count', 'integer', (c) => c.notNull().defaultTo(1))
    .addUniqueConstraint('target_credential_usage_credential_id_unique', ['credential_id'])
    .execute();

  await sql`CREATE INDEX idx_tcu_tenant ON target_credential_usage (tenant_id)`.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('target_credential_usage').ifExists().execute();
  await sql`ALTER TABLE target_credentials DROP COLUMN IF EXISTS name`.execute(db);
};
