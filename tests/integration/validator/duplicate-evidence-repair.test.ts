// Sprint 10 iter-2 P1 — duplicate-path evidence repair.
//
// Setup: pre-insert a `findings` row with NO `finding_evidence` rows
// (simulates the partial state the original winner would leave behind if
// it crashed between the findings insert and the evidence persist).
// Then dispatch a `validate.finding` envelope for the SAME candidate;
// the worker hits the duplicate-key branch, runs the repair, and:
//   - persists evidence for the existing finding row
//   - emits `finding.created` (because none was emitted before)
//   - emits `validation.confirmed` with metadata
//     {idempotentLoser:true, evidenceRepaired:true,
//      findingCreatedAuditEmitted:true, findingId:<existing>}
//   - leaves exactly ONE findings row.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { insertConfirmedFinding } from '@cyberstrike/db';
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

describe.skipIf(!hasDatabaseUrl())(
  'validator :: duplicate-path evidence repair (iter-2 P1)',
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

    test('pre-existing finding without evidence + new validate envelope → repairs evidence + emits finding.created exactly once', async () => {
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
        const projectId = await seedProject(fx, { tenantId, name: 'P-repair' });
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

        // Simulate the original winner: insert findings row directly
        // (using the DirectInsertForbidden-guarded repo with a confirmed
        // ValidationResult shape) but DO NOT persist any finding_evidence
        // rows AND DO NOT emit `finding.created`. This mimics the crash
        // window the codex P1 described.
        const preInserted = await insertConfirmedFinding({
          db: fx.db,
          tenantId,
          assessmentId,
          candidateFindingId: candidateId,
          type: 'xss_reflected',
          severity: 'high',
          confidence: 'high',
          affectedUrl: `${lab.origin}/search?q=existing`,
          reproduction: { simulated: 'crash_window' },
          validatorLog: [{ phase: 'pre-existing-winner' }],
          validatedAt: new Date(),
          validatedBy: { status: 'confirmed' },
        });

        // Sanity: 1 finding row, 0 evidence rows, 0 finding.created audit
        const evidenceBefore = await fx.db
          .selectFrom('finding_evidence')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('finding_id', '=', preInserted.id)
          .execute();
        expect(evidenceBefore.length).toBe(0);
        const findingCreatedBefore = await fx.db
          .selectFrom('audit_events')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('action', '=', 'finding.created')
          .where('resource_id', '=', preInserted.id)
          .execute();
        expect(findingCreatedBefore.length).toBe(0);

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
          idempotencyKey: 'validate:repair-1',
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

        // Still exactly ONE findings row (no duplicate inserted).
        const findings = await fx.db
          .selectFrom('findings')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('created_from_candidate_id', '=', candidateId)
          .execute();
        expect(findings.length).toBe(1);
        expect(String(findings[0]?.id)).toBe(preInserted.id);

        // Evidence rows now populated by the repair path.
        const evidence = await fx.db
          .selectFrom('finding_evidence')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('finding_id', '=', preInserted.id)
          .orderBy('created_at', 'asc')
          .execute();
        // 2 driver runs × 2 kinds (screenshot+trace) = 4 rows.
        expect(evidence.length).toBe(4);
        for (const ev of evidence) {
          expect(String(ev.sha256)).toMatch(/^[a-f0-9]{64}$/);
          const bytes = await storage.get(String(ev.object_storage_key));
          const sha = createHash('sha256').update(bytes).digest('hex');
          expect(sha).toBe(String(ev.sha256));
        }

        // finding.created emitted exactly once across the whole assessment.
        // Worker keys lifecycle audits on candidate_finding.id (resourceType
        // = 'candidate_finding'), so the query filters on candidateId.
        const findingCreatedAfter = await fx.db
          .selectFrom('audit_events')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('action', '=', 'finding.created')
          .where('resource_id', '=', candidateId)
          .execute();
        expect(findingCreatedAfter.length).toBe(1);
        const fcMeta = findingCreatedAfter[0]?.after_state as Record<string, unknown> | null;
        expect(fcMeta?.emittedByIdempotentLoser).toBe(true);
        expect(fcMeta?.findingId).toBe(preInserted.id);

        // The validation.confirmed audit carries the repair counters.
        const lifecycle = await fx.db
          .selectFrom('audit_events')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('action', '=', 'validation.confirmed')
          .where('resource_id', '=', candidateId)
          .execute();
        expect(lifecycle.length).toBe(1);
        const lcMeta = lifecycle[0]?.after_state as Record<string, unknown> | null;
        expect(lcMeta?.idempotentLoser).toBe(true);
        expect(lcMeta?.evidenceRepaired).toBe(true);
        expect(lcMeta?.findingCreatedAuditEmitted).toBe(true);
        expect(lcMeta?.findingId).toBe(preInserted.id);
      });
    });
  },
);
