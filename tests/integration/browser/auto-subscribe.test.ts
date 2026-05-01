// Sprint 9 codex iter-3 P1 — auto-subscribe wire-up.
//
// Proves that `createCoordinator({browserHandler})` automatically
// consumes `recon.browser` jobs published by the assessment.start handler.
// No manual `adapter.subscribe('recon.browser', ...)` in this test —
// only the coordinator wiring. If the auto-subscribe is missing, the
// recon.browser job stays `pending` forever and the assertion times out.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleReconBrowser, reconBrowserPayloadSchema } from '@cyberstrike/coordinator/browser';
import { FakeBrowserDriver } from '@cyberstrike/coordinator/browser';
import { createCoordinator } from '@cyberstrike/coordinator';
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

describe.skipIf(!hasDatabaseUrl())('browser :: auto-subscribe (codex iter-3 P1)', () => {
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

  test('createCoordinator({browserHandler}) auto-consumes recon.browser jobs end-to-end', async () => {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-auto' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: `${lab.origin}/search?q=auto`,
        ownershipStatus: 'verified',
      });
      const assessmentId = await seedAssessment(fx, {
        tenantId,
        projectId,
        createdBy: userId,
        state: 'running',
        targetIds: [targetId],
      });

      const baseDir = mkdtempSync(join(tmpdir(), 'cs-bw-auto-q-'));
      const queueAdapter = new LocalQueueAdapter({ db: fx.db, baseDir });
      const { storage } = buildLocalStorage();

      const driver = new FakeBrowserDriver();

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

      // Pre-bind the worker handler — the coordinator only sees a
      // `Handler` shape, not the full BrowserWorkerDeps surface.
      const browserWorkerDeps = {
        driver,
        objectStorage: storage,
        buildScope,
        scopeDeps: stubBrowserScopeDeps,
        auditEmitter: buildAuditEmitter(fx.db),
        observationWriter: buildObservationWriter(fx.db),
        payloadSchema: reconBrowserPayloadSchema,
      };

      const coordinator = createCoordinator({
        db: fx.db,
        adapter: queueAdapter,
        scopeDeps: stubBrowserScopeDeps,
        buildScope,
        browserHandler: (env) => handleReconBrowser(browserWorkerDeps, env),
        pollIntervalMs: 25,
        tenantFilter: tenantId,
      });
      coordinator.start();

      // Publish a recon.browser envelope directly (skipping the
      // assessment.start path) so we exercise just the auto-subscribe
      // wire-up. The coordinator's recon.browser subscriber should pick
      // this up without any manual subscribe call in this test.
      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: 'recon.browser:auto-1',
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: '0123456789abcdef0123456789abcdef',
        payload: {
          tenantId,
          projectId,
          assessmentId,
          targetId,
          startUrl: `${lab.origin}/search?q=auto`,
          traceId: '0123456789abcdef0123456789abcdef',
        },
      };
      const publishResult = await queueAdapter.publish(env);
      const jobId = publishResult.jobId;

      const readJobStatus = async (): Promise<string> => {
        const row = await fx.db
          .selectFrom('jobs')
          .select(['status'])
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow();
        return String(row.status);
      };

      const deadline = Date.now() + 3000;
      let status = await readJobStatus();
      while (Date.now() < deadline && status !== 'succeeded') {
        await new Promise((r) => setTimeout(r, 25));
        status = await readJobStatus();
      }

      await coordinator.stop({ timeoutMs: 500 });

      expect(status).toBe('succeeded');

      // End-to-end side effect: observation row landed.
      const obsCount = await fx.db
        .selectFrom('observations_browser')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .executeTakeFirstOrThrow();
      expect(Number(obsCount.c)).toBe(1);

      rmSync(baseDir, { recursive: true, force: true });
    });
  });
});
