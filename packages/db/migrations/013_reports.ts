import { type Kysely, sql } from 'kysely';

// Migration 013 — reports table (Sprint 14 minimal report builder).
//
// One row per report snapshot. Regeneration creates a NEW row (new id, new
// sha256s). The rendered content is immutable by convention: the repo exposes
// no update-content method, and status transitions (queued→building→ready|failed)
// are the only mutations allowed. The append-only triggers block DELETE so rows
// are permanent once created.
//
// Columns per format (html/json/zip) are nullable until status=ready.
// idempotency_key: (tenant_id, idempotency_key) unique — same POST key returns
// same report_id without re-rendering.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('reports')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('idempotency_key', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) =>
      c.notNull().defaultTo('queued').check(sql`status IN ('queued','building','ready','failed')`),
    )
    // HTML artifact (nullable until ready)
    .addColumn('object_key_html', 'text')
    .addColumn('sha256_html', sql`char(64)`)
    .addColumn('size_bytes_html', 'bigint')
    // JSON artifact (nullable until ready)
    .addColumn('object_key_json', 'text')
    .addColumn('sha256_json', sql`char(64)`)
    .addColumn('size_bytes_json', 'bigint')
    // ZIP artifact (nullable until ready)
    .addColumn('object_key_zip', 'text')
    .addColumn('sha256_zip', sql`char(64)`)
    .addColumn('size_bytes_zip', 'bigint')
    // Lifecycle
    .addColumn('failure_reason', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('completed_at', 'timestamptz')
    .execute();

  await sql`CREATE INDEX idx_reports_tenant ON reports (tenant_id)`.execute(db);
  await sql`CREATE INDEX idx_reports_assessment ON reports (tenant_id, assessment_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_reports_idempotency ON reports (tenant_id, idempotency_key)`.execute(
    db,
  );

  // Append-only + immutability triggers.
  //
  // DELETE/TRUNCATE: blocked for all rows (report rows are permanent).
  //
  // UPDATE: allowed during state-machine progression (queued→building→ready|failed)
  // but BLOCKED once a row reaches status='ready'.
  //
  // F4 [P1-from-evaluator codex fix]: The spec §S12 line 538 ("snapshot is
  // immutable, never overwrites") was previously enforced only by repo-surface
  // convention (no updateContent method). A direct raw SQL UPDATE on a ready row
  // would succeed. This trigger enforces immutability at the DB level for the
  // sha256_*, object_key_*, and size_bytes_* columns when OLD.status='ready'.
  // State-machine UPDATEs on queued/building rows are still allowed because the
  // WHEN clause limits the trigger to ready rows only.
  //
  // NOTE: reports uses DELETE-only blocking variant (not full attachAppendOnlyTriggers)
  // because status machine (queued→building→ready|failed) requires UPDATE.
  // We add a separate ROW-level UPDATE guard for ready rows.
  await sql`
    CREATE OR REPLACE FUNCTION reports_deny_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'reports: DELETE rejected — report rows are permanent'
        USING ERRCODE = 'check_violation';
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`
    CREATE TRIGGER reports_no_delete_stmt
      BEFORE DELETE ON reports
      FOR EACH STATEMENT EXECUTE FUNCTION reports_deny_delete()
  `.execute(db);
  await sql`
    CREATE TRIGGER reports_no_truncate
      BEFORE TRUNCATE ON reports
      FOR EACH STATEMENT EXECUTE FUNCTION reports_deny_delete()
  `.execute(db);

  // ROW-level immutability guard: block UPDATE when OLD.status='ready'.
  // State-machine UPDATEs (queued→building, building→ready, building→failed)
  // are not blocked because OLD.status will be 'queued' or 'building' in those
  // paths. This fires BEFORE UPDATE for each row where status was already 'ready'.
  await sql`
    CREATE OR REPLACE FUNCTION raise_immutable_ready_report() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'reports: UPDATE rejected — row id=% is immutable (status=ready)', OLD.id
        USING ERRCODE = 'check_violation';
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`
    CREATE TRIGGER reports_immutable_ready
      BEFORE UPDATE ON reports
      FOR EACH ROW
      WHEN (OLD.status = 'ready')
      EXECUTE FUNCTION raise_immutable_ready_report()
  `.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await sql`DROP TRIGGER IF EXISTS reports_immutable_ready ON reports`.execute(db);
  await sql`DROP FUNCTION IF EXISTS raise_immutable_ready_report()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS reports_no_truncate ON reports`.execute(db);
  await sql`DROP TRIGGER IF EXISTS reports_no_delete_stmt ON reports`.execute(db);
  await sql`DROP FUNCTION IF EXISTS reports_deny_delete()`.execute(db);
  await db.schema.dropTable('reports').ifExists().execute();
};
