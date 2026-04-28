// Sprint 5 §5.4 — assessments routes.
//
// Endpoints (all under /api/v1):
//   - GET    /projects/:projectId/assessments          list
//   - GET    /assessments/:id                          get
//   - POST   /projects/:projectId/assessments          create draft
//   - PATCH  /assessments/:id                          edit (draft only)
//   - POST   /assessments/:id/submit                   draft → submitted
//   - POST   /assessments/:id/approve                  submitted → approved (tenant_admin only; R5)
//   - POST   /assessments/:id/start                    approved → running (R8 testingWindow gate)
//   - POST   /assessments/:id/pause                    running → paused
//   - POST   /assessments/:id/resume                   paused → running
//   - POST   /assessments/:id/cancel                   any non-terminal → cancelled
//   - GET    /assessments/:id/status                   computed transitionsAvailable
//   - GET    /assessments/:id/timeline                 audit tail (R7)
//   - GET    /assessments/:id/artifacts                placeholder list
//   - GET    /assessments/:id/engine                   placeholder
//
// Critical Sprint 5 invariants:
//   R3 — PATCH on draft does atomic delete-then-insert of targetIds and
//        scopeRules in the same tx as the parent UPDATE.
//   R4 — Cross-tenant target precedence: T2 targetId → 403 + rbac.deny BEFORE
//        the 422 invalid_targets path. Same-tenant + wrong-project → 422.
//   R5 — approve writes BOTH `assessment_approvals` insert AND assessments
//        UPDATE (state, approved_by, approved_at) in the SAME transaction.
//   R7 — timeline RBAC keys on (role, assessment, read), not (role, audit_log, *).
//   R8 — start route checks testingWindow vs server clock AFTER state machine
//        transition succeeds. Out-of-window → 422 + assessment.start.denied.

import { RbacDenyError, assertCan } from '@cyberstrike/authz';
import {
  type AssessmentCommand,
  type AssessmentState,
  TerminalStateError,
  assessmentCreateSchema,
  assessmentListQuerySchema,
  assessmentPatchSchema,
  transition,
} from '@cyberstrike/contracts';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertOwnership } from '../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import { decodeListCursor, encodeListCursor } from '../_helpers/pagination.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

type AssessmentRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  state: string;
  created_by: string;
  approved_by: string | null;
  approved_at: Date | null;
  testing_window_start: Date | null;
  testing_window_end: Date | null;
  high_impact_categories: unknown;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  version: number;
};

type ProjectRow = { id: string; tenant_id: string };

const idParam = z.string().uuid();
const ifMatchHeader = z
  .string()
  .regex(/^\d+$/)
  .transform((v) => Number.parseInt(v, 10));

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

const safeJson = async (c: Context<SessionEnv>): Promise<unknown | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

