// Shared helpers for Sprint 2 migrations.
// Keep DDL repetition out of individual migration files.

import { type Kysely, sql } from 'kysely';

/**
 * SQL fragment that produces the standard tenant_id column declaration.
 * Used by every tenant-owned table.
 */
export const tenantIdColumn = sql`uuid NOT NULL`;

/**
 * Creates the standard tenant index `idx_<table>_tenant`.
 */
export const createTenantIndex = async (
  // biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
  db: Kysely<any>,
  table: string,
): Promise<void> => {
  await sql`CREATE INDEX ${sql.raw(`idx_${table}_tenant`)} ON ${sql.raw(table)} (tenant_id)`.execute(
    db,
  );
};

/**
 * CHECK constraint sql fragment for a status string column.
 */
export const statusCheck = (column: string, allowed: ReadonlyArray<string>) =>
  sql.raw(`${column} IN (${allowed.map((v) => `'${v}'`).join(', ')})`);

/**
 * Standard append-only trigger pair attached to a table. The shared
 * `enforce_append_only()` function is created once in 011_audit_events.ts.
 */
export const attachAppendOnlyTriggers = async (
  // biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
  db: Kysely<any>,
  table: string,
): Promise<void> => {
  await sql`
    CREATE TRIGGER ${sql.raw(`${table}_no_update_delete`)}
      BEFORE UPDATE OR DELETE ON ${sql.raw(table)}
      FOR EACH ROW EXECUTE FUNCTION enforce_append_only()
  `.execute(db);
  await sql`
    CREATE TRIGGER ${sql.raw(`${table}_no_truncate`)}
      BEFORE TRUNCATE ON ${sql.raw(table)}
      FOR EACH STATEMENT EXECUTE FUNCTION enforce_append_only()
  `.execute(db);
};

export const dropAppendOnlyTriggers = async (
  // biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
  db: Kysely<any>,
  table: string,
): Promise<void> => {
  await sql`DROP TRIGGER IF EXISTS ${sql.raw(`${table}_no_truncate`)} ON ${sql.raw(table)}`.execute(
    db,
  );
  await sql`DROP TRIGGER IF EXISTS ${sql.raw(`${table}_no_update_delete`)} ON ${sql.raw(table)}`.execute(
    db,
  );
};
