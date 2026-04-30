import { type Kysely, sql } from 'kysely';
import { attachAppendOnlyTriggers, dropAppendOnlyTriggers } from './_common.ts';

// Migration 018 — target_credentials table (Sprint 15 encrypted session storage).
//
// Stores AES-256-GCM encrypted login credentials per target per tenant.
// Rows are fully immutable (no status machine, no content updates) — full
// append-only trigger set (UPDATE+DELETE+TRUNCATE) is applied.
// Decryption key (CREDENTIAL_KEK) is read only inside services/browser-worker.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('target_credentials')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('target_id', 'uuid', (c) => c.notNull().references('targets.id'))
    .addColumn('recipe_id', 'text', (c) => c.notNull())
    .addColumn('encrypted_blob', sql`bytea`, (c) => c.notNull())
    .addColumn('iv', sql`bytea`, (c) => c.notNull())
    .addColumn('auth_tag', sql`bytea`, (c) => c.notNull())
    .addColumn('created_by', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`CREATE INDEX idx_target_credentials_tenant ON target_credentials (tenant_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_target_credentials_target ON target_credentials (tenant_id, target_id)`.execute(
    db,
  );

  await attachAppendOnlyTriggers(db, 'target_credentials');
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await dropAppendOnlyTriggers(db, 'target_credentials');
  await db.schema.dropTable('target_credentials').execute();
};
