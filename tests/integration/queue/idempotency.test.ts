// Sprint 7 §5.7 A-Q-Idem-1..2 — duplicate publish dedupes via unique constraint.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JobEnvelope, LocalQueueAdapter } from '@cyberstrike/queue';
import { hasDatabaseUrl, resetAuthState } from '../auth/helpers/auth-fixture.ts';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
} from '../db/helpers/db-fixture.ts';
import { seedMinimalAssessmentContext } from './helpers.ts';

const uniqId = (): string => crypto.randomUUID();

describe.skipIf(!hasDatabaseUrl())('queue :: idempotency (A-Q-Idem-1)', () => {
  let fx: DbFixture;
  let baseDir: string;
  let adapter: LocalQueueAdapter;
  let tenantId: string;
  let assessmentId: string;

  beforeAll(async () => {
    fx = await createFixture();
    await dropAllTables(fx);
    await applyAllMigrations(fx);
  });

  afterAll(async () => {
    await dropAllTables(fx);
    await fx.db.destroy();
  });

  beforeEach(async () => {
    await resetAuthState(fx.db);
    baseDir = mkdtempSync(join(tmpdir(), 'cs-queue-idem-'));
    adapter = new LocalQueueAdapter({ db: fx.db, baseDir });
    const ctx = await seedMinimalAssessmentContext(fx);
    tenantId = ctx.tenantId;
    assessmentId = ctx.assessmentId;
  });

  test('duplicate publish (same idempotencyKey) returns deduped=true with same jobId', async () => {
    const env: JobEnvelope = {
      jobId: uniqId(),
      tenantId,
      projectId: null,
      assessmentId,
      kind: 'validate.finding',
      idempotencyKey: 'idem-dup-1',
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: 'trace',
      payload: { targetId: uniqId(), targetUrl: 'https://e.com', parentJobId: uniqId() },
    };
    const r1 = await adapter.publish(env);
    expect(r1.deduped).toBe(false);

    // Second publish with the same idempotencyKey but a different jobId (shouldn't matter).
    const r2 = await adapter.publish({ ...env, jobId: uniqId() });
    expect(r2.deduped).toBe(true);
    expect(r2.jobId).toBe(r1.jobId);

    // Verify exactly one row in DB.
    const rows = await fx.db
      .selectFrom('jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', 'idem-dup-1')
      .execute();
    expect(rows.length).toBe(1);

    rmSync(baseDir, { recursive: true, force: true });
  });
});
