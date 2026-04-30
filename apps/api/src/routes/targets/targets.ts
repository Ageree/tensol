// Sprint 5 §5.3 — targets routes.
//
// Endpoints (all under /api/v1):
//   - GET  /projects/:projectId/targets               list (A-Tgt-1)
//   - POST /projects/:projectId/targets               create (A-Tgt-2)
//   - GET  /targets/:id                               get (A-Tgt-3)
//   - PATCH /targets/:id                              update value (A-Tgt-4)
//   - DELETE /targets/:id                             hard-delete with reference-protection (A-Tgt-6)
//   - POST /targets/:id/ownership-proof               record claim + flip status to 'pending' (A-Tgt-5)
//   - GET  /targets/:id/observations                  Sprint 9 placeholder (A-Tgt-7)
//   - POST /assessments/:id/target-credentials        Sprint 16 B19 (A-16-CredentialCreate)
//
// Security invariants:
//   R1 — `evidence` capped at 8192 chars (zod schema).
//   ownership_status is server-stamped; clients cannot set it via create/patch
//   (.strict() on DTO; ownership-proof is the ONLY mutation path).

import { RbacDenyError, assertCan } from '@cyberstrike/authz';
import { CredentialSchema, encryptCredential, parseKek } from '@cyberstrike/browser-auth';
import {
  ownershipProofSchema,
  targetCreateSchema,
  targetPatchSchema,
} from '@cyberstrike/contracts';
import { insertTargetCredential } from '@cyberstrike/db';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertOwnership } from '../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import { decodeListCursor, encodeListCursor } from '../_helpers/pagination.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

type TargetRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  kind: string;
  value: string;
  ownership_status: string;
  created_at: Date;
  updated_at: Date;
  version: number;
};

type ProjectRow = {
  id: string;
  tenant_id: string;
};

const idParam = z.string().uuid();
const ifMatchHeader = z
  .string()
  .regex(/^\d+$/)
  .transform((v) => Number.parseInt(v, 10));

const targetListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9+/=]+$/)
      .optional(),
  })
  .strict();

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

const targetPublic = (row: TargetRow) => ({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  value: row.value,
  ownershipStatus: row.ownership_status,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const safeJson = async (c: Context<SessionEnv>): Promise<unknown | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

const isUniqueViolation = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === '23505';
};

const loadProjectById = async (deps: RouteDeps, id: string): Promise<ProjectRow | null> => {
  const row = await deps.db
    .selectFrom('projects')
    .select(['id', 'tenant_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row ?? null;
};

const loadTargetById = async (deps: RouteDeps, id: string): Promise<TargetRow | null> => {
  const row = await deps.db
    .selectFrom('targets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return (row as unknown as TargetRow) ?? null;
};

// =============================================================================
// GET /projects/:projectId/targets — A-Tgt-1
// =============================================================================

export const handleListTargets = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'list', 'target');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'target',
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
  const parsed = targetListQuery.safeParse(rawQuery);
  if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);

  const cursor = parsed.data.cursor ? decodeListCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !cursor) return c.json({ error: 'invalid_query' }, 400);

  let q = deps.db
    .selectFrom('targets')
    .selectAll()
    .where('tenant_id', '=', actor.tenantId)
    .where('project_id', '=', project.id)
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
  const rows = (await q.execute()) as TargetRow[];
  const hasMore = rows.length > parsed.data.limit;
  const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeListCursor({ createdAt: last.created_at.toISOString(), id: last.id })
      : null;

  return c.json({ data: page.map((r) => targetPublic(r)), nextCursor });
};

// =============================================================================
// POST /projects/:projectId/targets — A-Tgt-2
// =============================================================================

export const handleCreateTarget = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'create', 'target');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'target',
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
  const parsed = targetCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  let row: TargetRow;
  try {
    row = (await deps.db
      .insertInto('targets')
      .values({
        tenant_id: actor.tenantId,
        project_id: project.id,
        kind: parsed.data.kind,
        value: parsed.data.value,
        // A-Tgt-2: server stamps unverified; client field already rejected by .strict().
        ownership_status: 'unverified',
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as TargetRow;
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'duplicate_target' }, 409);
    throw err;
  }

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'target.created',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: row.id,
    projectId: project.id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    metadata: { kind: row.kind },
  });

  return c.json(targetPublic(row), 201);
};

// =============================================================================
// GET /targets/:id — A-Tgt-3
// =============================================================================

export const handleGetTarget = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'read', 'target');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'target',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const row = await loadTargetById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'target',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  return c.json(targetPublic(row));
};

// =============================================================================
// PATCH /targets/:id — A-Tgt-4
// =============================================================================

export const handlePatchTarget = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'update', 'target');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'target',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = targetPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const row = await loadTargetById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'target',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  // Optimistic lock — versioned table.
  const ifMatch = c.req.header('if-match') ?? c.req.header('If-Match');
  if (!ifMatch) return c.json({ error: 'if_match_required' }, 428);
  const provided = ifMatchHeader.safeParse(ifMatch);
  if (!provided.success || provided.data !== row.version) {
    return c.json({ error: 'version_mismatch' }, 409);
  }

  let updated: TargetRow;
  try {
    updated = (await deps.repos.targets.update(
      actor.tenantId,
      row.id,
      { value: parsed.data.value },
      provided.data,
    )) as unknown as TargetRow;
    void updated;
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'duplicate_target' }, 409);
    // OptimisticLockError → 409 version_mismatch.
    if (err instanceof Error && err.name === 'OptimisticLockError') {
      return c.json({ error: 'version_mismatch' }, 409);
    }
    throw err;
  }
  const refreshed = await loadTargetById(deps, row.id);
  if (!refreshed) return c.json({ error: 'not_found' }, 404);

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'target.updated',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: refreshed.id,
    projectId: refreshed.project_id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
  });

  return c.json(targetPublic(refreshed));
};

