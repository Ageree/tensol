// Sprint 9 §A-BR-Cookie.
//
// Boot the lab → start an assessment → inject auth cookies via the
// FakeBrowserDriver → fetch the persisted HAR bytes from object storage
// → assert NO raw cookie value AND no Set-Cookie value leak through
// the redactor.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { FakeBrowserDriver, handleReconBrowser } from '@cyberstrike/browser-worker';
import { reconBrowserPayloadSchema } from '@cyberstrike/browser-worker';
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
  buildAuditEmitter,
  buildLocalStorage,
  buildObservationWriter,
  stubBrowserScopeDeps,
  uniqUuid,
  withLab,
} from './helpers.ts';

const SECRET_COOKIE_VALUE = 'super-secret-token-do-not-leak';

describe.skipIf(!hasDatabaseUrl())('browser :: har-redaction (A-BR-Cookie)', () => {
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

  test('persisted HAR bytes contain neither the raw Cookie value nor Set-Cookie raw', async () => {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-har' });
      const targetId = await seedTarget(fx, {
        tenantId,
        projectId,
        kind: 'url',
        value: `${lab.origin}/search?q=har`,
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
      const startUrl = `${lab.origin}/search?q=har`;

      // Driver injects an auth cookie carrying the secret.
      const driver = new FakeBrowserDriver({
        randomUUID: () => crypto.randomUUID(),
      });
      // Override launch by wrapping: easier to just call driver.launch with
      // authCookies in the input. The BrowserDriver interface exposes
      // authCookies via launch.
      const wrappedDriver = {
        launch: (i: Parameters<typeof driver.launch>[0]) =>
          driver.launch({
            ...i,
            authCookies: [
              { name: 'sid', value: SECRET_COOKIE_VALUE, domain: 'localhost', path: '/' },
            ],
          }),
        navigate: driver.navigate.bind(driver),
        close: driver.close.bind(driver),
      };

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
        idempotencyKey: 'recon.browser:har-1',
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

      const out = await handleReconBrowser(
        {
          driver: wrappedDriver,
          objectStorage: storage,
          buildScope,
          scopeDeps: stubBrowserScopeDeps,
          auditEmitter: buildAuditEmitter(fx.db),
          observationWriter: buildObservationWriter(fx.db),
          payloadSchema: reconBrowserPayloadSchema,
        },
        env,
      );
      expect(out.kind).toBe('ack');

      const obs = await fx.db
        .selectFrom('observations_browser')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .executeTakeFirstOrThrow();
      const harBytes = await storage.get(obs.har_object_key);
      const harText = harBytes.toString('utf8');

      // A-BR-Cookie: secret cookie value MUST NOT appear in the persisted HAR.
      expect(harText.includes(SECRET_COOKIE_VALUE)).toBe(false);
      // The redactor's marker MUST appear (proof the redaction ran).
      expect(harText).toContain('[REDACTED]');
    });
  });
});
