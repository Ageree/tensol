import { type Kysely, sql } from 'kysely';

// Migration 005 — assessment_artifacts. APPEND-ONLY (no updated_at).
// Triggers attached in migration 011 once enforce_append_only() exists.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('assessment_artifacts')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('object_storage_key', 'text', (c) => c.notNull())
    .addColumn('sha256', sql`char(64)`, (c) => c.notNull().check(sql`sha256 ~ '^[a-f0-9]{64}$'`))
    .addColumn('size_bytes', 'bigint', (c) => c.notNull())
    .addColumn('metadata', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_assessment_artifacts_tenant ON assessment_artifacts (tenant_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_assessment_artifacts_assessment ON assessment_artifacts (tenant_id, assessment_id)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN assessment_artifacts.metadata IS 'purpose=artifact_metadata; expected_size_bytes=2048; if_larger=split_artifact'`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('assessment_artifacts').ifExists().execute();
};
