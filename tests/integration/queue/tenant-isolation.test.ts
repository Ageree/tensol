// Sprint 7 §5.6 A-Q-Tenant-1 — T1 publish, T2 subscriber MUST NOT receive.

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

describe.skipIf(!hasDatabaseUrl())('queue :: tenant isolation (A-Q-Tenant-1)', () => {
  let fx: DbFixture;
  let baseDir: string;
  let adapter: LocalQueueAdapter;
  let t1: string;
  let t1AssessmentId: string;
  let t2: string;

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
    baseDir = mkdtempSync(join(tmpdir(), 'cs-queue-ti-'));
    adapter = new LocalQueueAdapter({ db: fx.db, baseDir });
    const c1 = await seedMinimalAssessmentContext(fx);
    const c2 = await seedMinimalAssessmentContext(fx);
    t1 = c1.tenantId;
    t1AssessmentId = c1.assessmentId;
    t2 = c2.tenantId;
  });

  test('T1 publish never delivered to T2 subscriber', async () => {
    const t1env: JobEnvelope = {
      jobId: uniqId(),
      tenantId: t1,
      projectId: null,
      assessmentId: t1AssessmentId,
      kind: 'validate.finding',
      idempotencyKey: 't1-isolation',
      createdAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      traceId: 'trace-iso',
      payload: { targetId: uniqId(), targetUrl: 'https://t1.example', parentJobId: uniqId() },
    };
    await adapter.publish(t1env);

    const t2seen: JobEnvelope[] = [];
    const t2sub = adapter.subscribe(
      'recon.browser.placeholder',
      async (env) => {
        t2seen.push(env);
        return { kind: 'ack' };
      },
      { tenantId: t2, pollIntervalMs: 20 },
    );
    await new Promise((r) => setTimeout(r, 300));
    await t2sub.stop({ timeoutMs: 200 });

    expect(t2seen.length).toBe(0);

    // Now confirm T1 subscriber DOES receive it.
    const t1seen: JobEnvelope[] = [];
    const t1sub = adapter.subscribe(
      'recon.browser.placeholder',
      async (env) => {
        t1seen.push(env);
        return { kind: 'ack' };
      },
      { tenantId: t1, pollIntervalMs: 20 },
    );
    await new Promise((r) => setTimeout(r, 300));
    await t1sub.stop({ timeoutMs: 200 });
    expect(t1seen.length).toBe(1);

    rmSync(baseDir, { recursive: true, force: true });
  });
});
