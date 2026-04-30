// B5/B6/B7 — migrations apply, rollback, redo + pg_dump determinism.
// Skipped when DATABASE_URL is absent (sandbox / no docker).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  hasDatabaseUrl,
  rollbackAllMigrations,
} from './helpers/db-fixture.ts';

const skip = !hasDatabaseUrl();

describe.skipIf(skip)('migrations :: apply / rollback / redo (B5/B6)', () => {
  let f: DbFixture;

  beforeAll(async () => {
    f = await createFixture();
    await dropAllTables(f);
  });

  afterAll(async () => {
    if (f) {
      await dropAllTables(f);
      await f.db.destroy();
    }
  });

  test('B5 — every migration applies cleanly to empty DB', async () => {
    await applyAllMigrations(f);
    // Spot-check that key tables exist.
    const rows = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('tenants', 'audit_events', 'reports', 'target_credentials')
    `.execute(f.db);
    const found = new Set(rows.rows.map((r) => r.table_name));
    expect(found.has('tenants')).toBe(true);
    expect(found.has('audit_events')).toBe(true);
    expect(found.has('reports')).toBe(true);
    expect(found.has('target_credentials')).toBe(true);
  });

  test('B6 — rollback removes the latest migration (two-step: 018→017→re-apply)', async () => {
    // Sprint 15: latest migration is 018 (target_credentials). Two-step strategy:
    // step-1 rolls back 018 (target_credentials gone, langgraph_thread_id still present),
    // step-2 rolls back 017 (langgraph_thread_id gone).
    await applyAllMigrations(f);

    // Verify 018 shape: target_credentials exists.
    const beforeStep1 = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'target_credentials'
      ) AS exists
    `.execute(f.db);
    expect(beforeStep1.rows[0]?.exists).toBe(true);

    // Step-1: roll back 018.
    const r1 = await f.migrator.migrateDown();
    if (r1.error) throw r1.error instanceof Error ? r1.error : new Error(String(r1.error));

    const afterStep1Tc = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'target_credentials'
      ) AS exists
    `.execute(f.db);
    expect(afterStep1Tc.rows[0]?.exists).toBe(false);

    // 017 (langgraph_thread_id) must still be present after step-1.
    const afterStep1Lg = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'decepticon_sessions'
          AND column_name = 'langgraph_thread_id'
      ) AS exists
    `.execute(f.db);
    expect(afterStep1Lg.rows[0]?.exists).toBe(true);

    // Step-2: roll back 017 — langgraph_thread_id should now be gone.
    const r2 = await f.migrator.migrateDown();
    if (r2.error) throw r2.error instanceof Error ? r2.error : new Error(String(r2.error));

    const afterStep2Lg = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'decepticon_sessions'
          AND column_name = 'langgraph_thread_id'
      ) AS exists
    `.execute(f.db);
    expect(afterStep2Lg.rows[0]?.exists).toBe(false);

    // Re-apply all for downstream tests.
    await applyAllMigrations(f);
  });

  test('B6 — reports table has expected column shape after migration 013', async () => {
    // F5 [B6 codex fix]: Verify the reports table shape as installed by
    // migration 013. Checks both the full artifact column set
    // (object_key_html/json/zip + sha256_html/json/zip + size_bytes_html/json/zip)
    // and the lifecycle + immutability columns, then rolls back and verifies
    // the table is gone, then re-applies.
    const expectedColumns = [
      'id',
      'tenant_id',
      'assessment_id',
      'idempotency_key',
      'status',
      'object_key_html',
      'sha256_html',
      'size_bytes_html',
      'object_key_json',
      'sha256_json',
      'size_bytes_json',
      'object_key_zip',
      'sha256_zip',
      'size_bytes_zip',
      'failure_reason',
      'created_at',
      'completed_at',
    ];

    // Ensure migrations are applied (idempotent — covers the case where this
    // test runs in isolation without prior B5 having applied them).
    await applyAllMigrations(f);

    const colRows = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'reports'
      ORDER BY ordinal_position
    `.execute(f.db);
    const actualColumns = colRows.rows.map((r) => r.column_name);
    for (const col of expectedColumns) {
      expect(actualColumns).toContain(col);
    }
    expect(actualColumns.length).toBe(expectedColumns.length);

    // Verify the immutability trigger exists (F4 codex fix).
    // Use pg_trigger (not information_schema.triggers) because PG's
    // information_schema.triggers does NOT list TRUNCATE triggers per spec.
    const trigRows = await sql<{ tgname: string }>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.reports'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `.execute(f.db);
    const trigNames = new Set(trigRows.rows.map((r) => r.tgname));
    expect(trigNames.has('reports_no_delete_stmt')).toBe(true);
    expect(trigNames.has('reports_no_truncate')).toBe(true);
    expect(trigNames.has('reports_immutable_ready')).toBe(true);

    // Roll back 6 migrations to revert through 013 (reports table drop).
    // 6 = down(018) → down(017) → down(016) → down(015) → down(014) → down(013); reports table dropped at 013-down.
    for (let i = 0; i < 6; i++) {
      const r = await f.migrator.migrateDown();
      if (r.error) throw r.error instanceof Error ? r.error : new Error(String(r.error));
    }

    const afterRollback = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'reports'
      ) AS exists
    `.execute(f.db);
    expect(afterRollback.rows[0]?.exists).toBe(false);

    // Re-apply all migrations for downstream tests.
    await applyAllMigrations(f);
  });

  test('B6 — target_credentials table present after migration 018, absent after rollback', async () => {
    // Sprint 15: migration 018 adds target_credentials. Rollback 1 step (018→017)
    // drops it. Re-apply for downstream tests.
    await applyAllMigrations(f);

    const trigRows = await sql<{ tgname: string }>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.target_credentials'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `.execute(f.db);
    const trigNames = new Set(trigRows.rows.map((r) => r.tgname));
    expect(trigNames.has('target_credentials_no_update_delete_stmt')).toBe(true);
    expect(trigNames.has('target_credentials_no_update_delete_row')).toBe(true);
    expect(trigNames.has('target_credentials_no_truncate')).toBe(true);

    const r = await f.migrator.migrateDown();
    if (r.error) throw r.error instanceof Error ? r.error : new Error(String(r.error));

    const afterRollback = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'target_credentials'
      ) AS exists
    `.execute(f.db);
    expect(afterRollback.rows[0]?.exists).toBe(false);

    await applyAllMigrations(f);
  });

  test('B6 — full rollback to empty schema works', async () => {
    await rollbackAllMigrations(f);
    const rows = await sql<{ count: string }>`
      SELECT COUNT(*) AS count FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('tenants','users','projects','assessments','audit_events')
    `.execute(f.db);
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(0);
    // Re-apply for downstream tests.
    await applyAllMigrations(f);
  });
});
