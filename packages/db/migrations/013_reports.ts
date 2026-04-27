import { type Kysely, sql } from 'kysely';

// Migration 013 — reports (Sprint 12 minimal).

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('reports')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('format', 'text', (c) =>
      c.notNull().check(sql`format IN ('html','json','zip','pdf')`),
    )
    .addColumn('object_storage_key', 'text', (c) => c.notNull())
    .addColumn('sha256', sql`char(64)`, (c) => c.notNull().check(sql`sha256 ~ '^[a-f0-9]{64}$'`))
    .addColumn('size_bytes', 'bigint', (c) => c.notNull())
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('pending')
        .check(sql`status IN ('pending','building','published','failed')`),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_reports_tenant ON reports (tenant_id)`.execute(db);
  await sql`CREATE INDEX idx_reports_assessment ON reports (tenant_id, assessment_id)`.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('reports').ifExists().execute();
};
