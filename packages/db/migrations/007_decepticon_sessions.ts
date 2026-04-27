import { type Kysely, sql } from 'kysely';

// Migration 007 — decepticon_sessions (Sprint 8 minimal).

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('decepticon_sessions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('started')
        .check(
          sql`status IN ('started','planning','recon','exploit','reporting','completed','failed')`,
        ),
    )
    .addColumn('opplan_object_key', 'text', (c) => c.notNull())
    .addColumn('opplan_sha256', sql`char(64)`, (c) =>
      c.notNull().check(sql`opplan_sha256 ~ '^[a-f0-9]{64}$'`),
    )
    .addColumn('opplan_size_bytes', 'bigint', (c) => c.notNull())
    .addColumn('started_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('completed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_decepticon_sessions_tenant ON decepticon_sessions (tenant_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_decepticon_sessions_assessment ON decepticon_sessions (tenant_id, assessment_id)`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('decepticon_sessions').ifExists().execute();
};
