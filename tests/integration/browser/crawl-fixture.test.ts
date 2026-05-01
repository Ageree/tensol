// Sprint 9 §A-BR-Run, A-BR-Artifacts, A-BR-Timeline, A-BR-Pitfall-JSONB.
//
// Boot the lab → start an approved assessment → invoke the browser worker
// directly (mirrors Sprint 8 IT pattern). Assert exactly one
// observations_browser row, valid sha256 + sizeBytes for all three
// artefacts, JSONB console_messages round-trip, lifecycle audit rows.

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
import {
  allowLocalhostLabScopeRules,
  buildBrowserHandlerDeps,
  buildLocalStorage,
  uniqUuid,
  withLab,
} from './helpers.ts';

describe.skipIf(!hasDatabaseUrl())(
  'browser :: crawl-fixture (A-BR-Run, A-BR-Artifacts, A-BR-Timeline)',
  () => {
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

    test('produces ONE observations_browser row with valid sha256 + JSONB console + lifecycle audits', async () => {
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
        const projectId = await seedProject(fx, { tenantId, name: 'P-browser' });
        const targetId = await seedTarget(fx, {
          tenantId,
          projectId,
          kind: 'url',
          value: `${lab.origin}/search?q=test`,
          ownershipStatus: 'verified',
        });
        const assessmentId = await seedAssessment(fx, {
          tenantId,
          projectId,
          createdBy: userId,
          state: 'running',
          targetIds: [targetId],
          scopeRules: allowLocalhostLabScopeRules(lab.port) as ReadonlyArray<{
            ruleKind: string;
            effect: 'allow' | 'deny';
            payload: unknown;
          }>,
        });

        const { storage } = buildLocalStorage();
        const startUrl = `${lab.origin}/search?q=hello`;

        // Build a scope that explicitly allows the dynamic lab port. The
        // FakeBrowserDriver uses real Bun fetch against localhost:<labPort>;
        // the scope-engine separately validates the URL via the rules.
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
              {
                id: 'r5',
                ruleKind: 'http_method',
                effect: 'allow',
                payload: { method: 'GET' },
              },
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
          kind: 'assessment.start',
          idempotencyKey: 'recon.browser:crawl-1',
          createdAt: new Date().toISOString(),
          attempt: 0,
          maxAttempts: 3,
          traceId: '0123456789abcdef0123456789abcdef',
          payload: {
            tenantId,
            projectId,
            assessmentId,
            targetId,
            startUrl,
            traceId: '0123456789abcdef0123456789abcdef',
          },
        };

        const out = await handleReconBrowser(deps, env);
        expect(out.kind).toBe('ack');

        // A-BR-Run + A-BR-Artifacts: exactly ONE observations_browser row.
        const obs = await fx.db
          .selectFrom('observations_browser')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('assessment_id', '=', assessmentId)
          .execute();
        expect(obs.length).toBe(1);
        const row = obs[0];
        if (!row) throw new Error('expected observation row');
        expect(row.url).toContain(`${lab.origin}/search`);
        expect(row.screenshot_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(row.har_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(row.trace_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(Number(row.screenshot_size_bytes)).toBeGreaterThan(0);
        expect(Number(row.har_size_bytes)).toBeGreaterThan(0);
        expect(Number(row.trace_size_bytes)).toBeGreaterThan(0);
        expect(row.http_status).toBe(200);

        // A-BR-Pitfall-JSONB: console_messages round-trips a non-empty array.
        const consoleMsgs = row.console_messages as ReadonlyArray<{
          level: string;
          text: string;
        }>;
        expect(Array.isArray(consoleMsgs)).toBe(true);
        expect(consoleMsgs.length).toBeGreaterThanOrEqual(1);
        expect(consoleMsgs[0]?.text).toContain('navigated:');

        // A-BR-Artifacts: object-storage round-trip → bytes hash to the
        // persisted sha256.
        const screenshotBytes = await storage.get(row.screenshot_object_key);
        const screenshotHasher = new Bun.CryptoHasher('sha256');
        screenshotHasher.update(screenshotBytes);
        expect(screenshotHasher.digest('hex')).toBe(row.screenshot_sha256);
        expect(screenshotBytes.byteLength).toBe(Number(row.screenshot_size_bytes));

        // A-BR-Timeline: lifecycle audit rows present.
        const audits = await fx.db
          .selectFrom('audit_events')
          .select(['action'])
          .where('tenant_id', '=', tenantId)
          .where('assessment_id', '=', assessmentId)
          .execute();
        const actions = audits.map((a) => a.action);
        expect(actions).toContain('recon.browser.job.started');
        expect(actions).toContain('recon.browser.observation.persisted');
        expect(actions).toContain('recon.browser.job.completed');
        expect(actions).not.toContain('recon.browser.navigation.denied');
        expect(actions).not.toContain('recon.browser.job.failed');

        // Lab fixture saw exactly one /search hit.
        expect(lab.handle.getCounters().search).toBe(1);
      });
    });
  },
);
