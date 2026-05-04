import type { Context } from 'hono';
import { sql } from 'kysely';
import { z } from 'zod';
import { assertOwnership } from '../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import {
  type ScanTier,
  tierToHighImpactCategories,
  tierToScopeRules,
} from '../../scans/tier-to-scope.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

const scanLaunchSchema = z
  .object({
    project_id: z.string().uuid(),
    tier: z.enum(['light', 'medium', 'aggressive']),
    target_ids: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict();

const idParam = z.string().uuid();

// =============================================================================
// POST /api/v1/scans — launch scan (inline state machine: draft→running)
// =============================================================================

export const handleLaunchScan = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = scanLaunchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { project_id: projectId, tier, target_ids: targetIds } = parsed.data;

  // Load and tenant-scope project.
  const project = await deps.db
    .selectFrom('projects')
    .select(['id', 'tenant_id'])
    .where('id', '=', projectId)
    .executeTakeFirst();
  if (!project) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'project',
    resourceId: project.id,
    resourceTenantId: project.tenant_id,
  });

  // Load targets — cross-tenant → 403, not-found/wrong-project → 422.
  const targetRows = await deps.db
    .selectFrom('targets')
    .select(['id', 'tenant_id', 'project_id', 'ownership_status', 'value', 'kind'])
    .where('id', 'in', targetIds)
    .execute();

  const targetMap = new Map(targetRows.map((t) => [t.id, t]));
  for (const tid of targetIds) {
    const t = targetMap.get(tid);
    if (!t) return c.json({ error: 'invalid_targets', details: { targetId: tid } }, 422);
    if (t.tenant_id !== actor.tenantId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (t.project_id !== projectId) {
      return c.json({ error: 'invalid_targets', details: { targetId: tid } }, 422);
    }
    if (t.ownership_status !== 'verified') {
      return c.json({ error: 'target_unverified', target_id: tid }, 422);
    }
  }

  // Build scope rules and high-impact gate list from tier.
  const domains = targetRows.map((t) => t.value).filter(Boolean) as string[];
  const scopeRules = tierToScopeRules(tier as ScanTier, domains);
  const highImpactCategories = tierToHighImpactCategories(tier as ScanTier);

  // Step 1: Insert assessment in draft state.
  const traceId = newTraceId();
  const assessmentId = await deps.db.transaction().execute(async (tx) => {
    const inserted = await tx
      .insertInto('assessments')
      .values({
        tenant_id: actor.tenantId,
        project_id: projectId,
        state: 'draft',
        created_by: actor.id,
        testing_window_start: null,
        testing_window_end: null,
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary; pg expects text for jsonb.
        high_impact_categories: JSON.stringify(highImpactCategories) as any,
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary; pg expects text for jsonb.
        metadata: JSON.stringify({ tier }) as any,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('assessment_targets')
      .values(
        targetIds.map((tid) => ({
          assessment_id: inserted.id,
          target_id: tid,
          tenant_id: actor.tenantId,
        })),
      )
      .execute();

    if (scopeRules.length > 0) {
      await tx
        .insertInto('assessment_scope_rules')
        .values(
          scopeRules.map((sr) => {
            const { ruleKind, effect, ...fields } = sr;
            return {
              tenant_id: actor.tenantId,
              assessment_id: inserted.id,
              rule_kind: ruleKind,
              effect,
              // biome-ignore lint/suspicious/noExplicitAny: Json boundary.
              payload: JSON.stringify(fields) as any,
            };
          }),
        )
        .execute();
    }

    return inserted.id;
  });

  // Step 2: draft → submitted.
  await deps.db
    .updateTable('assessments')
    .set({ state: 'submitted', version: sql`version + 1`, updated_at: sql`now()` })
    .where('tenant_id', '=', actor.tenantId)
    .where('id', '=', assessmentId)
    .execute();

  // Reload to get current version for subsequent transitions.
  const afterSubmit = await deps.db
    .selectFrom('assessments')
    .select(['id', 'version', 'high_impact_categories', 'state'])
    .where('id', '=', assessmentId)
    .executeTakeFirstOrThrow();

  // Step 3: submitted → approved (R5 dual-table tx).
  const targetCountRow = await deps.db
    .selectFrom('assessment_targets')
    .where('tenant_id', '=', actor.tenantId)
    .where('assessment_id', '=', assessmentId)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  const targetCount = Number(targetCountRow.count);
  const cats = (afterSubmit.high_impact_categories as ReadonlyArray<string>) ?? [];

  await deps.db.transaction().execute(async (tx) => {
    await tx
      .insertInto('assessment_approvals')
      .values({
        tenant_id: actor.tenantId,
        assessment_id: assessmentId,
        approved_by: actor.id,
        target_count: targetCount,
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary; pg expects text for jsonb.
        high_impact_categories: JSON.stringify(cats) as any,
      })
      .execute();
    await tx
      .updateTable('assessments')
      .set({
        state: 'approved',
        approved_by: actor.id,
        approved_at: sql`now()`,
        version: sql`version + 1`,
        updated_at: sql`now()`,
      })
      .where('tenant_id', '=', actor.tenantId)
      .where('id', '=', assessmentId)
      .where('version', '=', afterSubmit.version)
      .execute();
  });

  // Reload again for start version.
  const afterApprove = await deps.db
    .selectFrom('assessments')
    .select(['id', 'version', 'project_id'])
    .where('id', '=', assessmentId)
    .executeTakeFirstOrThrow();

  // Step 4: approved → running + outbox job (A-Q-Api-1 outbox pattern).
  const idemKey = `scan.start:${assessmentId}`;
  const startEnvelope = {
    jobId: crypto.randomUUID(),
    tenantId: actor.tenantId,
    projectId,
    assessmentId,
    kind: 'assessment.start' as const,
    idempotencyKey: idemKey,
    createdAt: new Date().toISOString(),
    attempt: 0,
    maxAttempts: 3,
    traceId,
    payload: { assessmentId, targetIds },
  };

  await deps.db.transaction().execute(async (tx) => {
    await tx
      .updateTable('assessments')
      .set({ state: 'running', version: sql`version + 1`, updated_at: sql`now()` })
      .where('tenant_id', '=', actor.tenantId)
      .where('id', '=', assessmentId)
      .where('version', '=', afterApprove.version)
      .execute();
    await tx
      .insertInto('jobs')
      .values({
        tenant_id: actor.tenantId,
        project_id: projectId,
        assessment_id: assessmentId,
        kind: startEnvelope.kind,
        status: 'pending',
        attempt: 0,
        max_attempts: startEnvelope.maxAttempts,
        idempotency_key: idemKey,
        not_before: null,
        trace_id: traceId,
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary; pg expects text for jsonb.
        payload: JSON.stringify(startEnvelope) as any,
      })
      .execute();
  });

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'scan.launched',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'assessment',
    resourceId: assessmentId,
    projectId,
    assessmentId,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId,
    metadata: { tier, targetIds, scopeRuleCount: scopeRules.length },
  });

  return c.json({ scan_id: assessmentId, state: 'running' }, 200);
};

