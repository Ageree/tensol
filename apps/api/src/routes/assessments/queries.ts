// Sprint 5 §5.4 — assessment query endpoints (status / timeline / artifacts / engine).
//
// Split out of assessments.ts to keep that file ≤ 800 lines per contract §4.

import { RbacDenyError, assertCan } from '@cyberstrike/authz';
import { type AssessmentState, transitionsAvailable } from '@cyberstrike/contracts';
import { decodeCursor } from '@cyberstrike/db';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertOwnership } from '../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import type { RouteDeps } from '../shared.ts';

const idParam = z.string().uuid();

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

interface AssessmentRow {
  id: string;
  tenant_id: string;
  state: string;
  version: number;
  updated_at: Date;
}

const loadAssessmentById = async (deps: RouteDeps, id: string): Promise<AssessmentRow | null> => {
  const row = await deps.db
    .selectFrom('assessments')
    .select(['id', 'tenant_id', 'state', 'version', 'updated_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  return (row as unknown as AssessmentRow) ?? null;
};

const requireAssessmentRead = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<
  { ok: true; row: AssessmentRow; actorTenantId: string } | { ok: false; res: Response }
> => {
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
  if (!id.success) return { ok: false, res: c.json({ error: 'not_found' }, 404) };
  const row = await loadAssessmentById(deps, id.data);
  if (!row) return { ok: false, res: c.json({ error: 'not_found' }, 404) };
  assertOwnership(actor.tenantId, {
    resourceType: 'assessment',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });
  return { ok: true, row, actorTenantId: actor.tenantId };
};

// =============================================================================
// GET /assessments/:id/status — A-Asm-10
// =============================================================================

export const handleAssessmentStatus = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const r = await requireAssessmentRead(deps, c);
  if (!r.ok) return r.res;
  const { row } = r;
  return c.json({
    id: row.id,
    state: row.state,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    transitionsAvailable: transitionsAvailable(row.state as AssessmentState),
  });
};

// =============================================================================
// GET /assessments/:id/timeline — A-Asm-11 / R7
// =============================================================================

export const handleAssessmentTimeline = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const r = await requireAssessmentRead(deps, c);
  if (!r.ok) return r.res;
  const { row, actorTenantId } = r;

  const url = new URL(c.req.url);
  const rawQuery: Record<string, string> = {};
  for (const [k, v] of url.searchParams) rawQuery[k] = v;
  const queryParser = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z
        .string()
        .regex(/^[A-Za-z0-9+/=]+$/)
        .optional(),
    })
    .strict();
  const parsedQ = queryParser.safeParse(rawQuery);
  if (!parsedQ.success) return c.json({ error: 'invalid_query' }, 400);
  const cursor = parsedQ.data.cursor ? decodeCursor(parsedQ.data.cursor) : null;
  if (parsedQ.data.cursor && !cursor) return c.json({ error: 'invalid_query' }, 400);

  const page = await deps.repos.auditEventsForTenant.findForTenantPage({
    tenantId: actorTenantId,
    limit: parsedQ.data.limit,
    ...(cursor ? { cursor } : {}),
    resourceType: 'assessment',
    resourceId: row.id,
  });
  return c.json({
    rows: page.rows.map((rr) => ({
      id: rr.id,
      action: rr.action,
      occurredAt: rr.occurred_at.toISOString(),
      actorId: rr.actor_id,
      actorName: rr.actor_name,
      outcome: (rr.after_state as { outcome?: string } | null)?.outcome ?? '',
    })),
    nextCursor: page.nextCursor,
  });
};

// =============================================================================
// GET /assessments/:id/artifacts — A-Asm-12
// =============================================================================

export const handleAssessmentArtifacts = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const r = await requireAssessmentRead(deps, c);
  if (!r.ok) return r.res;
  const { row, actorTenantId } = r;
  const rows = await deps.db
    .selectFrom('assessment_artifacts')
    .selectAll()
    .where('tenant_id', '=', actorTenantId)
    .where('assessment_id', '=', row.id)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();
  return c.json({ data: rows, nextCursor: null });
};

// =============================================================================
// GET /assessments/:id/engine — A-Asm-13
// =============================================================================

export const handleAssessmentEngine = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const r = await requireAssessmentRead(deps, c);
  if (!r.ok) return r.res;
  return c.json({ engine: 'fake_decepticon', engineState: 'not_started' });
};
