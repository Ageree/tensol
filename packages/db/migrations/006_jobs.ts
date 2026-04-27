import { type Kysely, sql } from 'kysely';

// Migration 006 — jobs queue mirror.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('jobs')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('project_id', 'uuid', (c) => c.references('projects.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.references('assessments.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('pending')
        .check(
          sql`status IN ('pending','running','succeeded','failed_transient','failed_terminal')`,
        ),
    )
    .addColumn('attempt', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', (c) => c.notNull().defaultTo(3))
    .addColumn('idempotency_key', 'text', (c) => c.notNull())
    .addColumn('not_before', 'timestamptz')
    .addColumn('trace_id', 'text', (c) => c.notNull())
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('jobs_tenant_idempotency_unique', ['tenant_id', 'idempotency_key'])
    .execute();
  await sql`CREATE INDEX idx_jobs_tenant ON jobs (tenant_id)`.execute(db);
  await sql`CREATE INDEX idx_jobs_status ON jobs (tenant_id, status)`.execute(db);
  await sql`COMMENT ON COLUMN jobs.payload IS 'purpose=queue_envelope_payload; expected_size_bytes=8192; if_larger=move_to_object_storage_and_reference'`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('jobs').ifExists().execute();
};