const loadProjectById = async (deps: RouteDeps, id: string): Promise<ProjectRow | null> => {
  const row = await deps.db
    .selectFrom('projects')
    .select(['id', 'tenant_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row ?? null;
};

const loadAssessmentById = async (deps: RouteDeps, id: string): Promise<AssessmentRow | null> => {
  const row = await deps.db
    .selectFrom('assessments')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return (row as unknown as AssessmentRow) ?? null;
};

const assessmentPublic = (row: AssessmentRow) => ({
  id: row.id,
  projectId: row.project_id,
  state: row.state,
  createdBy: row.created_by,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at?.toISOString() ?? null,
  testingWindow:
    row.testing_window_start && row.testing_window_end
      ? {
          start: row.testing_window_start.toISOString(),
          end: row.testing_window_end.toISOString(),
        }
      : null,
  highImpactCategories: row.high_impact_categories,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

// =============================================================================
// Helpers — target validation (R4 cross-tenant precedence)
// =============================================================================

interface TargetCheckResult {
  readonly status: 'ok' | 'cross_tenant' | 'wrong_project' | 'not_found';
  readonly badId?: string;
  readonly attemptedTenantId?: string;
}

/**
 * R4: load all target rows by id WITHOUT tenant filter. If any row's tenant
 * differs from actor's tenant → throw RbacDenyError (403 + rbac.deny). If
 * any target's project_id differs from the assessment's project_id → 422
 * invalid_targets. If any id isn't found → 422 invalid_targets.
 */
const validateTargets = async (
  deps: RouteDeps,
  actorTenantId: string,
  expectedProjectId: string,
  targetIds: ReadonlyArray<string>,
): Promise<TargetCheckResult> => {
  if (targetIds.length === 0) return { status: 'ok' };
  const rows = await deps.db
    .selectFrom('targets')
    .select(['id', 'tenant_id', 'project_id'])
    .where('id', 'in', targetIds as string[])
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const tid of targetIds) {
    const row = byId.get(tid);
    if (!row) return { status: 'not_found', badId: tid };
    if (row.tenant_id !== actorTenantId) {
      return { status: 'cross_tenant', badId: tid, attemptedTenantId: row.tenant_id };
    }
    if (row.project_id !== expectedProjectId) {
      return { status: 'wrong_project', badId: tid };
    }
  }
  return { status: 'ok' };
};

// =============================================================================
// POST /projects/:projectId/assessments — A-Asm-2
// =============================================================================

export const handleCreateAssessment = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'create', 'assessment');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'assessment',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const projectId = idParam.safeParse(c.req.param('projectId'));
  if (!projectId.success) return c.json({ error: 'not_found' }, 404);

  const project = await loadProjectById(deps, projectId.data);
  if (!project) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'project',
    resourceId: project.id,
    resourceTenantId: project.tenant_id,
  });

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = assessmentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  // R4 — cross-tenant precedence BEFORE the 422 path.
  const check = await validateTargets(deps, actor.tenantId, project.id, parsed.data.targetIds);
  if (check.status === 'cross_tenant') {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'target',
      ...(check.badId ? { attemptedResourceId: check.badId } : {}),
      ...(check.attemptedTenantId ? { targetedTenantId: check.attemptedTenantId } : {}),
      reason: 'cross-tenant target reference in assessment create',
    });
  }
  if (check.status === 'wrong_project' || check.status === 'not_found') {
    return c.json(
      {
        error: 'invalid_targets',
        details: {
          targetId: check.badId,
          expectedProjectId: project.id,
        },
      },
      422,
    );
  }

  // Atomic insert: assessments + assessment_targets + assessment_scope_rules + audit row.
  const newId = await deps.db.transaction().execute(async (tx) => {
    const inserted = await tx
      .insertInto('assessments')
      .values({
        tenant_id: actor.tenantId,
        project_id: project.id,
        state: 'draft',
        created_by: actor.id,
        testing_window_start: parsed.data.testingWindow
          ? new Date(parsed.data.testingWindow.start)
          : null,
        testing_window_end: parsed.data.testingWindow
          ? new Date(parsed.data.testingWindow.end)
          : null,
        // Sprint 5 F5: pg-driver serializes a JS array as Postgres array
        // literal `{c2}` when the prepared-statement param type is unknown
        // (Kysely doesn't tag it as jsonb). For an empty `[]` Postgres maps
        // it silently to `{}` which the JSONB column accepts as object —
        // semantically wrong but no error. With a non-empty array the JSONB
        // cast fails 22P02. Serialise to JSON text so the cast succeeds for
        // both empty and non-empty cases. Symmetric fix at all 3 prod sites
        // (create / patch / approve) and at seedAssessment in test fixtures.
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary; pg expects text for jsonb.
        high_impact_categories: JSON.stringify(parsed.data.highImpactCategories) as any,
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary; pg expects text for jsonb.
        metadata: JSON.stringify({ name: parsed.data.name }) as any,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (parsed.data.targetIds.length > 0) {
      await tx
        .insertInto('assessment_targets')
        .values(
          parsed.data.targetIds.map((tid) => ({
            assessment_id: inserted.id,
            target_id: tid,
            tenant_id: actor.tenantId,
          })),
        )
        .execute();
    }
    if (parsed.data.scopeRules.length > 0) {
      await tx
        .insertInto('assessment_scope_rules')
        .values(
          parsed.data.scopeRules.map((sr) => ({
            tenant_id: actor.tenantId,
            assessment_id: inserted.id,
            rule_kind: sr.ruleKind,
            effect: sr.effect,
            // biome-ignore lint/suspicious/noExplicitAny: Json boundary.
            payload: sr.payload as any,
          })),
        )
        .execute();
    }
    return inserted.id;
  });

  const created = await loadAssessmentById(deps, newId);
  if (!created) throw new Error('post-insert load failed');

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'assessment.created',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'assessment',
    resourceId: created.id,
    projectId: project.id,
    assessmentId: created.id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    metadata: {
      name: parsed.data.name,
      targetCount: parsed.data.targetIds.length,
      scopeRuleCount: parsed.data.scopeRules.length,
    },
  });

  return c.json(assessmentPublic(created), 201);
};

