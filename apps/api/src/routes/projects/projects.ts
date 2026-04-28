// Sprint 5 §5.2 — projects routes.
//
// 6 endpoints under `/api/v1/projects[...]`:
//   - GET    /projects                 list (A-Proj-1)
//   - POST   /projects                 create (A-Proj-2)
//   - GET    /projects/:id             get (A-Proj-3)
//   - PATCH  /projects/:id             update with optimistic lock (A-Proj-4)
//   - DELETE /projects/:id             SOFT delete (status='archived') (A-Proj-5)
//   - GET    /projects/:id/summary     aggregated counts (A-Proj-6)
//
// IDOR-2 / R9 semantics: 200 own-tenant, 403 cross-tenant (RbacDenyError →
// global onError handler emits deny audit + canonical 403), 404 nonexistent
// (no audit). The order is: read row, if missing → 404 (no audit), if present
// + foreign tenant → assertOwnership throws RbacDenyError (audit + 403).
//
// C29 delta=1: every state-changing endpoint emits exactly one audit row via
// emitAudit. The IDOR-2 deny path emits via the global onError handler.

import { RbacDenyError, assertCan } from '@cyberstrike/authz';
import {
  type ProjectStatus,
  projectCreateSchema,
  projectListQuerySchema,
  projectPatchSchema,
} from '@cyberstrike/contracts';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertOwnership } from '../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import { decodeListCursor, encodeListCursor } from '../_helpers/pagination.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

const ASSESSMENT_STATES = [
  'draft',
  'submitted',
  'approved',
  'running',
  'paused',
  'cancelled',
  'completed',
  'failed',
] as const;

type ProjectRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  status: string;
  created_at: Date;
  updated_at: Date;
};

const projectIdParam = z.string().uuid();
const ifMatchHeader = z
  .string()
  .regex(/^\d+$/)
  .transform((v) => Number.parseInt(v, 10));

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

// =============================================================================
// GET /projects — A-Proj-1
// =============================================================================

export const handleListProjects = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const decision = assertCan(actor, 'list', 'project');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'project',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const url = new URL(c.req.url);
  const rawQuery: Record<string, string> = {};
  for (const [k, v] of url.searchParams) rawQuery[k] = v;
  const parsed = projectListQuerySchema.safeParse(rawQuery);
  if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);

  const cursor = parsed.data.cursor ? decodeListCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !cursor) return c.json({ error: 'invalid_query' }, 400);

  let q = deps.db
    .selectFrom('projects')
    .selectAll()
    .where('tenant_id', '=', actor.tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(parsed.data.limit + 1);
  if (cursor) {
    const cAt = new Date(cursor.createdAt);
    q = q.where((eb) =>
      eb.or([
        eb('created_at', '<', cAt),
        eb.and([eb('created_at', '=', cAt), eb('id', '<', cursor.id)]),
      ]),
    );
  }
  const rows = (await q.execute()) as ProjectRow[];
  const hasMore = rows.length > parsed.data.limit;
  const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeListCursor({ createdAt: last.created_at.toISOString(), id: last.id })
      : null;

  return c.json({
    data: page.map((row) => projectPublic(row)),
    nextCursor,
  });
};

const projectPublic = (row: ProjectRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

// =============================================================================
// POST /projects — A-Proj-2
// =============================================================================

export const handleCreateProject = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const decision = assertCan(actor, 'create', 'project');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'project',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = projectCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  let row: ProjectRow;
  try {
    row = (await deps.db
      .insertInto('projects')
      .values({
        tenant_id: actor.tenantId,
        name: parsed.data.name,
        description: parsed.data.description ?? '',
        status: 'active',
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as ProjectRow;
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'duplicate_name' }, 409);
    throw err;
  }

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'project.created',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'project',
    resourceId: row.id,
    projectId: row.id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    metadata: { name: row.name },
  });

  return c.json(projectPublic(row), 201);
};

// =============================================================================
// GET /projects/:id — A-Proj-3
// =============================================================================

