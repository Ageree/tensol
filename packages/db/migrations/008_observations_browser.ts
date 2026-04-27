import { type Kysely, sql } from 'kysely';

// Migration 008 — observations_browser (Sprint 9 minimal).

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('observations_browser')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('http_status', 'integer')
    .addColumn('screenshot_object_key', 'text', (c) => c.notNull())
    .addColumn('screenshot_sha256', sql`char(64)`, (c) =>
      c.notNull().check(sql`screenshot_sha256 ~ '^[a-f0-9]{64}$'`),
    )
    .addColumn('screenshot_size_bytes', 'bigint', (c) => c.notNull())
    .addColumn('har_object_key', 'text', (c) => c.notNull())
    .addColumn('har_sha256', sql`char(64)`, (c) =>
      c.notNull().check(sql`har_sha256 ~ '^[a-f0-9]{64}$'`),
    )
    .addColumn('har_size_bytes', 'bigint', (c) => c.notNull())
    .addColumn('trace_object_key', 'text', (c) => c.notNull())
    .addColumn('trace_sha256', sql`char(64)`, (c) =>
      c.notNull().check(sql`trace_sha256 ~ '^[a-f0-9]{64}$'`),
    )
    .addColumn('trace_size_bytes', 'bigint', (c) => c.notNull())
    .addColumn('console_messages', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('observed_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_observations_browser_tenant ON observations_browser (tenant_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_observations_browser_assessment ON observations_browser (tenant_id, assessment_id)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN observations_browser.console_messages IS 'purpose=browser_console_log_lines; expected_size_bytes=16384; if_larger=truncate_or_externalize'`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('observations_browser').ifExists().execute();
};
