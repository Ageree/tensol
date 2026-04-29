// Sprint 7 §5.3 A-Q-Local-2..3 — happy path: publish → subscribe → ack.
// Also covers A-Q-Audit-2 inline note: allow-path emits NO coordinator audit.

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

describe.skipIf(!hasDatabaseUrl())('queue :: publish-consume happy path (A-Q-Local-2..3)', () => {
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
    baseDir = mkdtempSync(join(tmpdir(), 'cs-queue-pc-'));
    adapter = new LocalQueueAdapter({ db: fx.db, baseDir });
    const ctx = await seedMinimalAssessmentContext(fx);
    tenantId = ctx.tenantId;
    assessmentId = ctx.assessmentId;
  });

  const envelopeWithIds = (idem: string): JobEnvelope => ({
    jobId: uniqId(),
    tenantId,
    projectId: null,
    assessmentId,
    kind: 'recon.browser.placeholder',
    idempotencyKey: idem,
    createdAt: new Date().toISOString(),
    attempt: 0,
    maxAttempts: 3,
    traceId: `trace-${idem}`,
    payload: {
      targetId: uniqId(),
      targetUrl: 'https://example.com',
      parentJobId: uniqId(),
    },
  });

  test('publish inserts pending row, subscribe claims → ack → succeeded', async () => {
    const env = envelopeWithIds('idem-pc-1');
    const result = await adapter.publish(env);
    expect(result.deduped).toBe(false);
    expect(result.jobId).toBeTruthy();

    // Verify pending row exists.
    const pre = await fx.db
      .selectFrom('jobs')
      .select(['status', 'attempt'])
      .where('id', '=', result.jobId)
      .executeTakeFirstOrThrow();
    expect(pre.status).toBe('pending');
    expect(pre.attempt).toBe(0);

    // Subscribe + ack.
    const seen: JobEnvelope[] = [];
    const sub = adapter.subscribe(
      'recon.browser.placeholder',
      async (env_) => {
        seen.push(env_);
        return { kind: 'ack' };
      },
      { tenantId, pollIntervalMs: 20 },
    );
    await new Promise((r) => setTimeout(r, 300));
    await sub.stop({ timeoutMs: 200 });

    expect(seen.length).toBe(1);
    expect(seen[0]?.jobId).toBe(env.jobId);

    const post = await fx.db
      .selectFrom('jobs')
      .select(['status', 'attempt'])
      .where('id', '=', result.jobId)
      .executeTakeFirstOrThrow();
    expect(post.status).toBe('succeeded');
    expect(post.attempt).toBe(1);

    rmSync(baseDir, { recursive: true, force: true });
  });

  test('payload survives JSON.stringify roundtrip (A-Q-DB-3)', async () => {
    const env = envelopeWithIds('idem-payload-roundtrip');
    const result = await adapter.publish(env);

    const row = await fx.db
      .selectFrom('jobs')
      .select(['payload'])
      .where('id', '=', result.jobId)
      .executeTakeFirstOrThrow();
    const persisted = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    expect(persisted).toMatchObject({
      jobId: env.jobId,
      tenantId: env.tenantId,
      assessmentId: env.assessmentId,
      kind: 'recon.browser.placeholder',
      idempotencyKey: 'idem-payload-roundtrip',
    });

    rmSync(baseDir, { recursive: true, force: true });
  });
});
