// Sprint 9 §A-BR-RetryPolicy IT (codex iter-2 P1 hardened).
//
// Replaces the iter-1 manual handler re-drive with a real LocalQueueAdapter
// retry cycle so the queue's `decideRetry` classifier path is bound:
//   1. Publish recon.browser envelope.
//   2. Subscribe handler that throws BrowserTimeoutError on first attempt
//      then succeeds on second.
//   3. Assert jobs row goes pending → running → pending(not_before set) →
//      running → succeeded; final attempt count ≥ 2.
//
// Closes the codex P1: verifies that BrowserTimeoutError flows through
// `classifyError` as 'transient' (Sprint 9 codex iter-2 retry-classifier
// extension) instead of defaulting to terminal.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserTimeoutError,
  FakeBrowserDriver,
  handleReconBrowser,
  reconBrowserPayloadSchema,
} from '@cyberstrike/coordinator/browser';
import { type JobEnvelope, LocalQueueAdapter } from '@cyberstrike/queue';
import {
  DEFAULT_PLATFORM_POLICY,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { hasDatabaseUrl, resetAuthState } from '../auth/helpers/auth-fixture.ts';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedAssessment,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';
import {
  buildAuditEmitter,
  buildLocalStorage,
  buildObservationWriter,
  stubBrowserScopeDeps,
  uniqUuid,
  withLab,
} from './helpers.ts';

describe.skipIf(!hasDatabaseUrl())('browser :: retry-transient (A-BR-RetryPolicy)', () => {
  let fx: DbFixture;
  let tenantId: string;

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
    tenantId = uniqUuid();
    await fx.db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
      .execute();
  });

  test('LocalQueueAdapter retries on BrowserTimeoutError → succeeds on second attempt', async () => {
    await withLab(async (lab) => {
      const userId = uniqUuid();
      await fx.db
        .insertInto('users')
        .values({
          id: userId,
          tenant_id: tenantId,
          email: `u-${userId.slice(0, 8)}@example.com`,
          display_name: `u-${userId.slice(0, 8)}`,
          status: 'active',
          role: 'security_lead',
          password_hash: 'x',
        })
        .execute();
      const projectId = await seedProject(fx, { tenantId, name: 'P-retry' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: `${lab.origin}/search?q=retry`,
        ownershipStatus: 'verified',
      });
      const assessmentId = await seedAssessment(fx, {
        tenantId,
        projectId,
        createdBy: userId,
        state: 'running',
        targetIds: [targetId],
      });

      const baseDir = mkdtempSync(join(tmpdir(), 'cs-bw-retry-q-'));
      const queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir });
      const { storage } = buildLocalStorage();

      let fired = 0;
      const oneShotLaunchFault = (): Error | null => {
        fired += 1;
        if (fired === 1) return new BrowserTimeoutError('flaky_first_attempt');
        return null;
      };
      const driver = new FakeBrowserDriver({ oneShotLaunchFault });

      const buildScope = async (): Promise<ReturnType<typeof buildEffectiveScope>> =>
        buildEffectiveScope({
          tenantId,
          assessmentId,
          tenantPolicy: { tenantId },
          platformPolicy: DEFAULT_PLATFORM_POLICY,
          rawRules: [
            {
              id: 'r1',
              ruleKind: 'domain',
              effect: 'allow',
              payload: { pattern: 'localhost', matchSubdomains: false },
            },
            { id: 'r2', ruleKind: 'ip', effect: 'allow', payload: { ip: '203.0.113.7' } },
            { id: 'r3', ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'http' } },
            { id: 'r4', ruleKind: 'port', effect: 'allow', payload: { port: lab.port } },
            { id: 'r5', ruleKind: 'http_method', effect: 'allow', payload: { method: 'GET' } },
            { id: 'r6', ruleKind: 'path_pattern', effect: 'allow', payload: { glob: '/**' } },
          ],
          toolCatalog: new Map<string, ToolPolicy>(),
          assessmentFlags: {
            highImpactCategories: [],
            ownershipVerifiedTargetIds: new Set([targetId]),
          },
          timeWindow: null,
        });

      const deps = {
        driver,
        objectStorage: storage,
        buildScope,
        scopeDeps: stubBrowserScopeDeps,
        auditEmitter: buildAuditEmitter(fx.db),
        observationWriter: buildObservationWriter(fx.db),
        payloadSchema: reconBrowserPayloadSchema,
      };

      // Publish through the real queue. maxAttempts=3 so a single
      // transient nack still leaves room for retry.
      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: 'recon.browser:retry-q-1',
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: '0123456789abcdef0123456789abcdef',
        payload: {
          tenantId,
          projectId,
          assessmentId,
          targetId,
          startUrl: `${lab.origin}/search?q=retry`,
          traceId: '0123456789abcdef0123456789abcdef',
        },
      };
      const publishResult = await queueAdapter.publish(env);
      const jobId = publishResult.jobId;

      const sub = queueAdapter.subscribe(
        'assessment.start',
        async (e) => handleReconBrowser(deps, e),
        { tenantId, pollIntervalMs: 25 },
      );

      const readJob = async (): Promise<{ status: string; attempt: number }> => {
        const row = await fx.db
          .selectFrom('jobs')
          .select(['status', 'attempt'])
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow();
        return { status: String(row.status), attempt: Number(row.attempt) };
      };

      const waitFor = async (
        predicate: (j: { status: string; attempt: number }) => boolean,
        timeoutMs: number,
      ): Promise<{ status: string; attempt: number }> => {
        const deadline = Date.now() + timeoutMs;
        let last = await readJob();
        while (Date.now() < deadline) {
          if (predicate(last)) return last;
          await new Promise((r) => setTimeout(r, 20));
          last = await readJob();
        }
        return last;
      };

      // Step A: first attempt nacks transient → row back to pending with
      // attempt=1. The classifier MUST recognize BrowserTimeoutError as
      // 'transient'; otherwise the row would be `failed_terminal` and
      // this assertion fails (which is exactly the codex P1 we're fixing).
      const afterFail = await waitFor((j) => j.attempt >= 1, 2500);
      expect(afterFail.status).toBe('pending');
      expect(afterFail.attempt).toBeGreaterThanOrEqual(1);

      // Clear `not_before` to skip the exponential-backoff wait — the
      // classifier path is what we're testing, not the timer arithmetic
      // (covered by Sprint 7 retry-classifier unit tests).
      await fx.db.updateTable('jobs').set({ not_before: null }).where('id', '=', jobId).execute();

      // Step B: second attempt should succeed.
      const afterSuccess = await waitFor((j) => j.status === 'succeeded', 3000);
      await sub.stop({ timeoutMs: 500 });

      expect(afterSuccess.status).toBe('succeeded');
      expect(afterSuccess.attempt).toBeGreaterThanOrEqual(2);

      // Observation row landed on retry attempt.
      const obsCount = await fx.db
        .selectFrom('observations_browser')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .executeTakeFirstOrThrow();
      expect(Number(obsCount.c)).toBe(1);

      // Audit trail shows BOTH a job.failed (first attempt) AND a
      // job.completed (second attempt).
      const audits = await fx.db
        .selectFrom('audit_events')
        .select(['action'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      const actions = audits.map((a) => a.action);
      expect(actions).toContain('recon.browser.job.failed');
      expect(actions).toContain('recon.browser.job.completed');

      rmSync(baseDir, { recursive: true, force: true });
    });
  });
});
