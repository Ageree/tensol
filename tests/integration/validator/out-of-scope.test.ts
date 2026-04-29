// Sprint 10 §A-V-Scope — candidate against an out-of-scope URL. Validator
// runs scope-decide BEFORE driver call. Recording fetch stub asserts 0
// fetches against evil.example. Status `out_of_scope`, NO findings row,
// `validation.out_of_scope` audit emitted, handler returns ack.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JobEnvelope } from '@cyberstrike/queue';
import {
  DEFAULT_PLATFORM_POLICY,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { handleValidateFinding } from '@cyberstrike/validator-worker';
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
  buildLocalStorage,
  buildValidatorHandlerDeps,
  seedCandidateFinding,
  uniqUuid,
  withLab,
} from './helpers.ts';

describe.skipIf(!hasDatabaseUrl())('validator :: out-of-scope (A-V-Scope)', () => {
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

  test('out-of-scope candidate → out_of_scope, NO driver fetch against denied origin', async () => {
    await withLab(async (lab) => {
      const fetchedUrls: string[] = [];
      const recordingFetch: typeof globalThis.fetch = async (input): Promise<Response> => {
        const u = typeof input === 'string' ? input : input.toString();
        fetchedUrls.push(u);
        return globalThis.fetch(u);
      };

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
        value: `${lab.origin}/search`,
        ownershipStatus: 'verified',
      });
      const assessmentId = await seedAssessment(fx, {
        tenantId,
        projectId,
        createdBy: userId,
        state: 'running',
        targetIds: [targetId],
      });
      // Candidate references evil.example which is NOT covered by any
      // allow rule + an explicit deny for evil.example.
      const candidateId = await seedCandidateFinding(fx.db, {
        tenantId,
        assessmentId,
        affectedUrl: 'http://evil.example/x',
      });

      const { storage } = buildLocalStorage();
      const buildScope = async (): Promise<ReturnType<typeof buildEffectiveScope>> =>
        buildEffectiveScope({
          tenantId,
          assessmentId,
          tenantPolicy: { tenantId },
          platformPolicy: DEFAULT_PLATFORM_POLICY,
          rawRules: [
            ...allowLocalhostLabScopeRules(lab.port).map((r, i) => ({
              id: `r${i + 1}`,
              // biome-ignore lint/suspicious/noExplicitAny: lab helper types.
              ...(r as any),
            })),
            {
              id: 'deny-evil',
              ruleKind: 'domain' as const,
              effect: 'deny' as const,
              payload: { pattern: 'evil.example', matchSubdomains: true },
            },
          ],
          toolCatalog: new Map<string, ToolPolicy>(),
          assessmentFlags: {
            highImpactCategories: [],
            ownershipVerifiedTargetIds: new Set([targetId]),
          },
          timeWindow: null,
        });

      const deps = buildValidatorHandlerDeps({
        db: fx.db,
        storage,
        buildScope,
        driverDeps: { fetch: recordingFetch },
      });

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'validate.finding',
        idempotencyKey: 'validate:oos-1',
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: '0123456789abcdef0123456789abcdef',
        payload: {
          tenantId,
          projectId,
          assessmentId,
          candidateFindingId: candidateId,
          candidateType: 'xss_reflected',
          traceId: '0123456789abcdef0123456789abcdef',
        },
      };

      const out = await handleValidateFinding(deps, env);
      expect(out.kind).toBe('ack');

      const reachedEvil = fetchedUrls.some((u) => u.includes('evil.example'));
      expect(reachedEvil).toBe(false);

      const findings = await fx.db
        .selectFrom('findings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(findings.length).toBe(0);

      const audits = await fx.db
        .selectFrom('audit_events')
        .select(['action', 'after_state'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .orderBy('occurred_at', 'asc')
        .execute();
      const actions = audits.map((a) => String(a.action));
      expect(actions).toContain('validation.out_of_scope');
      expect(actions).not.toContain('validation.confirmed');
      expect(actions).not.toContain('finding.created');
    });
  });
});
