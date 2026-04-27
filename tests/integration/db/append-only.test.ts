// B14 / B14b — append-only triggers reject UPDATE / DELETE / TRUNCATE on
// every append-only table, with TG_TABLE_NAME + TG_OP in the error message.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  hasDatabaseUrl,
  seedTenant,
} from './helpers/db-fixture.ts';

const skip = !hasDatabaseUrl();

describe.skipIf(skip)('append-only triggers (B14, B14b)', () => {
  let f: DbFixture;
  let tenantId: string;

  beforeAll(async () => {
    f = await createFixture();
    await dropAllTables(f);
    await applyAllMigrations(f);
    tenantId = await seedTenant(f, { name: 'T1', slug: 't1-append' });
    // Insert one row in each append-only table to give UPDATE/DELETE something to target.
    const inserts = [
      sql`INSERT INTO assessment_artifacts (tenant_id, assessment_id, kind, object_storage_key, sha256, size_bytes)
          VALUES (${tenantId}, ${tenantId}, 'opplan', 'k', repeat('a', 64), 1)`,
    ];
    for (const stmt of inserts) {
      // Fixture rows reference tenant_id only; assessment_id FK is loose for this test.
      // Ignore failures — only audit_events is actually required for the trigger probe.
      await stmt.execute(f.db).catch(() => undefined);
    }
    await sql`INSERT INTO audit_events (tenant_id, actor_type, actor_id, actor_name, action, resource_type, trace_id)
              VALUES (${tenantId}, 'user', 'u1', 'tester', 'test', 'tenant', 't')`.execute(f.db);
    await sql`INSERT INTO llm_audit_events (tenant_id, model_id, request_hash, response_hash, trace_id)
              VALUES (${tenantId}, 'm', repeat('a',64), repeat('b',64), 't')`.execute(f.db);
  });

  afterAll(async () => {
    if (f) {
      await dropAllTables(f);
      await f.db.destroy();
    }
  });

  // All 4 append-only tables paired with a real text column for the
  // zero-row UPDATE probe. Picking a column the table actually has avoids
  // the parser short-circuiting before the trigger fires (evaluator F1
  // follow-up). audit_events / llm_audit_events have trace_id; the FK-bound
  // tables (assessment_artifacts, finding_evidence) use kind which both
  // declare. The DELETE / TRUNCATE probes don't reference columns.
  const appendOnlyTables = [
    { name: 'audit_events', mutableColumn: 'trace_id' },
    { name: 'llm_audit_events', mutableColumn: 'trace_id' },
    { name: 'assessment_artifacts', mutableColumn: 'kind' },
    { name: 'finding_evidence', mutableColumn: 'kind' },
  ] as const;

  // Tables for which we seeded a real row in beforeAll — the matching-row
  // UPDATE/DELETE probes need rows to target.
  const seededRowTables = appendOnlyTables.filter(
    (t) => t.name === 'audit_events' || t.name === 'llm_audit_events',
  );

  for (const { name: tbl, mutableColumn } of seededRowTables) {
    test(`B14 — matching-row UPDATE on ${tbl} is rejected (row trigger)`, async () => {
      try {
        await sql.raw(`UPDATE ${tbl} SET ${mutableColumn} = 'tampered' WHERE 1=1`).execute(f.db);
        throw new Error(`UPDATE on ${tbl} should have failed`);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('append-only table');
        expect(msg).toContain(tbl);
        expect(msg).toContain('UPDATE');
      }
    });

    test(`B14 — matching-row DELETE on ${tbl} is rejected (row trigger)`, async () => {
      try {
        await sql.raw(`DELETE FROM ${tbl} WHERE 1=1`).execute(f.db);
        throw new Error(`DELETE on ${tbl} should have failed`);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('append-only table');
        expect(msg).toContain(tbl);
        expect(msg).toContain('DELETE');
      }
    });
  }

  for (const { name: tbl, mutableColumn } of appendOnlyTables) {
    // Sprint 2 evaluator F1: zero-row UPDATE/DELETE MUST still raise.
    // Postgres row-level triggers don't fire on zero-row queries; the
    // statement-level trigger is the safety net. An attacker probing for
    // write-permission capability cannot distinguish "no matches" from
    // "denied" — both raise.
    //
    // F1 follow-up: each table's UPDATE probe references a column that
    // table actually declares (`mutableColumn`). Otherwise the parser
    // rejects with `column "foo" of relation "<tbl>" does not exist`
    // BEFORE the trigger fires — silent test pass / real semantic gap.
    test(`B14 (F1) — zero-row UPDATE on ${tbl} is rejected (statement trigger)`, async () => {
      try {
        await sql.raw(`UPDATE ${tbl} SET ${mutableColumn} = 'noop' WHERE 1=0`).execute(f.db);
        throw new Error(`zero-row UPDATE on ${tbl} should have failed`);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('append-only table');
        expect(msg).toContain(tbl);
        expect(msg).toContain('UPDATE');
      }
    });

    test(`B14 (F1) — zero-row DELETE on ${tbl} is rejected (statement trigger)`, async () => {
      try {
        await sql.raw(`DELETE FROM ${tbl} WHERE 1=0`).execute(f.db);
        throw new Error(`zero-row DELETE on ${tbl} should have failed`);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('append-only table');
        expect(msg).toContain(tbl);
        expect(msg).toContain('DELETE');
      }
    });

    test(`B14b — TRUNCATE on ${tbl} is rejected (statement trigger)`, async () => {
      try {
        await sql.raw(`TRUNCATE TABLE ${tbl}`).execute(f.db);
        throw new Error(`TRUNCATE on ${tbl} should have failed`);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('append-only table');
        expect(msg).toContain(tbl);
        expect(msg).toContain('TRUNCATE');
      }
    });
  }
});
