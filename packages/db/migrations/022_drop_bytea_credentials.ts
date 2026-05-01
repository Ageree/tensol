import { type Kysely, sql } from 'kysely';

// Migration 022 — Sprint 23 G: replace AES-256-GCM bytea columns with plain recipe_text.
//
// target_credentials is append-only (enforce_append_only triggers from 018).
// The bytea columns (encrypted_blob, iv, auth_tag) stored AES-256-GCM ciphertext.
// Pre-launch: no production data exists — safe to drop without data migration.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await sql`ALTER TABLE target_credentials ADD COLUMN recipe_text text NOT NULL DEFAULT ''`.execute(
    db,
  );
  await sql`ALTER TABLE target_credentials DROP COLUMN encrypted_blob`.execute(db);
  await sql`ALTER TABLE target_credentials DROP COLUMN iv`.execute(db);
  await sql`ALTER TABLE target_credentials DROP COLUMN auth_tag`.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  // v1 pre-launch: down silently drops recipe_text data; safe because no production data exists yet.
  await sql`ALTER TABLE target_credentials ADD COLUMN encrypted_blob bytea NOT NULL DEFAULT ''`.execute(
    db,
  );
  await sql`ALTER TABLE target_credentials ADD COLUMN iv bytea NOT NULL DEFAULT ''`.execute(db);
  await sql`ALTER TABLE target_credentials ADD COLUMN auth_tag bytea NOT NULL DEFAULT ''`.execute(
    db,
  );
  await sql`ALTER TABLE target_credentials DROP COLUMN recipe_text`.execute(db);
};
