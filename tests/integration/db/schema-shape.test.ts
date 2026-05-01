// B9–B12, B23, B23b, B24 — schema-shape sanity probes.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  hasDatabaseUrl,
} from './helpers/db-fixture.ts';

const skip = !hasDatabaseUrl();

const TENANT_OWNED = [
  'users',
  'user_sessions',
  'mfa_secrets',
  'password_reset_tokens',
  'projects',
  'targets',
  'assessments',
  'assessment_scope_rules',
  'assessment_targets',
  'assessment_artifacts',
  'assessment_approvals',
  'target_ownership_claims',
  'idempotency_keys',
  'jobs',
  'decepticon_sessions',
  'observations_browser',
  'candidate_findings',
  'findings',
  'finding_evidence',
  'audit_events',
  'llm_audit_events',
  'reports',
  'target_credentials',
];

const APPEND_ONLY = [
  'assessment_artifacts',
  'assessment_approvals',
  'target_ownership_claims',
  'finding_evidence',
  'audit_events',
  'llm_audit_events',
  'reports', // Sprint 14: delete-deny trigger, status-only UPDATE allowed, no content mutation
  'target_credentials', // Sprint 15: fully immutable encrypted credential rows
];

// Tables that intentionally don't carry an `updated_at` column even though
// they are not append-only: assessment_targets is a join with no mutable
// fields; idempotency_keys rows are insert-once and read-or-expire — there
// is nothing to update.
const NO_UPDATED_AT_NON_APPEND_ONLY = ['assessment_targets', 'idempotency_keys'];

describe.skipIf(skip)('schema shape (B9-B12, B23, B23b, B24)', () => {
  let f: DbFixture;

  beforeAll(async () => {
    f = await createFixture();
    await dropAllTables(f);
    await applyAllMigrations(f);
  });

  afterAll(async () => {
    if (f) {
      await dropAllTables(f);
      await f.db.destroy();
    }
  });

  test('B9 — every tenant-owned table has tenant_id NOT NULL', async () => {
    const r = await sql<{ table_name: string; is_nullable: string }>`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id' AND table_name = ANY(${TENANT_OWNED})
    `.execute(f.db);
    const names = new Set(r.rows.map((row) => row.table_name));
    for (const t of TENANT_OWNED) expect(names.has(t)).toBe(true);
    for (const row of r.rows) expect(row.is_nullable).toBe('NO');
  });

  test('B10/B11 — created_at present on all tenant-owned; updated_at present except on append-only', async () => {
    const r = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name = ANY(${TENANT_OWNED})
        AND column_name IN ('created_at','updated_at')
    `.execute(f.db);
    const has = new Map<string, Set<string>>();
    for (const row of r.rows) {
      const set = has.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      has.set(row.table_name, set);
    }
    for (const t of TENANT_OWNED) {
      const cols = has.get(t) ?? new Set();
      expect(cols.has('created_at')).toBe(true);
      if (APPEND_ONLY.includes(t)) {
        expect(cols.has('updated_at')).toBe(false); // B13
      } else if (NO_UPDATED_AT_NON_APPEND_ONLY.includes(t)) {
        // Sprint 5 / migration 016 — see comment on the const.
        expect(cols.has('updated_at')).toBe(false);
      } else {
        expect(cols.has('updated_at')).toBe(true);
      }
    }
  });

  // Sprint 23 G: target_credentials bytea columns removed (recipe_text text).
  const BYTEA_EXEMPT: string[] = [];

  test('B23 — no BYTEA columns anywhere (except exempt tables)', async () => {
    const r = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND data_type='bytea'
        AND table_name != ALL(${BYTEA_EXEMPT})
    `.execute(f.db);
    expect(r.rows.length).toBe(0);
  });

  test('B23b — every JSONB column has a COMMENT matching purpose=...; expected_size_bytes=N', async () => {
    const r = await sql<{ table_name: string; column_name: string; description: string | null }>`
      SELECT c.table_name, c.column_name,
             pg_catalog.col_description((c.table_schema||'.'||c.table_name)::regclass, c.ordinal_position) AS description
      FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.data_type='jsonb'
    `.execute(f.db);
    expect(r.rows.length).toBeGreaterThan(0);
    const re = /purpose=.+; expected_size_bytes=\d+/;
    for (const row of r.rows) {
      expect(row.description ?? '').toMatch(re);
    }
  });

  test('B24 — sha256 CHECK regex rejects non-hex value', async () => {
    try {
      await sql`
        INSERT INTO assessment_artifacts (tenant_id, assessment_id, kind, object_storage_key, sha256, size_bytes)
        VALUES ('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','x','k', ${'X'.repeat(64)}, 1)
      `.execute(f.db);
      throw new Error('CHECK should have rejected non-hex sha256');
    } catch (e) {
      expect((e as Error).message).toMatch(/check|constraint|sha256/i);
    }
  });
});
