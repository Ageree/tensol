// Sprint 7 §5.8 A-Q-Scope-1..2 — coordinator scope-deny terminal flow.
//
// Fixture: assessment with target whose URL is denied by an explicit deny rule.
// POST start → 200 (route succeeds, enqueues). Coordinator picks up, calls
// scope-engine, sees deny → marks job failed_terminal, sets assessment state=failed,
// emits scope.validate.denied + assessment.failed audit rows.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAssessmentStart } from '@cyberstrike/coordinator';
import { type JobEnvelope, LocalQueueAdapter } from '@cyberstrike/queue';
import { buildScopeForAssessment } from '../../../apps/api/src/scope-engine/build-scope.ts';
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

const uniqTenant = (): string => crypto.randomUUID();
const uniqId = (): string => crypto.randomUUID();

const stubScopeDeps = {
  dns: {
    resolveA: async () => [],
    resolveAAAA: async () => [],
  },
  clock: { now: (): Date => new Date() },
  rateLimit: {
    consume: async () => ({ ok: true, retryAfterMs: 0 }),
  },
};

describe.skipIf(!hasDatabaseUrl())(
  'queue :: scope-deny terminal start flow (A-Q-Scope-1..2)',
  () => {
    let fx: DbFixture;
    let baseDir: string;
    let adapter: LocalQueueAdapter;
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
      baseDir = mkdtempSync(join(tmpdir(), 'cs-queue-scope-'));
      adapter = new LocalQueueAdapter({ db: fx.db, baseDir });
      tenantId = uniqTenant();
      await fx.db
        .insertInto('tenants')
        .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
        .execute();
    });

    test('coordinator denies → assessment.state=failed + 2 audit rows + no child jobs', async () => {
      // Seed a user (audit FK), project, denied target, assessment with deny rule.
      const userId = uniqId();
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
        value: 'https://attacker.example/',
        ownershipStatus: 'verified',
      });
      const assessmentId = await seedAssessment(fx, {
        tenantId,
        projectId,
        createdBy: userId,
        state: 'running',
        targetIds: [targetId],
        scopeRules: [
          {
            ruleKind: 'domain',
            effect: 'deny',
            payload: { domain: 'attacker.example', matchSubdomains: true },
          },
        ],
      });

      // Pre-counts.
      const auditPre = await fx.db
        .selectFrom('audit_events')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();
      const auditPreCount = Number(auditPre.c);

      // Build the start envelope as if the API enqueued it.
      const env: JobEnvelope = {
        jobId: uniqId(),
        tenantId,
        projectId,
        assessmentId,
        kind: 'assessment.start',
        idempotencyKey: 'assessment.start:scope-deny-1',
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
        traceId: 'trace-deny',
        payload: { assessmentId, targetIds: [targetId] },
      };
      await adapter.publish(env);

      // Drive the coordinator handler directly (synchronous test surface).
      const outcome = await handleAssessmentStart(
        {
          db: fx.db,
          adapter,
          scopeDeps: stubScopeDeps,
          buildScope: (id) => buildScopeForAssessment(fx.db, id),
        },
        env,
      );
      expect(outcome.kind).toBe('nack');
      if (outcome.kind === 'nack') {
        expect(outcome.error.name).toBe('ScopeDenyError');
      }

      // Assert assessment.state = 'failed'.
      const ass = await fx.db
        .selectFrom('assessments')
        .select(['state'])
        .where('id', '=', assessmentId)
        .executeTakeFirstOrThrow();
      expect(ass.state).toBe('failed');

      // Assert exactly 2 new audit rows: scope.validate.denied + assessment.failed.
      const auditPost = await fx.db
        .selectFrom('audit_events')
        .select(['action'])
        .where('tenant_id', '=', tenantId)
        .where('assessment_id', '=', assessmentId)
        .execute();
      const newActions = auditPost.map((r) => r.action).sort();
      expect(newActions).toContain('scope.validate.denied');
      expect(newActions).toContain('assessment.failed');
      const auditPostCount = await fx.db
        .selectFrom('audit_events')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();
      expect(Number(auditPostCount.c) - auditPreCount).toBe(2);

      // Assert NO child recon.browser.placeholder jobs published (A-Q-Scope-2).
      const childCount = await fx.db
        .selectFrom('jobs')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('tenant_id', '=', tenantId)
        .where('kind', '=', 'recon.browser.placeholder')
        .where('assessment_id', '=', assessmentId)
        .executeTakeFirstOrThrow();
      expect(Number(childCount.c)).toBe(0);

      rmSync(baseDir, { recursive: true, force: true });
    });
  },
);