// =============================================================================
// GET /projects/:projectId/assessments + GET /assessments/:id — A-Asm-1
// =============================================================================

export const handleListAssessments = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'list', 'assessment');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'assessment',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const projectId = idParam.safeParse(c.req.param('projectId'));
  if (!projectId.success) return c.json({ error: 'not_found' }, 404);
  const project = await loadProjectById(deps, projectId.data);
  if (!project) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'project',
    resourceId: project.id,
    resourceTenantId: project.tenant_id,
  });

  const url = new URL(c.req.url);
  const rawQuery: Record<string, string> = {};
  for (const [k, v] of url.searchParams) rawQuery[k] = v;
  const parsedQ = assessmentListQuerySchema.safeParse(rawQuery);
  if (!parsedQ.success) return c.json({ error: 'invalid_query' }, 400);
  const cursor = parsedQ.data.cursor ? decodeListCursor(parsedQ.data.cursor) : null;
  if (parsedQ.data.cursor && !cursor) return c.json({ error: 'invalid_query' }, 400);

  let q = deps.db
    .selectFrom('assessments')
    .selectAll()
    .where('tenant_id', '=', actor.tenantId)
    .where('project_id', '=', project.id)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(parsedQ.data.limit + 1);
  if (cursor) {
    const cAt = new Date(cursor.createdAt);
    q = q.where((eb) =>
      eb.or([
        eb('created_at', '<', cAt),
        eb.and([eb('created_at', '=', cAt), eb('id', '<', cursor.id)]),
      ]),
    );
  }
  const rows = (await q.execute()) as AssessmentRow[];
  const hasMore = rows.length > parsedQ.data.limit;
  const page = hasMore ? rows.slice(0, parsedQ.data.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeListCursor({ createdAt: last.created_at.toISOString(), id: last.id })
      : null;
  return c.json({ data: page.map((r) => assessmentPublic(r)), nextCursor });
};

export const handleGetAssessment = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'read', 'assessment');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'assessment',
      reason: `rbac: ${decision.reason}`,
    });
  }
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);
  const row = await loadAssessmentById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'assessment',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });
  return c.json(assessmentPublic(row));
};

// =============================================================================
// PATCH /assessments/:id — A-Asm-3 (R3 atomic delete-then-insert)
// =============================================================================