export const handleGetProject = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const decision = assertCan(actor, 'read', 'project');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'project',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const id = projectIdParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const row = await loadProjectById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);

  assertOwnership(actor.tenantId, {
    resourceType: 'project',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  return c.json(projectPublic(row));
};

// =============================================================================
// PATCH /projects/:id — A-Proj-4
// =============================================================================

export const handlePatchProject = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const decision = assertCan(actor, 'update', 'project');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'project',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const id = projectIdParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = projectPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const row = await loadProjectById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'project',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  // projects table has no `version` column, but we honour an If-Match header
  // tied to updated_at-derived version sourced from a monotonically-increasing
  // surrogate (the row's updated_at epoch ms truncated to seconds → text). To
  // stay strict-typed we rely on the row's updated_at: clients fetch the row,
  // server returns updated_at; client echoes it back via If-Match. Mismatch →
  // 409 version_mismatch.
  const ifMatch = c.req.header('if-match') ?? c.req.header('If-Match');
  if (ifMatch) {
    const provided = ifMatchHeader.safeParse(ifMatch);
    const currentEpoch = Math.floor(row.updated_at.getTime() / 1000);
    if (!provided.success || provided.data !== currentEpoch) {
      return c.json({ error: 'version_mismatch' }, 409);
    }
  }

  const setClause: { name?: string; description?: string; status?: string } = {};
  if (parsed.data.name !== undefined) setClause.name = parsed.data.name;
  if (parsed.data.description !== undefined) setClause.description = parsed.data.description;
  if (parsed.data.status !== undefined) setClause.status = parsed.data.status;
  if (Object.keys(setClause).length === 0) {
    // No-op patch: still return the row (idempotent), don't audit.
    return c.json(projectPublic(row));
  }

  let updated: ProjectRow;
  try {
    updated = (await deps.db
      .updateTable('projects')
      .set(setClause)
      .where('tenant_id', '=', actor.tenantId)
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as ProjectRow;
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'duplicate_name' }, 409);
    throw err;
  }

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'project.updated',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'project',
    resourceId: updated.id,
    projectId: updated.id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    metadata: { fields: Object.keys(setClause) },
  });

  return c.json(projectPublic(updated));
};

// =============================================================================
// DELETE /projects/:id — A-Proj-5 (soft delete → status='archived')
// =============================================================================

export const handleArchiveProject = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const decision = assertCan(actor, 'delete', 'project');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'project',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const id = projectIdParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const row = await loadProjectById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'project',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  if (row.status === 'archived') {
    // Idempotent — already archived, no state change, no audit.
    return new Response(null, { status: 204 });
  }

  await deps.db
    .updateTable('projects')
    .set({ status: 'archived' as ProjectStatus })
    .where('tenant_id', '=', actor.tenantId)
    .where('id', '=', row.id)
    .execute();

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'project.archived',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'project',
    resourceId: row.id,
    projectId: row.id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
  });

  return new Response(null, { status: 204 });
};

// =============================================================================
// GET /projects/:id/summary — A-Proj-6
// =============================================================================

export const handleProjectSummary = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const decision = assertCan(actor, 'read', 'project');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'project',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const id = projectIdParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const row = await loadProjectById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'project',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  const targetCount = await deps.db
    .selectFrom('targets')
    .where('tenant_id', '=', actor.tenantId)
    .where('project_id', '=', row.id)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();

  const stateRows = await deps.db
    .selectFrom('assessments')
    .where('tenant_id', '=', actor.tenantId)
    .where('project_id', '=', row.id)
    .select(['state', (eb) => eb.fn.countAll<string>().as('count')])
    .groupBy('state')
    .execute();

  const counts: Record<string, number> = {};
  for (const s of ASSESSMENT_STATES) counts[s] = 0;
  for (const r of stateRows) counts[r.state] = Number(r.count);

  return c.json({
    id: row.id,
    name: row.name,
    targetCount: Number(targetCount.count),
    assessmentCounts: counts,
    openFindingsCount: 0,
  });
};

// =============================================================================
// helpers
// =============================================================================

const loadProjectById = async (deps: RouteDeps, id: string): Promise<ProjectRow | null> => {
  const row = await deps.db
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return (row as unknown as ProjectRow) ?? null;
};

const safeJson = async (c: Context<SessionEnv>): Promise<unknown | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

const isUniqueViolation = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505';
};
