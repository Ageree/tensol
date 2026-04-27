import { type Kysely, sql } from 'kysely';

// Migration 009 — candidate_findings.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('candidate_findings')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('severity', 'text', (c) =>
      c
        .notNull()
        .defaultTo('info')
        .check(sql`severity IN ('info','low','medium','high','critical')`),
    )
    .addColumn('affected_url', 'text', (c) => c.notNull())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('observed_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_candidate_findings_tenant ON candidate_findings (tenant_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_candidate_findings_assessment ON candidate_findings (tenant_id, assessment_id)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN candidate_findings.payload IS 'purpose=candidate_finding_payload; expected_size_bytes=8192; if_larger=externalize_to_artifact'`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('candidate_findings').ifExists().execute();
};
