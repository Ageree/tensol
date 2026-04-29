// Sprint 9 §A-BR-Scope, A-BR-NavBeforeFetch (IT half).
//
// Lab `/redirect-evil` returns 302 to https://evil.example/. The worker
// fetches the redirect destination URL through the scope-guard BEFORE
// issuing any follow-up request → deny → recon.browser.navigation.denied
// audit row written, NO observations_browser row created for evil.example,
// browser session aborted. The recording-fetch stub asserts evil.example
// was NEVER fetched (closes the TOCTOU window).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleReconBrowser } from '@cyberstrike/browser-worker';
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

describe.skipIf(!hasDatabaseUrl())(
  'browser :: scope-deny-redirect (A-BR-Scope, A-BR-NavBeforeFetch IT half)',
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

    test('redirect to evil.example → deny audit, no observation, evil.example never fetched', async () => {
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
        const projectId = await seedProject(fx, { tenantId, name: 'P-deny' });
        const targetId = await seedTarget(fx, {
          tenantId,
          projectId,
          kind: 'url',
          value: `${lab.origin}/redirect-evil`,
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
        const startUrl = `${lab.origin}/redirect-evil`;

        // Recording fetch — wraps the real fetch but COUNTS calls per host
        // so we can assert evil.example was never contacted.
        const fetchedUrls: string[] = [];
        const recordingFetch: typeof globalThis.fetch = (async (
          input: string | URL | Request,
          init?: RequestInit,
        ) => {
          const u =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          fetchedUrls.push(u);
          return globalThis.fetch(input as never, init);
        }) as unknown as typeof globalThis.fetch;

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
              // Explicit deny for evil.example so the redirect target is denied.
              {
                id: 'd1',
                ruleKind: 'domain',
                effect: 'deny',
                payload: { pattern: 'evil.example', matchSubdomains: false },
              },
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
          recordingFetch,
        });

        const env: JobEnvelope = {
          jobId: uniqUuid(),
          tenantId,
          projectId,
          assessmentId,
          kind: 'recon.browser',
          idempotencyKey: 'recon.browser:deny-1',
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
        expect(out.kind).toBe('nack');
        // Terminal classification (ScopeDenyError carries __terminal:true).
        expect(out.kind === 'nack' && (out.error as { __terminal?: boolean }).__terminal).toBe(
          true,
        );

        // A-BR-Scope: NO observations_browser row written.
        const obs = await fx.db
          .selectFrom('observations_browser')
          .select((eb) => eb.fn.countAll<string>().as('c'))
          .where('tenant_id', '=', tenantId)
          .where('assessment_id', '=', assessmentId)
          .executeTakeFirstOrThrow();
        expect(Number(obs.c)).toBe(0);

        // A-BR-Scope: deny audit row present.
        const audits = await fx.db
          .selectFrom('audit_events')
          .select(['action'])
          .where('tenant_id', '=', tenantId)
          .where('assessment_id', '=', assessmentId)
          .execute();
        const actions = audits.map((a) => a.action);
        expect(actions).toContain('recon.browser.navigation.denied');

        // A-BR-NavBeforeFetch IT half: evil.example was NEVER fetched.
        const reachedEvil = fetchedUrls.some((u) => u.includes('evil.example'));
        expect(reachedEvil).toBe(false);

        // Lab `/redirect-evil` was hit at most once (the initial nav). The
        // worker may not even have hit it if the scope-engine rejected the
        // raw startUrl outright; either way, evil.example stays uncontacted.
        expect(lab.handle.getCounters().redirectEvil).toBeLessThanOrEqual(1);
      });
    });
  },
);
