import { type Kysely, sql } from 'kysely';

// Migration 004 — assessments, assessment_scope_rules. Both versioned
// (B20). JSONB columns carry COMMENT paper trail (B23b).

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('assessments')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('project_id', 'uuid', (c) => c.notNull().references('projects.id'))
    .addColumn('state', 'text', (c) =>
      c
        .notNull()
        .defaultTo('draft')
        .check(
          sql`state IN ('draft','submitted','approved','running','paused','cancelled','completed','failed')`,
        ),
    )
    .addColumn('created_by', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('approved_by', 'uuid', (c) => c.references('users.id'))
    .addColumn('testing_window_start', 'timestamptz')
    .addColumn('testing_window_end', 'timestamptz')
    .addColumn('high_impact_categories', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('metadata', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
    .execute();
  await sql`CREATE INDEX idx_assessments_tenant ON assessments (tenant_id)`.execute(db);
  await sql`CREATE INDEX idx_assessments_project ON assessments (tenant_id, project_id)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN assessments.high_impact_categories IS 'purpose=high_impact_category_flags; expected_size_bytes=128; if_larger=N/A — array of fixed enum strings'`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN assessments.metadata IS 'purpose=assessment_metadata_freeform; expected_size_bytes=4096; if_larger=move_to_assessment_artifacts(object_storage_key)'`.execute(
    db,
  );

  await db.schema
    .createTable('assessment_scope_rules')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('rule_kind', 'text', (c) => c.notNull())
    .addColumn('effect', 'text', (c) => c.notNull().check(sql`effect IN ('allow','deny')`))
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
    .execute();
  await sql`CREATE INDEX idx_assessment_scope_rules_tenant ON assessment_scope_rules (tenant_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_assessment_scope_rules_assessment ON assessment_scope_rules (tenant_id, assessment_id)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN assessment_scope_rules.payload IS 'purpose=scope_rule_definition; expected_size_bytes=2048; if_larger=split_into_multiple_rules'`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('assessment_scope_rules').ifExists().execute();
  await db.schema.dropTable('assessments').ifExists().execute();
};