export const handlePatchAssessment = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'update', 'assessment');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'assessment',
      reason: `rbac: ${decision.reason}`,
    });
  }
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);
  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = assessmentPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const row = await loadAssessmentById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'assessment',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  if (row.state !== 'draft') return c.json({ error: 'not_editable_in_state' }, 409);

  const ifMatch = c.req.header('if-match') ?? c.req.header('If-Match');
  if (!ifMatch) return c.json({ error: 'if_match_required' }, 428);
  const provided = ifMatchHeader.safeParse(ifMatch);
  if (!provided.success || provided.data !== row.version) {
    return c.json({ error: 'version_mismatch' }, 409);
  }

  // R4 cross-tenant precedence on PATCH targetIds.
  if (parsed.data.targetIds) {
    const check = await validateTargets(
      deps,
      actor.tenantId,
      row.project_id,
      parsed.data.targetIds,
    );
    if (check.status === 'cross_tenant') {
      throw new RbacDenyError({
        actorTenantId: actor.tenantId,
        attemptedResourceType: 'target',
        ...(check.badId ? { attemptedResourceId: check.badId } : {}),
        ...(check.attemptedTenantId ? { targetedTenantId: check.attemptedTenantId } : {}),
        reason: 'cross-tenant target reference in assessment patch',
      });
    }
    if (check.status === 'wrong_project' || check.status === 'not_found') {
      return c.json({ error: 'invalid_targets', details: { targetId: check.badId } }, 422);
    }
  }

  await deps.db.transaction().execute(async (tx) => {
    const { sql } = await import('kysely');
    // Sprint 5 F5: JSONB columns receive stringified JSON to bypass the
    // pg-driver array-literal serialization (see comment in createAssessment).
    const setClause: {
      testing_window_start?: Date | null;
      testing_window_end?: Date | null;
      high_impact_categories?: string;
      metadata?: string;
      version: unknown;
      updated_at: unknown;
    } = {
      version: sql`version + 1`,
      updated_at: sql`now()`,
    };
    if (parsed.data.testingWindow !== undefined) {
      setClause.testing_window_start = parsed.data.testingWindow
        ? new Date(parsed.data.testingWindow.start)
        : null;
      setClause.testing_window_end = parsed.data.testingWindow
        ? new Date(parsed.data.testingWindow.end)
        : null;
    }
    if (parsed.data.highImpactCategories !== undefined) {
      setClause.high_impact_categories = JSON.stringify(parsed.data.highImpactCategories);
    }
    if (parsed.data.name !== undefined) {
      setClause.metadata = JSON.stringify({
        ...((row.metadata as object) ?? {}),
        name: parsed.data.name,
      });
    }
    await tx
      // biome-ignore lint/suspicious/noExplicitAny: kysely set boundary.
      .updateTable('assessments' as any)
      .set(setClause)
      .where('id', '=', row.id)
      .where('tenant_id', '=', actor.tenantId)
      .where('version', '=', row.version)
      .execute();
    if (parsed.data.targetIds !== undefined) {
      await tx
        .deleteFrom('assessment_targets')
        .where('tenant_id', '=', actor.tenantId)
        .where('assessment_id', '=', row.id)
        .execute();
      if (parsed.data.targetIds.length > 0) {
        await tx
          .insertInto('assessment_targets')
          .values(
            parsed.data.targetIds.map((tid) => ({
              assessment_id: row.id,
              target_id: tid,
              tenant_id: actor.tenantId,
            })),
          )
          .execute();
      }
    }
    if (parsed.data.scopeRules !== undefined) {
      await tx
        .deleteFrom('assessment_scope_rules')
        .where('tenant_id', '=', actor.tenantId)
        .where('assessment_id', '=', row.id)
        .execute();
      if (parsed.data.scopeRules.length > 0) {
        await tx
          .insertInto('assessment_scope_rules')
          .values(
            parsed.data.scopeRules.map((sr) => ({
              tenant_id: actor.tenantId,
              assessment_id: row.id,
              rule_kind: sr.ruleKind,
              effect: sr.effect,
              // biome-ignore lint/suspicious/noExplicitAny: Json boundary.
              payload: sr.payload as any,
            })),
          )
          .execute();
      }
    }
  });

  const refreshed = await loadAssessmentById(deps, row.id);
  if (!refreshed) return c.json({ error: 'not_found' }, 404);

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'assessment.updated',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'assessment',
    resourceId: row.id,
    projectId: row.project_id,
    assessmentId: row.id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
  });

  return c.json(assessmentPublic(refreshed));
};

// =============================================================================
// State-transition shared helpers
// =============================================================================

interface TransitionContext {
  readonly row: AssessmentRow;
  readonly actor: ReturnType<typeof requireActor>;
}

const loadOwnedAssessment = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<{ ok: true; ctx: TransitionContext } | { ok: false; res: Response }> => {
  const actor = requireActor(c);
  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return { ok: false, res: c.json({ error: 'not_found' }, 404) };
  const row = await loadAssessmentById(deps, id.data);
  if (!row) return { ok: false, res: c.json({ error: 'not_found' }, 404) };
  assertOwnership(actor.tenantId, {
    resourceType: 'assessment',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });
  return { ok: true, ctx: { row, actor } };
};

const stateTransitionResponse = (
  c: Context<SessionEnv>,
  current: AssessmentState,
  command: AssessmentCommand,
): Response | null => {
  const result = transition(current, command);
  if (result.ok) return null;
  if (result.error instanceof TerminalStateError) {
    return c.json({ error: 'terminal_state', state: current }, 409);
  }
  return c.json(
    {
      error: 'invalid_state_transition',
      from: current,
      command,
      allowedFromStates: result.error.allowedFromStates,
    },
    409,
  );
};

// =============================================================================
// POST /assessments/:id/submit — A-Asm-4
// =============================================================================

export const handleSubmitAssessment = makeStateTransitionHandler({
  requiredAction: 'submit',
  command: 'submit',
  auditAction: 'assessment.submitted',
});

// =============================================================================
// POST /assessments/:id/approve — A-Asm-5 / R5 dual-table
// =============================================================================

