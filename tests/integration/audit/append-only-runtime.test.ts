// Sprint 4 A13b — runtime PG trigger probe.
//
// Asserts the migration-011 trigger still bites with SQLSTATE 23514
// (`check_violation`) on UPDATE / DELETE / TRUNCATE against `audit_events`,
// while INSERT continues to succeed (positive control). When the trigger
// catches one of the rejected operations, the harness emits a denyAudit row
// with `action='audit.append_only_violation'` so Sprints 5+ can hook real
// call sites to the same path if any ever surface.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { denyAudit } from '@cyberstrike/audit';
import { sql } from 'kysely';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  hasDatabaseUrl,
  seedTenant,
  seedUser,
} from '../db/helpers/db-fixture.ts';

const APPEND_ONLY_VIOLATION_SQLSTATE = '23514';

interface PgError extends Error {
  readonly code?: string;
  readonly severity?: string;
}

const expectAppendOnlyViolation = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
    throw new Error('should have thrown SQLSTATE 23514');
  } catch (err) {
    const e = err as PgError;
    expect(e.code).toBe(APPEND_ONLY_VIOLATION_SQLSTATE);
    expect(e.severity).toBe('ERROR');
  }
};

describe.skipIf(!hasDatabaseUrl())('audit :: append-only runtime trigger (A13b)', () => {
  let fx: DbFixture;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    fx = await createFixture();
    await dropAllTables(fx);
    await applyAllMigrations(fx);
    tenantId = await seedTenant(fx, { name: 'A13b', slug: 'a13b' });
    userId = await seedUser(fx, tenantId, { email: 'a13b@x.io' });
  });

  afterAll(async () => {
    await dropAllTables(fx);
    await fx.db.destroy();
  });

  test('positive control: INSERT into audit_events succeeds', async () => {
    await sql`
      INSERT INTO audit_events (
        tenant_id, actor_type, actor_id, actor_name, action,
        resource_type, trace_id
      ) VALUES (
        ${tenantId}, 'user', ${userId}, 'a13b-positive', 'auth.login.password',
        'user', '00000000000000000000000000000001'
      )
    `.execute(fx.db);
  });

  test('negative control 1: UPDATE rejected with SQLSTATE 23514', async () => {
    await expectAppendOnlyViolation(async () => {
      await sql`UPDATE audit_events SET action = 'tampered' WHERE 1=1`.execute(fx.db);
    });
    // Harness-side denyAudit emission: emit a row with action='audit.append_only_violation'
    // so Sprints 5+ can grep for it as the canonical fingerprint.
    await denyAudit(
      { db: fx.db },
      {
        tenantId,
        action: 'audit.append_only_violation',
        outcome: 'denied',
        actorType: 'service',
        actorId: 'system',
        actorName: 'a13b-harness',
        resourceType: 'audit_event',
        reason: 'append-only constraint violation',
        traceId: '00000000000000000000000000000002',
        metadata: { operation: 'UPDATE', sqlstate: APPEND_ONLY_VIOLATION_SQLSTATE },
      },
    );
    const row = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'audit.append_only_violation')
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const after = row.after_state as { outcome: string; sqlstate: string };
    expect(after.outcome).toBe('denied');
    expect(after.sqlstate).toBe(APPEND_ONLY_VIOLATION_SQLSTATE);
  });

  test('negative control 2: DELETE rejected with SQLSTATE 23514', async () => {
    await expectAppendOnlyViolation(async () => {
      await sql`DELETE FROM audit_events WHERE 1=1`.execute(fx.db);
    });
  });

  test('negative control 3: TRUNCATE rejected with SQLSTATE 23514', async () => {
    await expectAppendOnlyViolation(async () => {
      await sql`TRUNCATE audit_events`.execute(fx.db);
    });
  });
});
