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

  const appendOnlyTables = ['audit_events', 'llm_audit_events'] as const;

  for (const tbl of appendOnlyTables) {
    test(`B14 — UPDATE on ${tbl} is rejected with TG_TABLE_NAME and TG_OP`, async () => {
      try {
        await sql.raw(`UPDATE ${tbl} SET trace_id = 'tampered' WHERE 1=1`).execute(f.db);
        throw new Error(`UPDATE on ${tbl} should have failed`);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('append-only table');
        expect(msg).toContain(tbl);
        expect(msg).toContain('UPDATE');
      }
    });

    test(`B14 — DELETE on ${tbl} is rejected with TG_TABLE_NAME and TG_OP`, async () => {
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

    test(`B14b — TRUNCATE on ${tbl} is rejected with TG_TABLE_NAME and TG_OP`, async () => {
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