export const handleApproveAssessment = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'approve', 'assessment');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'assessment',
      reason: `rbac: ${decision.reason}`,
    });
  }
  const loaded = await loadOwnedAssessment(deps, c);
  if (!loaded.ok) return loaded.res;
  const { row } = loaded.ctx;

  const stateErr = stateTransitionResponse(c, row.state as AssessmentState, 'approve');
  if (stateErr) return stateErr;

  // Verify all targets have ownership_status='verified'.
  const unverified = await deps.db
    .selectFrom('assessment_targets as at')
    .innerJoin('targets as t', 't.id', 'at.target_id')
    .select(['t.id'])
    .where('at.tenant_id', '=', actor.tenantId)
    .where('at.assessment_id', '=', row.id)
    .where('t.ownership_status', '!=', 'verified')
    .execute();
  if (unverified.length > 0) {
    return c.json(
      {
        error: 'unverified_high_impact_targets',
        details: { unverifiedTargetIds: unverified.map((u) => u.id) },
      },
      422,
    );
  }

  const cats = (row.high_impact_categories as ReadonlyArray<string>) ?? [];
  const targetCountRow = await deps.db
    .selectFrom('assessment_targets')
    .where('tenant_id', '=', actor.tenantId)
    .where('assessment_id', '=', row.id)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  const targetCount = Number(targetCountRow.count);
  const now = new Date();

  await deps.db.transaction().execute(async (tx) => {
    // R5 — both writes in same tx.
    await tx
      .insertInto('assessment_approvals')
      .values({
        tenant_id: actor.tenantId,
        assessment_id: row.id,
        approved_by: actor.id,
        target_count: targetCount,
        // Sprint 5 F5 — JSONB write must be JSON text (see createAssessment).
        // R5 dual-table approve: this is the forensic snapshot of the
        // category set at approval time. Empty `[]` and non-empty `['c2']`
        // both round-trip correctly only with JSON.stringify.
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary; pg expects text for jsonb.
        high_impact_categories: JSON.stringify(cats) as any,
      })
      .execute();
    const { sql } = await import('kysely');
    await tx
      .updateTable('assessments')
      .set({
        state: 'approved',
        approved_by: actor.id,
        approved_at: now,
        version: sql`version + 1`,
        updated_at: sql`now()`,
      })
      .where('tenant_id', '=', actor.tenantId)
      .where('id', '=', row.id)
      .where('version', '=', row.version)
      .execute();
  });

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'assessment.approved',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'assessment',
    resourceId: row.id,
    projectId: row.project_id,
    assessmentId: row.id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    metadata: {
      approvedBy: actor.id,
      highImpactCategories: cats,
      targetCount,
    },
  });

  const refreshed = await loadAssessmentById(deps, row.id);
  if (!refreshed) return c.json({ error: 'not_found' }, 404);
  return c.json(assessmentPublic(refreshed));
};

// =============================================================================
// POST /assessments/:id/start — A-Asm-6 / R8 temporal gate
// =============================================================================

export const handleStartAssessment = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'start', 'assessment');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'assessment',
      reason: `rbac: ${decision.reason}`,
    });
  }
  const loaded = await loadOwnedAssessment(deps, c);
  if (!loaded.ok) return loaded.res;
  const { row } = loaded.ctx;

  const stateErr = stateTransitionResponse(c, row.state as AssessmentState, 'start');
  if (stateErr) return stateErr;

  // R8 — temporal gate AFTER state transition succeeds (state machine pure).
  const now = new Date();
  if (row.testing_window_end && now > row.testing_window_end) {
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'assessment.start.denied',
      outcome: 'denied',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'assessment',
      resourceId: row.id,
      projectId: row.project_id,
      assessmentId: row.id,
      ip: sourceIp(c),
      userAgent: userAgent(c),
      traceId: newTraceId(),
      metadata: {
        reason: 'window_expired',
        now: now.toISOString(),
        end: row.testing_window_end.toISOString(),
      },
    });
    return c.json(
      {
        error: 'testing_window_expired',
        details: { now: now.toISOString(), end: row.testing_window_end.toISOString() },
      },
      422,
    );
  }
  if (row.testing_window_start && now < row.testing_window_start) {
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'assessment.start.denied',
      outcome: 'denied',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'assessment',
      resourceId: row.id,
      projectId: row.project_id,
      assessmentId: row.id,
      ip: sourceIp(c),
      userAgent: userAgent(c),
      traceId: newTraceId(),
      metadata: {
        reason: 'window_not_yet_open',
        now: now.toISOString(),
        start: row.testing_window_start.toISOString(),
      },
    });
    return c.json(
      {
        error: 'testing_window_not_yet_open',
        details: {
          now: now.toISOString(),
          start: row.testing_window_start.toISOString(),
        },
      },
      422,
    );
  }

  // Window valid — commit transition.
  const { sql } = await import('kysely');
  await deps.db
    .updateTable('assessments')
    .set({ state: 'running', version: sql`version + 1`, updated_at: sql`now()` })
    .where('tenant_id', '=', actor.tenantId)
    .where('id', '=', row.id)
    .where('version', '=', row.version)
    .execute();

  // Sprint 7: enqueue assessment.start envelope here

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'assessment.started',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'assessment',
    resourceId: row.id,
    projectId: row.project_id,
    assessmentId: row.id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    metadata: { fromState: row.state, toState: 'running', command: 'start' },
  });
  const refreshed = await loadAssessmentById(deps, row.id);
  if (!refreshed) return c.json({ error: 'not_found' }, 404);
  return c.json(assessmentPublic(refreshed));
};

