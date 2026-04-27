import { type Kysely, sql } from 'kysely';
import { attachAppendOnlyTriggers, dropAppendOnlyTriggers } from './_common.ts';

// Migration 011 — audit_events table (APPEND-ONLY) + creates the shared
// enforce_append_only() trigger function and attaches dual triggers
// (BEFORE UPDATE/DELETE row-level + BEFORE TRUNCATE statement-level) to
// every append-only table landed so far. EXCEPTION includes TG_TABLE_NAME
// and TG_OP per Sprint 2 contract B14 / B14b.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  // 1. Create the shared trigger function.
  await sql`
    CREATE OR REPLACE FUNCTION enforce_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'append-only table %: % rejected', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'check_violation';
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  // 2. Create audit_events table (no updated_at — append-only).
  await db.schema
    .createTable('audit_events')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('project_id', 'uuid', (c) => c.references('projects.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.references('assessments.id'))
    .addColumn('actor_type', 'text', (c) =>
      c.notNull().check(sql`actor_type IN ('user','service')`),
    )
    .addColumn('actor_id', 'text', (c) => c.notNull())
    .addColumn('actor_name', 'text', (c) => c.notNull())
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('resource_type', 'text', (c) => c.notNull())
    .addColumn('resource_id', 'text')
    .addColumn('before_state', 'jsonb')
    .addColumn('after_state', 'jsonb')
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .addColumn('trace_id', 'text', (c) => c.notNull())
    .addColumn('occurred_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_audit_events_tenant ON audit_events (tenant_id)`.execute(db);
  await sql`CREATE INDEX idx_audit_events_resource ON audit_events (tenant_id, resource_type, resource_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_audit_events_occurred ON audit_events (tenant_id, occurred_at DESC)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN audit_events.before_state IS 'purpose=audit_before_snapshot; expected_size_bytes=4096; if_larger=externalize_via_object_storage'`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN audit_events.after_state IS 'purpose=audit_after_snapshot; expected_size_bytes=4096; if_larger=externalize_via_object_storage'`.execute(
    db,
  );

  // 3. Attach dual triggers to every append-only table that exists so far.
  await attachAppendOnlyTriggers(db, 'assessment_artifacts');
  await attachAppendOnlyTriggers(db, 'finding_evidence');
  await attachAppendOnlyTriggers(db, 'audit_events');
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await dropAppendOnlyTriggers(db, 'audit_events');
  await dropAppendOnlyTriggers(db, 'finding_evidence');
  await dropAppendOnlyTriggers(db, 'assessment_artifacts');
  await db.schema.dropTable('audit_events').ifExists().execute();
  await sql`DROP FUNCTION IF EXISTS enforce_append_only()`.execute(db);
};
