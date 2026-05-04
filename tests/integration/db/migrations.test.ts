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

  test('B6 — rollback removes the latest migration (three-step: 019→018→017→re-apply)', async () => {
    // Sprint 16: latest migration was 019 (observations_browser SPA columns). Three-step strategy:
    // step-1 rolls back 019 (SPA columns gone, target_credentials still present),
    // step-2 rolls back 018 (target_credentials gone, langgraph_thread_id still present),
    // step-3 rolls back 017 (langgraph_thread_id gone).
    // Sprint 18: 021 is now latest, so pop 021 + 020 first so step-1 lands on 019.
    // Sprint 25: 024 is now latest, so pop 024 first.
    await applyAllMigrations(f);

    // Verify 018 shape: target_credentials exists.
    const beforeStep1 = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'target_credentials'
      ) AS exists
    `.execute(f.db);
    expect(beforeStep1.rows[0]?.exists).toBe(true);

    // Pop mig 024 + 023 + 022 + 021 + 020 so step-1 lands on 019.
    const r024pre = await f.migrator.migrateDown();
    if (r024pre.error)
      throw r024pre.error instanceof Error ? r024pre.error : new Error(String(r024pre.error));
    const r023pre = await f.migrator.migrateDown();
    if (r023pre.error)
      throw r023pre.error instanceof Error ? r023pre.error : new Error(String(r023pre.error));
    const r022pre = await f.migrator.migrateDown();
    if (r022pre.error)
      throw r022pre.error instanceof Error ? r022pre.error : new Error(String(r022pre.error));
    const r021pre = await f.migrator.migrateDown();
    if (r021pre.error)
      throw r021pre.error instanceof Error ? r021pre.error : new Error(String(r021pre.error));
    const r020pre = await f.migrator.migrateDown();
    if (r020pre.error)
      throw r020pre.error instanceof Error ? r020pre.error : new Error(String(r020pre.error));

    // Step-1: roll back 019 (SPA columns drop — target_credentials still present).
    const r1 = await f.migrator.migrateDown();
    if (r1.error) throw r1.error instanceof Error ? r1.error : new Error(String(r1.error));

    const afterStep1Tc = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'target_credentials'
      ) AS exists
    `.execute(f.db);
    expect(afterStep1Tc.rows[0]?.exists).toBe(true);

    // Step-2: roll back 018 (target_credentials drops).
    const r2 = await f.migrator.migrateDown();
    if (r2.error) throw r2.error instanceof Error ? r2.error : new Error(String(r2.error));

    const afterStep2Tc = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'target_credentials'
      ) AS exists
    `.execute(f.db);
    expect(afterStep2Tc.rows[0]?.exists).toBe(false);

    // 017 (langgraph_thread_id) must still be present after step-2.
    const afterStep2Lg = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'decepticon_sessions'
          AND column_name = 'langgraph_thread_id'
      ) AS exists
    `.execute(f.db);
    expect(afterStep2Lg.rows[0]?.exists).toBe(true);

    // Step-3: roll back 017 — langgraph_thread_id should now be gone.
    const r3 = await f.migrator.migrateDown();
    if (r3.error) throw r3.error instanceof Error ? r3.error : new Error(String(r3.error));

    const afterStep3Lg = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'decepticon_sessions'
          AND column_name = 'langgraph_thread_id'
      ) AS exists
    `.execute(f.db);
    expect(afterStep3Lg.rows[0]?.exists).toBe(false);

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

    // Roll back 12 migrations to revert through 013 (reports table drop).
    // 12 = down(024)→down(023)→down(022)→down(021)→…→down(013); reports table dropped at 013-down.
    for (let i = 0; i < 12; i++) {
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

  test('B6 — observations_browser SPA columns present after migration 019, absent after rollback', async () => {
    // Sprint 16: migration 019 adds source_url/depth/discovery_method to observations_browser.
    // Sprint 18: 021 is now latest, so pop 021 + 020 first so migrateDown targets 019.
    // Sprint 25: 024 is now latest, so pop 024 first.
    await applyAllMigrations(f);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'observations_browser'
        AND column_name IN ('source_url', 'depth', 'discovery_method')
      ORDER BY column_name
    `.execute(f.db);
    expect(cols.rows).toHaveLength(3);

    // Pop mig 024 + 023 + 022 + 021 + 020 so the next migrateDown targets 019.
    const r024pre = await f.migrator.migrateDown();
    if (r024pre.error)
      throw r024pre.error instanceof Error ? r024pre.error : new Error(String(r024pre.error));
    const r023pre = await f.migrator.migrateDown();
    if (r023pre.error)
      throw r023pre.error instanceof Error ? r023pre.error : new Error(String(r023pre.error));
    const r022pre = await f.migrator.migrateDown();
    if (r022pre.error)
      throw r022pre.error instanceof Error ? r022pre.error : new Error(String(r022pre.error));
    const r021pre = await f.migrator.migrateDown();
    if (r021pre.error)
      throw r021pre.error instanceof Error ? r021pre.error : new Error(String(r021pre.error));
    const r020pre = await f.migrator.migrateDown();
    if (r020pre.error)
      throw r020pre.error instanceof Error ? r020pre.error : new Error(String(r020pre.error));

    const r019 = await f.migrator.migrateDown();
    if (r019.error) throw r019.error instanceof Error ? r019.error : new Error(String(r019.error));

    const after019 = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'observations_browser'
        AND column_name IN ('source_url', 'depth', 'discovery_method')
    `.execute(f.db);
    expect(after019.rows).toHaveLength(0);

    await applyAllMigrations(f);
  });

  test('B6 — target_credentials table present after migration 018, absent after rollback', async () => {
    // Sprint 15: migration 018 adds target_credentials. With 021 now latest,
    // K = down(021) → down(020) → down(019) → down(018); pop 021+020 first so steps land on 019/018.
    // Sprint 25: 024 is now latest, so pop 024 first.
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

    // Pop mig 024 + 023 + 022 + 021 + 020 so subsequent steps land on the expected migrations.
    const r024pre = await f.migrator.migrateDown();
    if (r024pre.error)
      throw r024pre.error instanceof Error ? r024pre.error : new Error(String(r024pre.error));
    const r023pre = await f.migrator.migrateDown();
    if (r023pre.error)
      throw r023pre.error instanceof Error ? r023pre.error : new Error(String(r023pre.error));
    const r022pre = await f.migrator.migrateDown();
    if (r022pre.error)
      throw r022pre.error instanceof Error ? r022pre.error : new Error(String(r022pre.error));
    const r021pre = await f.migrator.migrateDown();
    if (r021pre.error)
      throw r021pre.error instanceof Error ? r021pre.error : new Error(String(r021pre.error));
    const r020pre = await f.migrator.migrateDown();
    if (r020pre.error)
      throw r020pre.error instanceof Error ? r020pre.error : new Error(String(r020pre.error));

    // Step 1: roll back 019 (SPA columns drop — target_credentials still present).
    const r019 = await f.migrator.migrateDown();
    if (r019.error) throw r019.error instanceof Error ? r019.error : new Error(String(r019.error));

    // Step 2: roll back 018 (target_credentials drops).
    const r018 = await f.migrator.migrateDown();
    if (r018.error) throw r018.error instanceof Error ? r018.error : new Error(String(r018.error));

    const afterRollback = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'target_credentials'
      ) AS exists
    `.execute(f.db);
    expect(afterRollback.rows[0]?.exists).toBe(false);

    await applyAllMigrations(f);
  });

  test('B6 — mig 020: target_credentials.name + target_credential_usage present after 020, absent after rollback', async () => {
    // Sprint 17: migration 020 adds name col to target_credentials and creates target_credential_usage.
    // Sprint 18: 021 is now latest, pop 021 first so migrateDown targets 020.
    // Sprint 25: 024 is now latest, pop 024 first.
    await applyAllMigrations(f);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'target_credentials'
        AND column_name = 'name'
    `.execute(f.db);
    expect(cols.rows).toHaveLength(1);

    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'target_credential_usage'
    `.execute(f.db);
    expect(tables.rows).toHaveLength(1);

    // Pop mig 024 + 023 + 022 + 021 so migrateDown targets 020.
    const r024pre = await f.migrator.migrateDown();
    if (r024pre.error)
      throw r024pre.error instanceof Error ? r024pre.error : new Error(String(r024pre.error));
    const r023pre = await f.migrator.migrateDown();
    if (r023pre.error)
      throw r023pre.error instanceof Error ? r023pre.error : new Error(String(r023pre.error));
    const r022pre = await f.migrator.migrateDown();
    if (r022pre.error)
      throw r022pre.error instanceof Error ? r022pre.error : new Error(String(r022pre.error));
    const r021pre = await f.migrator.migrateDown();
    if (r021pre.error)
      throw r021pre.error instanceof Error ? r021pre.error : new Error(String(r021pre.error));

    const r020 = await f.migrator.migrateDown();
    if (r020.error) throw r020.error instanceof Error ? r020.error : new Error(String(r020.error));

    const afterCols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'target_credentials'
        AND column_name = 'name'
    `.execute(f.db);
    expect(afterCols.rows).toHaveLength(0);

    const afterTables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'target_credential_usage'
    `.execute(f.db);
    expect(afterTables.rows).toHaveLength(0);

    await applyAllMigrations(f);
  });

  test('B6 — oob_callbacks table present after migration 021, absent after rollback', async () => {
    // Sprint 18: migration 021 adds oob_callbacks with two append-only triggers.
    // Sprint 25: 024 is now latest, pop 024 first.
    await applyAllMigrations(f);

    const tableRows = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'oob_callbacks'
      ) AS exists
    `.execute(f.db);
    expect(tableRows.rows[0]?.exists).toBe(true);

    // Verify append-only triggers are present.
    const trigRows = await sql<{ tgname: string }>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.oob_callbacks'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `.execute(f.db);
    const trigNames = new Set(trigRows.rows.map((r) => r.tgname));
    expect(trigNames.has('oob_callbacks_no_delete_stmt')).toBe(true);
    expect(trigNames.has('oob_callbacks_no_truncate')).toBe(true);

    // Roll back migration 024 then 023 then 022 then 021.
    const r024pre = await f.migrator.migrateDown();
    if (r024pre.error)
      throw r024pre.error instanceof Error ? r024pre.error : new Error(String(r024pre.error));
    const r023pre = await f.migrator.migrateDown();
    if (r023pre.error)
      throw r023pre.error instanceof Error ? r023pre.error : new Error(String(r023pre.error));
    const r022 = await f.migrator.migrateDown();
    if (r022.error) throw r022.error instanceof Error ? r022.error : new Error(String(r022.error));
    const r021 = await f.migrator.migrateDown();
    if (r021.error) throw r021.error instanceof Error ? r021.error : new Error(String(r021.error));

    const afterRollback = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'oob_callbacks'
      ) AS exists
    `.execute(f.db);
    expect(afterRollback.rows[0]?.exists).toBe(false);

    // Re-apply all migrations for downstream tests.
    await applyAllMigrations(f);
  });

  test('B6 — mig 022: recipe_text column present after 022, absent after rollback', async () => {
    // Sprint 23 G: migration 022 drops bytea columns and adds recipe_text text column.
    // Sprint 25: 024 is now latest, pop 024 first.
    await applyAllMigrations(f);

    const colsAfter = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'target_credentials'
        AND column_name = 'recipe_text'
    `.execute(f.db);
    expect(colsAfter.rows).toHaveLength(1);

    // Roll back migration 024 then 023 then 022.
    const r024pre = await f.migrator.migrateDown();
    if (r024pre.error)
      throw r024pre.error instanceof Error ? r024pre.error : new Error(String(r024pre.error));
    const r023pre = await f.migrator.migrateDown();
    if (r023pre.error)
      throw r023pre.error instanceof Error ? r023pre.error : new Error(String(r023pre.error));
    const r022 = await f.migrator.migrateDown();
    if (r022.error) throw r022.error instanceof Error ? r022.error : new Error(String(r022.error));

    const colsBefore = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'target_credentials'
        AND column_name = 'recipe_text'
    `.execute(f.db);
    expect(colsBefore.rows).toHaveLength(0);

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