// =============================================================================
// POST /assessments/:id/{pause,resume,cancel} — generic
// =============================================================================

interface StateTransitionConfig {
  readonly requiredAction: 'submit' | 'approve' | 'start' | 'pause' | 'resume' | 'cancel';
  readonly command: AssessmentCommand;
  readonly auditAction:
    | 'assessment.submitted'
    | 'assessment.paused'
    | 'assessment.resumed'
    | 'assessment.cancelled';
}

function makeStateTransitionHandler(cfg: StateTransitionConfig) {
  return async (deps: RouteDeps, c: Context<SessionEnv>): Promise<Response> => {
    const actor = requireActor(c);
    const decision = assertCan(actor, cfg.requiredAction, 'assessment');
    if (!decision.allowed) {
      throw new RbacDenyError({
        actorTenantId: actor.tenantId,
        attemptedResourceType: 'assessment',
        reason: `rbac: ${decision.reason}`,
      });
    }
    const loaded = await loadOwnedAssessment(deps, c);
    if (!loaded.ok) return loaded.res;
    const { row } = loaded.ctx;

    const result = transition(row.state as AssessmentState, cfg.command);
    if (!result.ok) {
      const stateErr = stateTransitionResponse(c, row.state as AssessmentState, cfg.command);
      if (stateErr) return stateErr;
    }
    if (!result.ok) return c.json({ error: 'invalid_state_transition' }, 409);
    const newState = result.to;

    const { sql } = await import('kysely');
    await deps.db
      .updateTable('assessments')
      .set({ state: newState, version: sql`version + 1`, updated_at: sql`now()` })
      .where('tenant_id', '=', actor.tenantId)
      .where('id', '=', row.id)
      .where('version', '=', row.version)
      .execute();

    await audit(deps, {
      tenantId: actor.tenantId,
      action: cfg.auditAction,
      outcome: 'success',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'assessment',
      resourceId: row.id,
      projectId: row.project_id,
      assessmentId: row.id,
      ip: sourceIp(c),
      userAgent: userAgent(c),
      traceId: newTraceId(),
      metadata: { fromState: row.state, toState: newState, command: cfg.command },
    });
    const refreshed = await loadAssessmentById(deps, row.id);
    if (!refreshed) return c.json({ error: 'not_found' }, 404);
    return c.json(assessmentPublic(refreshed));
  };
}

export const handlePauseAssessment = makeStateTransitionHandler({
  requiredAction: 'pause',
  command: 'pause',
  auditAction: 'assessment.paused',
});

export const handleResumeAssessment = makeStateTransitionHandler({
  requiredAction: 'resume',
  command: 'resume',
  auditAction: 'assessment.resumed',
});

export const handleCancelAssessment = makeStateTransitionHandler({
  requiredAction: 'cancel',
  command: 'cancel',
  auditAction: 'assessment.cancelled',
});

// Sprint 7: enqueue queue cleanup envelope here (when source state was running/paused)

// Read-only query handlers (status / timeline / artifacts / engine) live in
// ./queries.ts so this file stays under the 800-line per-file ceiling.
export {
  handleAssessmentArtifacts,
  handleAssessmentEngine,
  handleAssessmentStatus,
  handleAssessmentTimeline,
} from './queries.ts';
