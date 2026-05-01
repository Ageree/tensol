// Sprint 7 §5.3 A-Q-Concurrent-1 (R2) — exactly-once via SKIP LOCKED.

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

describe.skipIf(!hasDatabaseUrl())('queue :: concurrent subscribers (A-Q-Concurrent-1)', () => {
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
    baseDir = mkdtempSync(join(tmpdir(), 'cs-queue-conc-'));
    adapter = new LocalQueueAdapter({ db: fx.db, baseDir });
    const ctx = await seedMinimalAssessmentContext(fx);
    tenantId = ctx.tenantId;
    assessmentId = ctx.assessmentId;
  });

  test('two subscribers on same DB+baseDir, N=20 envelopes → each delivered exactly once', async () => {
    const N = 20;
    for (let i = 0; i < N; i += 1) {
      const env: JobEnvelope = {
        jobId: uniqId(),
        tenantId,
        projectId: null,
        assessmentId,
        kind: 'validate.finding',
        idempotencyKey: `idem-${i}`,
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: `trace-${i}`,
        payload: { targetId: uniqId(), targetUrl: `https://e${i}.com`, parentJobId: uniqId() },
      };
      await adapter.publish(env);
    }

    const seen = new Map<string, number>();
    const subA = adapter.subscribe(
      'validate.finding',
      async (env) => {
        seen.set(env.jobId, (seen.get(env.jobId) ?? 0) + 1);
        return { kind: 'ack' };
      },
      { tenantId, pollIntervalMs: 20, batchSize: 5 },
    );
    const subB = adapter.subscribe(
      'validate.finding',
      async (env) => {
        seen.set(env.jobId, (seen.get(env.jobId) ?? 0) + 1);
        return { kind: 'ack' };
      },
      { tenantId, pollIntervalMs: 20, batchSize: 5 },
    );

    // Wait for completion. Each envelope should resolve in <100ms; allow generous slack.
    await new Promise((r) => setTimeout(r, 1500));
    await Promise.all([subA.stop({ timeoutMs: 500 }), subB.stop({ timeoutMs: 500 })]);

    expect(seen.size).toBe(N);
    let total = 0;
    for (const count of seen.values()) {
      expect(count).toBe(1);
      total += count;
    }
    expect(total).toBe(N);

    // Confirm via DB: every row succeeded.
    const succeeded = await fx.db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'succeeded')
      .executeTakeFirstOrThrow();
    expect(Number(succeeded.c)).toBe(N);

    rmSync(baseDir, { recursive: true, force: true });
  });
});
