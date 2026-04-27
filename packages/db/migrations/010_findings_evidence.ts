import { type Kysely, sql } from 'kysely';

// Migration 010 — findings (mutable, status workflow) + finding_evidence
// (APPEND-ONLY). finding_evidence triggers attached in 011.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('findings')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('created_from_candidate_id', 'uuid', (c) =>
      c.notNull().references('candidate_findings.id').unique(),
    )
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('severity', 'text', (c) =>
      c.notNull().check(sql`severity IN ('info','low','medium','high','critical')`),
    )
    .addColumn('confidence', 'text', (c) =>
      c.notNull().check(sql`confidence IN ('low','medium','high')`),
    )
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('open')
        .check(
          sql`status IN ('open','triaged','accepted_risk','false_positive','fixed','retested','closed')`,
        ),
    )
    .addColumn('affected_url', 'text', (c) => c.notNull())
    .addColumn('reproduction', 'jsonb', (c) => c.notNull())
    .addColumn('validator_log', 'jsonb', (c) => c.notNull())
    .addColumn('validated_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_findings_tenant ON findings (tenant_id)`.execute(db);
  await sql`CREATE INDEX idx_findings_assessment ON findings (tenant_id, assessment_id)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN findings.reproduction IS 'purpose=reproduction_steps; expected_size_bytes=4096; if_larger=externalize_to_evidence'`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN findings.validator_log IS 'purpose=validator_decision_log; expected_size_bytes=8192; if_larger=externalize_to_evidence'`.execute(
    db,
  );

  await db.schema
    .createTable('finding_evidence')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('finding_id', 'uuid', (c) => c.notNull().references('findings.id'))
    .addColumn('kind', 'text', (c) =>
      c.notNull().check(sql`kind IN ('screenshot','har','trace','json','log')`),
    )
    .addColumn('object_storage_key', 'text', (c) => c.notNull())
    .addColumn('sha256', sql`char(64)`, (c) => c.notNull().check(sql`sha256 ~ '^[a-f0-9]{64}$'`))
    .addColumn('size_bytes', 'bigint', (c) => c.notNull())
    .addColumn('metadata', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_finding_evidence_tenant ON finding_evidence (tenant_id)`.execute(db);
  await sql`CREATE INDEX idx_finding_evidence_finding ON finding_evidence (tenant_id, finding_id)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN finding_evidence.metadata IS 'purpose=evidence_envelope; expected_size_bytes=2048; if_larger=split_evidence'`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('finding_evidence').ifExists().execute();
  await db.schema.dropTable('findings').ifExists().execute();
};
