// Sprint 10 §A-V-Confirm + §A-V-Evidence.
//
// Lab `/search?q=<NONCE_PAYLOAD>` reflects the nonce → driver runs replay
// twice → both DOM echoes confirmed → findings row + 4 finding_evidence rows
// (screenshot/trace × 2 attempts) + sha256 round-trip via objectStorage.get.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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

describe.skipIf(!hasDatabaseUrl())('validator :: confirm-xss (A-V-Confirm + A-V-Evidence)', () => {
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

  test('reflected XSS at /search → confirmed findings row + 4 evidence rows + sha256 round-trip', async () => {
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
      const projectId = await seedProject(fx, { tenantId, name: 'P-confirm' });
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
      const candidateId = await seedCandidateFinding(fx.db, {
        tenantId,
        assessmentId,
        affectedUrl: `${lab.origin}/search?q=existing`,
      });

      const { storage } = buildLocalStorage();

      const buildScope = async (): Promise<ReturnType<typeof buildEffectiveScope>> =>
        buildEffectiveScope({
          tenantId,
          assessmentId,
          tenantPolicy: { tenantId },
          platformPolicy: DEFAULT_PLATFORM_POLICY,
          rawRules: allowLocalhostLabScopeRules(lab.port).map((r, i) => ({
            id: `r${i + 1}`,
            // biome-ignore lint/suspicious/noExplicitAny: lab helper types.
            ...(r as any),
          })),
          toolCatalog: new Map<string, ToolPolicy>(),
          assessmentFlags: {
            highImpactCategories: [],
            ownershipVerifiedTargetIds: new Set([targetId]),
          },
          timeWindow: null,
        });

      const deps = buildValidatorHandlerDeps({ db: fx.db, storage, buildScope });

      const env: JobEnvelope = {
        jobId: uniqUuid(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'validate.finding',
        idempotencyKey: 'validate:confirm-1',
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

      const findings = await fx.db
        .selectFrom('findings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      expect(findings.length).toBe(1);
      const finding = findings[0];
      expect(finding).toBeDefined();
      if (!finding) return;
      expect(String(finding.created_from_candidate_id)).toBe(candidateId);
      expect(String(finding.type)).toBe('xss_reflected');
      expect(String(finding.severity)).toBe('high');
      expect(String(finding.confidence)).toBe('high');
      expect(String(finding.status)).toBe('open');
      expect(String(finding.affected_url)).toContain(lab.origin);

      const evidence = await fx.db
        .selectFrom('finding_evidence')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('finding_id', '=', String(finding.id))
        .orderBy('created_at', 'asc')
        .execute();
      // 2 runs × 2 kinds = 4 rows.
      expect(evidence.length).toBe(4);
      const kinds = evidence.map((e) => String(e.kind)).sort();
      expect(kinds).toEqual(['screenshot', 'screenshot', 'trace', 'trace']);
      // sha256 round-trip via objectStorage.get.
      for (const ev of evidence) {
        expect(String(ev.sha256)).toMatch(/^[a-f0-9]{64}$/);
        const bytes = await storage.get(String(ev.object_storage_key));
        const sha = createHash('sha256').update(bytes).digest('hex');
        expect(sha).toBe(String(ev.sha256));
        expect(bytes.byteLength).toBe(Number(ev.size_bytes));
      }

      // Audit lifecycle has the 3 expected actions in order.
      const audits = await fx.db
        .selectFrom('audit_events')
        .select(['action'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .orderBy('occurred_at', 'asc')
        .execute();
      const validatorActions = audits
        .map((a) => String(a.action))
        .filter((a) => a.startsWith('validation.') || a === 'finding.created');
      expect(validatorActions).toEqual([
        'validation.started',
        'validation.confirmed',
        'finding.created',
      ]);
    });
  });
});
