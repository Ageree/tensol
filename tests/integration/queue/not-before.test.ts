// Sprint 7 §5.3 A-Q-Local-5 (R3 promoted) — notBefore SQL predicate.

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

describe.skipIf(!hasDatabaseUrl())('queue :: notBefore (A-Q-Local-5)', () => {
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
    baseDir = mkdtempSync(join(tmpdir(), 'cs-queue-nb-'));
    adapter = new LocalQueueAdapter({ db: fx.db, baseDir });
    const ctx = await seedMinimalAssessmentContext(fx);
    tenantId = ctx.tenantId;
    assessmentId = ctx.assessmentId;
  });

  test('(a) future notBefore → row stays pending, handler not invoked', async () => {
    const future = new Date(Date.now() + 1500).toISOString();
    const env: JobEnvelope = {
      jobId: uniqId(),
      tenantId,
      projectId: null,
      assessmentId,
      kind: 'recon.browser.placeholder',
      idempotencyKey: 'idem-future',
      createdAt: new Date().toISOString(),
      notBefore: future,
      attempt: 0,
      maxAttempts: 3,
      traceId: 'trace',
      payload: { targetId: uniqId(), targetUrl: 'https://e.com', parentJobId: uniqId() },
    };
    const result = await adapter.publish(env);

    let invocations = 0;
    const sub = adapter.subscribe(
      'recon.browser.placeholder',
      async () => {
        invocations += 1;
        return { kind: 'ack' };
      },
      { tenantId, pollIntervalMs: 50 },
    );
    await new Promise((r) => setTimeout(r, 500));
    await sub.stop({ timeoutMs: 200 });

    expect(invocations).toBe(0);
    const row = await fx.db
      .selectFrom('jobs')
      .select(['status'])
      .where('id', '=', result.jobId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');

    rmSync(baseDir, { recursive: true, force: true });
  });

  test('(b) after clock passes notBefore → row claimed exactly once', async () => {
    const soon = new Date(Date.now() + 200).toISOString();
    const env: JobEnvelope = {
      jobId: uniqId(),
      tenantId,
      projectId: null,
      assessmentId,
      kind: 'recon.browser.placeholder',
      idempotencyKey: 'idem-soon',
      createdAt: new Date().toISOString(),
      notBefore: soon,
      attempt: 0,
      maxAttempts: 3,
      traceId: 'trace',
      payload: { targetId: uniqId(), targetUrl: 'https://e.com', parentJobId: uniqId() },
    };
    const result = await adapter.publish(env);

    let invocations = 0;
    const sub = adapter.subscribe(
      'recon.browser.placeholder',
      async () => {
        invocations += 1;
        return { kind: 'ack' };
      },
      { tenantId, pollIntervalMs: 50 },
    );
    await new Promise((r) => setTimeout(r, 800));
    await sub.stop({ timeoutMs: 200 });

    expect(invocations).toBe(1);
    const row = await fx.db
      .selectFrom('jobs')
      .select(['status', 'attempt'])
      .where('id', '=', result.jobId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('succeeded');
    expect(row.attempt).toBe(1);

    rmSync(baseDir, { recursive: true, force: true });
  });
});
