// Sprint 9 §A-BR-Timeline.
//
// After a happy-path crawl, GET /assessments/:id/timeline (Sprint 5 route)
// returns audit rows including the 3 lifecycle actions. Read piggy-backs
// on the existing timeline route — no route-layer changes required.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleReconBrowser } from '@cyberstrike/coordinator/browser';
import type { JobEnvelope } from '@cyberstrike/queue';
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
import { buildBrowserHandlerDeps, buildLocalStorage, uniqUuid, withLab } from './helpers.ts';

describe.skipIf(!hasDatabaseUrl())('browser :: timeline (A-BR-Timeline)', () => {
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

  test('audit_events for the assessment include the 3 recon.browser lifecycle actions in chrono order', async () => {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-tl' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: `${lab.origin}/search?q=tl`,
        ownershipStatus: 'verified',
      });
      const assessmentId = await seedAssessment(fx, {
        tenantId,
        projectId,
        createdBy: userId,
        state: 'running',
        targetIds: [targetId],
      });

      const { storage } = buildLocalStorage();

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

      const deps = buildBrowserHandlerDeps({
        db: fx.db,
        storage,
        buildScope,
      });

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'recon.browser',
        idempotencyKey: 'recon.browser:timeline-1',
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: '0123456789abcdef0123456789abcdef',
        payload: {
          tenantId,
          projectId,
          assessmentId,
          targetId,
          startUrl: `${lab.origin}/search?q=tl`,
          traceId: '0123456789abcdef0123456789abcdef',
        },
      };

      const out = await handleReconBrowser(deps, env);
      expect(out.kind).toBe('ack');

      const audits = await fx.db
        .selectFrom('audit_events')
        .select(['action', 'occurred_at'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .orderBy('occurred_at', 'asc')
        .execute();
      const actions = audits.map((a) => a.action);
      // Strictly the 3 success-path actions appear in this order.
      const browserActions = actions.filter((a) => a.startsWith('recon.browser.'));
      expect(browserActions[0]).toBe('recon.browser.job.started');
      expect(browserActions[browserActions.length - 1]).toBe('recon.browser.job.completed');
      expect(browserActions).toContain('recon.browser.observation.persisted');
    });
  });
});
