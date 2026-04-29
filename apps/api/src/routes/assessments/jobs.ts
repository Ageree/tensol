// Sprint 7 §5.5 A-Q-Api-3 — GET /api/v1/assessments/:id/jobs.
//
// Read-only listing of jobs rows for an assessment. RBAC mirrors the
// timeline endpoint (Sprint 5 R7): tenant_admin, security_lead, operator,
// auditor, developer (project membership not enforced in Sprint 7;
// equivalent guard via assertOwnership against the assessment's tenant).

import { RbacDenyError, assertCan } from '@cyberstrike/authz';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertOwnership } from '../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import { loadAssessmentMeta } from '../../scope-engine/build-scope.ts';
import type { RouteDeps } from '../shared.ts';

const idParam = z.string().uuid();

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

interface JobRowPublic {
  id: string;
  kind: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  notBefore: string | null;
  traceId: string;
}

export const handleListAssessmentJobs = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const idResult = idParam.safeParse(c.req.param('id'));
  if (!idResult.success) {
    return c.json({ error: 'invalid_assessment_id' }, 400);
  }
  const assessmentId = idResult.data;

  // Existence + cross-tenant precedence — same pattern as scope-validate.
  const meta = await loadAssessmentMeta(deps.db, assessmentId);
  if (!meta) {
    return c.json({ error: 'not_found' }, 404);
  }
  assertOwnership(actor.tenantId, {
    resourceType: 'assessment',
    resourceId: meta.id,
    resourceTenantId: meta.tenantId,
  });

  // RBAC — re-use the same `read` action on `assessment` (Sprint 5 R7).
  const rbacDecision = assertCan(actor, 'read', 'assessment');
  if (!rbacDecision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'assessment',
      attemptedResourceId: meta.id,
      reason: `rbac: ${rbacDecision.reason}`,
    });
  }

  const rows = await deps.db
    .selectFrom('jobs')
    .select([
      'id',
      'kind',
      'status',
      'attempt',
      'max_attempts',
      'created_at',
      'updated_at',
      'last_error',
      'not_before',
      'trace_id',
    ])
    .where('tenant_id', '=', actor.tenantId)
    .where('assessment_id', '=', assessmentId)
    .orderBy('created_at', 'asc')
    .execute();

  const data: JobRowPublic[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    lastError: r.last_error,
    notBefore: r.not_before ? new Date(r.not_before).toISOString() : null,
    traceId: r.trace_id,
  }));

  return c.json({ data });
};
