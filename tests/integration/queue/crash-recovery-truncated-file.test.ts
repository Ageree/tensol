// Sprint 7 §5.3 A-Q-Local-6 case B (R1) — file half-written / truncated JSONL.
//
// Scenario: write a complete JSONL row, then truncate mid-line. Restart
// subscribe loop. Assert (i) no parse-error crash, (ii) DB row claimed
// exactly once via SKIP LOCKED, (iii) no second row inserted.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, truncateSync } from 'node:fs';
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

describe.skipIf(!hasDatabaseUrl())(
  'queue :: crash recovery — truncated file (A-Q-Local-6 case B)',
  () => {
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
      baseDir = mkdtempSync(join(tmpdir(), 'cs-queue-cr-'));
      adapter = new LocalQueueAdapter({ db: fx.db, baseDir });
      const ctx = await seedMinimalAssessmentContext(fx);
      tenantId = ctx.tenantId;
      assessmentId = ctx.assessmentId;
    });

    test('truncated JSONL line does not crash subscribe loop; DB row still claimed exactly once', async () => {
      const env: JobEnvelope = {
        jobId: uniqId(),
        tenantId,
        projectId: null,
        assessmentId,
        kind: 'validate.finding',
        idempotencyKey: 'idem-trunc',
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: 'trace',
        payload: { targetId: uniqId(), targetUrl: 'https://e.com', parentJobId: uniqId() },
      };
      const result = await adapter.publish(env);

      // Truncate the JSONL file mid-line — simulating a crash mid-write.
      const filepath = join(baseDir, 'recon.browser.placeholder.queue');
      const stat = statSync(filepath);
      // Cut off the last 10 bytes; the trailing newline goes with them, leaving
      // a partial JSON suffix that JSON.parse would reject.
      truncateSync(filepath, Math.max(0, stat.size - 10));

      // Now run the subscribe loop. The adapter reads from DB, not file, so this
      // truncation should NOT prevent the row from being claimed exactly once.
      // The loop also must NOT crash if file contents were ever read for any
      // ancillary reason.
      let invocations = 0;
      const sub = adapter.subscribe(
        'recon.browser.placeholder',
        async () => {
          invocations += 1;
          return { kind: 'ack' };
        },
        { tenantId, pollIntervalMs: 50 },
      );
      await new Promise((r) => setTimeout(r, 600));
      await sub.stop({ timeoutMs: 200 });

      expect(invocations).toBe(1);

      // Confirm exactly one row, in succeeded state.
      const rows = await fx.db
        .selectFrom('jobs')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('idempotency_key', '=', 'idem-trunc')
        .execute();
      expect(rows.length).toBe(1);
      expect(rows[0]?.status).toBe('succeeded');
      expect(rows[0]?.id).toBe(result.jobId);

      rmSync(baseDir, { recursive: true, force: true });
    });

    test('file-write-failure injection (case A) — DB row still processed', async () => {
      // Test case A: file write throws. DB is canonical; the row should still be claimed.
      const failingWrite = (): Promise<void> => {
        throw new Error('simulated write failure');
      };
      const adapterB = new LocalQueueAdapter({ db: fx.db, baseDir, writeFile: failingWrite });

      const env: JobEnvelope = {
        jobId: uniqId(),
        tenantId,
        projectId: null,
        assessmentId,
        kind: 'validate.finding',
        idempotencyKey: 'idem-fwfail',
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: 'trace',
        payload: { targetId: uniqId(), targetUrl: 'https://e.com', parentJobId: uniqId() },
      };
      // Publish should still succeed (DB row inserted; file write fails silently).
      const result = await adapterB.publish(env);
      expect(result.deduped).toBe(false);

      // Subscribe should claim normally.
      let invocations = 0;
      const sub = adapterB.subscribe(
        'recon.browser.placeholder',
        async () => {
          invocations += 1;
          return { kind: 'ack' };
        },
        { tenantId, pollIntervalMs: 50 },
      );
      await new Promise((r) => setTimeout(r, 500));
      await sub.stop({ timeoutMs: 200 });
      expect(invocations).toBe(1);

      rmSync(baseDir, { recursive: true, force: true });
    });
  },
);