// =============================================================================
// DELETE /targets/:id — A-Tgt-6 (hard delete; 409 if referenced)
// =============================================================================

export const handleDeleteTarget = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'delete', 'target');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'target',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const row = await loadTargetById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'target',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  // A-Tgt-6 — refuse if referenced by any assessment.
  const ref = await deps.db
    .selectFrom('assessment_targets')
    .where('tenant_id', '=', actor.tenantId)
    .where('target_id', '=', row.id)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  if (Number(ref.count) > 0) return c.json({ error: 'target_referenced' }, 409);

  await deps.db
    .deleteFrom('targets')
    .where('tenant_id', '=', actor.tenantId)
    .where('id', '=', row.id)
    .execute();

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'target.deleted',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: row.id,
    projectId: row.project_id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
  });

  return new Response(null, { status: 204 });
};

// =============================================================================
// POST /targets/:id/ownership-proof — A-Tgt-5
// =============================================================================

export const handleOwnershipProof = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  // RBAC — same gate as target.update (security_lead, tenant_admin).
  const decision = assertCan(actor, 'update', 'target');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'target',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = ownershipProofSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const row = await loadTargetById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'target',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  // Append claim + flip ownership_status='pending' atomically.
  await deps.db.transaction().execute(async (tx) => {
    await tx
      .insertInto('target_ownership_claims')
      .values({
        tenant_id: actor.tenantId,
        target_id: row.id,
        method: parsed.data.method,
        evidence: parsed.data.evidence,
        submitted_by_user_id: actor.id,
      })
      .execute();
    if (row.ownership_status !== 'pending') {
      await tx
        .updateTable('targets')
        .set({ ownership_status: 'pending' })
        .where('tenant_id', '=', actor.tenantId)
        .where('id', '=', row.id)
        .execute();
    }
  });

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'target.ownership_proof.submitted',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: row.id,
    projectId: row.project_id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    // A-Audit-3: evidence content NEVER goes in the audit row.
    metadata: { method: parsed.data.method, evidenceLength: parsed.data.evidence.length },
  });

  return c.json({ status: 'pending' }, 202);
};

// =============================================================================
// GET /targets/:id/observations — A-Tgt-7 (Sprint 9 placeholder)
// =============================================================================

export const handleListObservations = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const decision = assertCan(actor, 'read', 'target');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'target',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const id = idParam.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not_found' }, 404);

  const row = await loadTargetById(deps, id.data);
  if (!row) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'target',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  // Sprint 9 lands real observation rows; this endpoint exists for UI stability.
  return c.json({ data: [], nextCursor: null });
};

// =============================================================================
// POST /assessments/:id/target-credentials — B19 (A-16-CredentialCreate)
// =============================================================================

const targetCredentialBodySchema = CredentialSchema.extend({
  targetId: z.string().uuid(),
  recipeId: z.string().uuid(),
}).strict();

const loadAssessmentTenantById = async (
  deps: RouteDeps,
  id: string,
): Promise<{ id: string; tenant_id: string } | null> => {
  const row = await deps.db
    .selectFrom('assessments')
    .select(['id', 'tenant_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row ?? null;
};

export const handleCreateTargetCredential = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  // RBAC check — assertCan before any DB load (fail fast).
  const decision = assertCan(actor, 'create', 'target_credential');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'target_credential',
      reason: `rbac: ${decision.reason}`,
    });
  }

  const assessmentId = idParam.safeParse(c.req.param('id'));
  if (!assessmentId.success) return c.json({ error: 'not_found' }, 404);

  // Cross-tenant ownership check.
  const assessment = await loadAssessmentTenantById(deps, assessmentId.data);
  if (!assessment) return c.json({ error: 'not_found' }, 404);
  assertOwnership(actor.tenantId, {
    resourceType: 'assessment',
    resourceId: assessment.id,
    resourceTenantId: assessment.tenant_id,
  });

  // Validate body.
  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = targetCredentialBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  // KEK from env — 500 if absent (misconfiguration).
  const { CREDENTIAL_KEK } = process.env;
  const kek = parseKek(CREDENTIAL_KEK);

  // Encrypt credentials (AES-256-GCM).
  const blob = encryptCredential(
    JSON.stringify({ username: parsed.data.username, password: parsed.data.password }),
    kek,
  );

  // Persist — immutable row (trigger enforces no UPDATE/DELETE).
  const { id } = await insertTargetCredential({
    db: deps.db,
    tenantId: actor.tenantId,
    targetId: parsed.data.targetId,
    recipeId: parsed.data.recipeId,
    encryptedBlob: blob.ciphertext,
    iv: blob.iv,
    authTag: blob.authTag,
    createdBy: actor.id,
  });

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'auth.credential.encrypted',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target_credential',
    resourceId: id,
    assessmentId: assessment.id,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    metadata: { targetId: parsed.data.targetId, recipeId: parsed.data.recipeId },
  });

  return c.json({ id }, 201);
};
