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
      WHERE table_schema = 'public' AND table_name IN ('tenants', 'audit_events', 'reports')
    `.execute(f.db);
    const found = new Set(rows.rows.map((r) => r.table_name));
    expect(found.has('tenants')).toBe(true);
    expect(found.has('audit_events')).toBe(true);
    expect(found.has('reports')).toBe(true);
  });

  test('B6 — rollback removes the latest migration', async () => {
    // Sprint 13 update: latest migration is 017 (langgraph_thread_id column on
    // decepticon_sessions). Rollback drops that column. Test checks the column
    // exists before rollback and is gone after.
    // (Previous assertion was against assessment_approvals from migration 016.)
    const before = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'decepticon_sessions'
          AND column_name = 'langgraph_thread_id'
      ) AS exists
    `.execute(f.db);
    expect(before.rows[0]?.exists).toBe(true);

    const result = await f.migrator.migrateDown();
    if (result.error)
      throw result.error instanceof Error ? result.error : new Error(String(result.error));

    const after = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'decepticon_sessions'
          AND column_name = 'langgraph_thread_id'
      ) AS exists
    `.execute(f.db);
    expect(after.rows[0]?.exists).toBe(false);

    // Re-apply for downstream tests.
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
