// Sprint 7 §5.3 A-Q-Local-4 (F1) — direct ack(jobId) and nack(jobId, error)
// methods, plus the applyDecision retry + classified_terminal branches (F3).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JobEnvelope, LocalQueueAdapter, ScopeDenyError } from '@cyberstrike/queue';
import { hasDatabaseUrl, resetAuthState } from '../auth/helpers/auth-fixture.ts';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
} from '../db/helpers/db-fixture.ts';
import { seedMinimalAssessmentContext } from './helpers.ts';

const uniqId = (): string => crypto.randomUUID();

describe.skipIf(!hasDatabaseUrl())('queue :: direct ack/nack (A-Q-Local-4)', () => {
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
    baseDir = mkdtempSync(join(tmpdir(), 'cs-queue-acknack-'));
    adapter = new LocalQueueAdapter({ db: fx.db, baseDir });
    const ctx = await seedMinimalAssessmentContext(fx);
    tenantId = ctx.tenantId;
    assessmentId = ctx.assessmentId;
  });

  const env = (idem: string): JobEnvelope => ({
    jobId: uniqId(),
    tenantId,
    projectId: null,
    assessmentId,
    kind: 'validate.finding',
    idempotencyKey: idem,
    createdAt: new Date().toISOString(),
    attempt: 0,
    maxAttempts: 3,
    traceId: `trace-${idem}`,
    payload: { targetId: uniqId(), targetUrl: 'https://e.com', parentJobId: uniqId() },
  });

  test('direct adapter.ack(jobId) marks the row succeeded', async () => {
    const r = await adapter.publish(env('idem-direct-ack'));
    await adapter.ack(r.jobId);

    const row = await fx.db
      .selectFrom('jobs')
      .select(['status'])
      .where('id', '=', r.jobId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('succeeded');

    rmSync(baseDir, { recursive: true, force: true });
  });

  test('direct adapter.nack with transient error → row pending + not_before set + last_error', async () => {
    const r = await adapter.publish(env('idem-direct-nack-transient'));
    // attempt is still 0 in the DB (subscribe loop's UPDATE bumps it; direct
    // nack mirrors that: decideRetry uses row.attempt and respects maxAttempts).
    const transient = (() => {
      const e = new Error('ECONNREFUSED 127.0.0.1:5432');
      e.name = 'NetworkError';
      return e;
    })();
    await adapter.nack(r.jobId, transient);

    const row = await fx.db
      .selectFrom('jobs')
      .select(['status', 'not_before', 'last_error'])
      .where('id', '=', r.jobId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.not_before).not.toBeNull();
    expect(row.last_error).toContain('ECONNREFUSED');

    rmSync(baseDir, { recursive: true, force: true });
  });

  test('direct adapter.nack with terminal error → row failed_terminal', async () => {
    const r = await adapter.publish(env('idem-direct-nack-terminal'));
    const terminal = new ScopeDenyError('denied_by_rule', ['rule-1']);
    await adapter.nack(r.jobId, terminal);

    const row = await fx.db
      .selectFrom('jobs')
      .select(['status', 'last_error'])
      .where('id', '=', r.jobId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('failed_terminal');
    expect(row.last_error).toContain('denied_by_rule');

    rmSync(baseDir, { recursive: true, force: true });
  });

  test('direct adapter.nack on nonexistent jobId is a no-op', async () => {
    // Defensive: nack should not throw if the row was already consumed/deleted.
    await adapter.nack(uniqId(), new Error('whatever'));
    // No assertion needed beyond not throwing.
    expect(true).toBe(true);

    rmSync(baseDir, { recursive: true, force: true });
  });

  test('attempts exhausted → failed_transient (boundary case for decideRetry)', async () => {
    // Publish with max_attempts=1 so a single nack exhausts.
    const e: JobEnvelope = { ...env('idem-exhausted'), maxAttempts: 1 };
    const r = await adapter.publish(e);
    // Bump attempt to 1 to simulate one failed attempt prior to nack.
    await fx.db.updateTable('jobs').set({ attempt: 1 }).where('id', '=', r.jobId).execute();
    const transient = (() => {
      const err = new Error('ETIMEDOUT');
      err.name = 'TimeoutError';
      return err;
    })();
    await adapter.nack(r.jobId, transient);

    const row = await fx.db
      .selectFrom('jobs')
      .select(['status'])
      .where('id', '=', r.jobId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('failed_transient');

    rmSync(baseDir, { recursive: true, force: true });
  });

  test('handler-thrown malformed-payload row → failed_terminal via parseEnvelope path', async () => {
    // F3 — exercise the safeJsonParse + parseEnvelope failure branch in
    // runHandler. Insert a jobs row with a malformed payload directly.
    const inserted = await fx.db
      .insertInto('jobs')
      .values({
        tenant_id: tenantId,
        project_id: null,
        assessment_id: assessmentId,
        kind: 'validate.finding',
        status: 'pending',
        attempt: 0,
        max_attempts: 3,
        idempotency_key: 'idem-malformed-payload',
        not_before: null,
        trace_id: 'trace-mal',
        // biome-ignore lint/suspicious/noExplicitAny: pg expects text for jsonb.
        payload: '"this is a string, not a valid envelope object"' as any,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    let invocations = 0;
    const sub = adapter.subscribe(
      'validate.finding',
      async () => {
        invocations += 1;
        return { kind: 'ack' };
      },
      { tenantId, pollIntervalMs: 30 },
    );
    await new Promise((r) => setTimeout(r, 400));
    await sub.stop({ timeoutMs: 200 });

    // Handler MUST NOT have been invoked (the row never gets to the user
    // handler — the parseEnvelope branch fails first inside runHandler).
    expect(invocations).toBe(0);

    const row = await fx.db
      .selectFrom('jobs')
      .select(['status', 'last_error'])
      .where('id', '=', inserted.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('failed_terminal');
    expect(row.last_error).toBeTruthy();

    rmSync(baseDir, { recursive: true, force: true });
  });
});