// =============================================================================
// GET /api/v1/scans — list scans (assessments) for tenant
// =============================================================================

export const handleListScans = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const rows = await deps.db
    .selectFrom('assessments')
    .select(['id', 'state', 'metadata', 'project_id', 'created_at'])
    .where('tenant_id', '=', actor.tenantId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();

  const items = rows.map((r) => {
    const meta = (r.metadata as { tier?: unknown } & Record<string, unknown>) ?? {};
    return {
      scan_id: r.id,
      state: r.state,
      tier: meta.tier ?? null,
      project_id: r.project_id,
      created_at: r.created_at,
    };
  });

  return c.json({ items, total: items.length });
};

// =============================================================================
// GET /api/v1/scans/:id — get scan detail
// =============================================================================

export const handleGetScan = async (deps: RouteDeps, c: Context<SessionEnv>): Promise<Response> => {
  const actor = requireActor(c);

  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const row = await deps.db
    .selectFrom('assessments')
    .selectAll()
    .where('id', '=', id.data)
    .where('tenant_id', '=', actor.tenantId)
    .executeTakeFirst();

  if (!row) return c.json({ error: 'not_found' }, 404);

  const meta = (row.metadata as { tier?: unknown } & Record<string, unknown>) ?? {};
  return c.json({
    scan_id: row.id,
    state: row.state,
    tier: meta.tier ?? null,
    project_id: row.project_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
};

// =============================================================================
// GET /api/v1/scans/:id/progress
// =============================================================================

export const handleScanProgress = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const row = await deps.db
    .selectFrom('assessments')
    .select(['id', 'state', 'tenant_id'])
    .where('id', '=', id.data)
    .where('tenant_id', '=', actor.tenantId)
    .executeTakeFirst();

  if (!row) return c.json({ error: 'not_found' }, 404);

  const findingsCountRow = await deps.db
    .selectFrom('findings')
    .where('assessment_id', '=', row.id)
    .where('tenant_id', '=', actor.tenantId)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();

  const recentAuditEvents = await deps.db
    .selectFrom('audit_events')
    .select(['id', 'action', 'occurred_at'])
    .where('assessment_id', '=', row.id)
    .where('tenant_id', '=', actor.tenantId)
    .orderBy('occurred_at', 'desc')
    .limit(5)
    .execute();

  return c.json({
    state: row.state,
    findings_count: Number(findingsCountRow.count),
    recent_audit_events: recentAuditEvents,
  });
};
