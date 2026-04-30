// Sprint 16 — SPA route discovery integration tests.
//
// Uses RealBrowserDriver (Playwright) + SPA lab fixture. Exercises the
// full SPA discovery pipeline: pushState observation, artifact persistence,
// OOS-skipped route, and depth budget enforcement.
//
// P27: resetAuthState called ×2 (beforeAll + beforeEach).
// skipIf: requires DATABASE_URL (Playwright tests skipped in sandbox).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RealBrowserDriver, handleReconBrowser } from '@cyberstrike/browser-worker';
import type { JobEnvelope } from '@cyberstrike/queue';
import {
  DEFAULT_PLATFORM_POLICY,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { startSpaLab } from '../../lab/spa-fixture/index.ts';
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
} from './helpers.ts';

const TRACE_ID = '0123456789abcdef0123456789abcdef';

const skip = !hasDatabaseUrl();

describe.skipIf(skip)('browser :: spa-discovery (A-16-Spa*)', () => {
  let fx: DbFixture;
  let tenantId: string;

  beforeAll(async () => {
    fx = await createFixture();
    await dropAllTables(fx);
    await applyAllMigrations(fx);
    // P27: resetAuthState in beforeAll.
    await resetAuthState(fx.db);
  });

  afterAll(async () => {
    await dropAllTables(fx);
    await fx.db.destroy();
  });

  beforeEach(async () => {
    // P27: resetAuthState in beforeEach.
    await resetAuthState(fx.db);
    tenantId = uniqUuid();
    await fx.db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
      .execute();
  });

  test('A-16-SpaFixtureUp — healthz 200', async () => {
    const lab = await startSpaLab(0);
    try {
      const res = await fetch(`${lab.origin}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await lab.stop();
    }
  });

  test('A-16-SpaRouteDiscovery — navigate /, maxSpaDepth:1 → 2 SPA observation rows', async () => {
    const lab = await startSpaLab(0);
    try {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-spa' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: `${lab.origin}/`,
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

      const driver = new RealBrowserDriver({
        maxSpaDepth: 1,
        scopeCheck: async (url) => {
          const scope = await buildScope();
          const { checkNavigation } = await import('@cyberstrike/browser-worker');
          const decision = await checkNavigation(scope, url, stubBrowserScopeDeps);
          if (!decision.allowed) throw new Error(`oos:${url}`);
        },
        randomUUID: () => crypto.randomUUID(),
      });

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'recon.browser',
        idempotencyKey: `recon.browser:spa-discovery-${uniqUuid()}`,
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: TRACE_ID,
        payload: {
          tenantId,
          projectId,
          assessmentId,
          targetId,
          startUrl: `${lab.origin}/`,
          traceId: TRACE_ID,
        },
      };

      const out = await handleReconBrowser(
        {
          driver,
          objectStorage: storage,
          buildScope: buildScope as (assessmentId: string) => Promise<never>,
          scopeDeps: stubBrowserScopeDeps,
          auditEmitter: buildAuditEmitter(fx.db),
          observationWriter: buildObservationWriter(fx.db),
          payloadSchema: (await import('@cyberstrike/browser-worker')).reconBrowserPayloadSchema,
        },
        env,
      );
      expect(out.kind).toBe('ack');

      // Should have initial nav row + 2 SPA rows (/about + /contact).
      const obs = await fx.db
        .selectFrom('observations_browser')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .orderBy('observed_at', 'asc')
        .execute();
      expect(obs.length).toBe(3);

      const spaObs = obs.filter((r) => r.depth === 1);
      expect(spaObs.length).toBe(2);
      const spaUrls = spaObs.map((r) => r.url).sort();
      expect(spaUrls.some((u) => u.includes('/about'))).toBe(true);
      expect(spaUrls.some((u) => u.includes('/contact'))).toBe(true);
      for (const row of spaObs) {
        expect(row.source_url).toBeTruthy();
        expect(row.discovery_method).toBe('pushstate');
        expect(row.depth).toBe(1);
      }

      // Audit events include browser.spa.route.discovered ×2.
      const audits = await fx.db
        .selectFrom('audit_events')
        .select(['action'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      const actions = audits.map((a) => a.action);
      const spaDiscovered = actions.filter((a) => a === 'browser.spa.route.discovered');
      expect(spaDiscovered.length).toBe(2);
    } finally {
      await lab.stop();
    }
  }, 60_000);

  test('A-16-ArtifactRoundTrip — SPA route screenshot sha256 round-trip', async () => {
    const lab = await startSpaLab(0);
    try {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-art' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: `${lab.origin}/`,
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

      const driver = new RealBrowserDriver({
        maxSpaDepth: 1,
        scopeCheck: async (url) => {
          const scope = await buildScope();
          const { checkNavigation } = await import('@cyberstrike/browser-worker');
          const decision = await checkNavigation(scope, url, stubBrowserScopeDeps);
          if (!decision.allowed) throw new Error(`oos:${url}`);
        },
      });

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'recon.browser',
        idempotencyKey: `recon.browser:spa-art-${uniqUuid()}`,
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: TRACE_ID,
        payload: {
          tenantId,
          projectId,
          assessmentId,
          targetId,
          startUrl: `${lab.origin}/`,
          traceId: TRACE_ID,
        },
      };

      const out = await handleReconBrowser(
        {
          driver,
          objectStorage: storage,
          buildScope: buildScope as (assessmentId: string) => Promise<never>,
          scopeDeps: stubBrowserScopeDeps,
          auditEmitter: buildAuditEmitter(fx.db),
          observationWriter: buildObservationWriter(fx.db),
          payloadSchema: (await import('@cyberstrike/browser-worker')).reconBrowserPayloadSchema,
        },
        env,
      );
      expect(out.kind).toBe('ack');

      // Pick the first SPA observation and verify screenshot sha256 round-trip.
      const spaRow = await fx.db
        .selectFrom('observations_browser')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('depth', '=', 1)
        .executeTakeFirstOrThrow();

      const screenshotBytes = await storage.get(spaRow.screenshot_object_key);
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(screenshotBytes);
      expect(hasher.digest('hex')).toBe(spaRow.screenshot_sha256);
      expect(screenshotBytes.byteLength).toBe(Number(spaRow.screenshot_size_bytes));
    } finally {
      await lab.stop();
    }
  }, 60_000);

  test('A-16-OosRouteSkipped — scopeCheck denies /about → skipped_oos audit, /contact row present', async () => {
    const lab = await startSpaLab(0);
    try {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-oos' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: `${lab.origin}/`,
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

      // scopeCheck rejects /about specifically.
      const scopeCheck = async (url: string): Promise<void> => {
        if (url.includes('/about')) throw new Error('oos:about_denied');
      };

      const driver = new RealBrowserDriver({ maxSpaDepth: 1, scopeCheck });

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

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'recon.browser',
        idempotencyKey: `recon.browser:spa-oos-${uniqUuid()}`,
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: TRACE_ID,
        payload: {
          tenantId,
          projectId,
          assessmentId,
          targetId,
          startUrl: `${lab.origin}/`,
          traceId: TRACE_ID,
        },
      };

      const out = await handleReconBrowser(
        {
          driver,
          objectStorage: storage,
          buildScope: buildScope as (assessmentId: string) => Promise<never>,
          scopeDeps: stubBrowserScopeDeps,
          auditEmitter: buildAuditEmitter(fx.db),
          observationWriter: buildObservationWriter(fx.db),
          payloadSchema: (await import('@cyberstrike/browser-worker')).reconBrowserPayloadSchema,
        },
        env,
      );
      expect(out.kind).toBe('ack');

      // No observation row for /about.
      const aboutObs = await fx.db
        .selectFrom('observations_browser')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('url', 'like', '%/about%')
        .execute();
      expect(aboutObs.length).toBe(0);

      // /contact row exists (depth=1).
      const contactObs = await fx.db
        .selectFrom('observations_browser')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('url', 'like', '%/contact%')
        .execute();
      expect(contactObs.length).toBe(1);

      // browser.spa.route.skipped_oos audit fired ×1.
      const audits = await fx.db
        .selectFrom('audit_events')
        .select(['action'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      const actions = audits.map((a) => a.action);
      expect(actions.filter((a) => a === 'browser.spa.route.skipped_oos').length).toBe(1);
    } finally {
      await lab.stop();
    }
  }, 60_000);

  test('A-16-DepthBudget — maxSpaDepth:1 → no /about/team row (depth-2)', async () => {
    const lab = await startSpaLab(0);
    try {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-depth' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: `${lab.origin}/`,
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

      const driver = new RealBrowserDriver({
        maxSpaDepth: 1,
        scopeCheck: async (url) => {
          const scope = await buildScope();
          const { checkNavigation } = await import('@cyberstrike/browser-worker');
          const decision = await checkNavigation(scope, url, stubBrowserScopeDeps);
          if (!decision.allowed) throw new Error(`oos:${url}`);
        },
      });

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'recon.browser',
        idempotencyKey: `recon.browser:spa-depth-${uniqUuid()}`,
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: TRACE_ID,
        payload: {
          tenantId,
          projectId,
          assessmentId,
          targetId,
          startUrl: `${lab.origin}/`,
          traceId: TRACE_ID,
        },
      };

      const out = await handleReconBrowser(
        {
          driver,
          objectStorage: storage,
          buildScope: buildScope as (assessmentId: string) => Promise<never>,
          scopeDeps: stubBrowserScopeDeps,
          auditEmitter: buildAuditEmitter(fx.db),
          observationWriter: buildObservationWriter(fx.db),
          payloadSchema: (await import('@cyberstrike/browser-worker')).reconBrowserPayloadSchema,
        },
        env,
      );
      expect(out.kind).toBe('ack');

      // /about/team must NOT have an observation row (depth=2 > maxSpaDepth=1).
      const teamObs = await fx.db
        .selectFrom('observations_browser')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('url', 'like', '%/about/team%')
        .execute();
      expect(teamObs.length).toBe(0);

      // /about (depth=1) must have a row.
      const aboutObs = await fx.db
        .selectFrom('observations_browser')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .where('url', 'like', '%about%')
        .execute();
      const aboutSpa = aboutObs.filter((r) => r.depth === 1);
      expect(aboutSpa.length).toBe(1);
    } finally {
      await lab.stop();
    }
  }, 60_000);
});
