// Sprint 11 — findings routes.
//
// Endpoints (all under /api/v1):
//   GET  /assessments/:id/findings        list confirmed findings for assessment
//   GET  /findings/:id                    get single finding (tenant-scoped)
//   PATCH /findings/:id/status            update finding status; emits audit

import { assertCan } from '@cyberstrike/authz';
import {
  FINDING_STATUSES,
  getFinding,
  listFindingsByAssessment,
  updateFindingStatus,
} from '@cyberstrike/db';
import type { Context } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

const idParam = z.string().uuid();

const findingStatusSchema = z.enum(FINDING_STATUSES as [string, ...string[]]);

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

const findingPublic = (row: Awaited<ReturnType<typeof getFinding>>) => {
  if (!row) return null;
  return {
    id: row.id,
    assessmentId: row.assessmentId,
    type: row.type,
    severity: row.severity,
    confidence: row.confidence,
    status: row.status,
    affectedUrl: row.affectedUrl,
    reproduction: row.reproduction,
    validatorLog: row.validatorLog,
    validatedAt: row.validatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

export const handleListAssessmentFindings = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  assertCan(actor, 'list', 'finding');

  const parsed = idParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'invalid_assessment_id' }, 400);
  const assessmentId = parsed.data;

  const rows = await listFindingsByAssessment({
    db: deps.db,
    tenantId: actor.tenantId,
    assessmentId,
  });

  return c.json({ findings: rows.map(findingPublic) });
};

export const handleGetFinding = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  assertCan(actor, 'read', 'finding');

  const parsed = idParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'invalid_finding_id' }, 400);
  const findingId = parsed.data;

  const row = await getFinding({ db: deps.db, tenantId: actor.tenantId, findingId });
  if (!row) return c.json({ error: 'not_found' }, 404);

  return c.json({ finding: findingPublic(row) });
};

export const handlePatchFindingStatus = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  assertCan(actor, 'change_status', 'finding');

  const parsed = idParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'invalid_finding_id' }, 400);
  const findingId = parsed.data;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const bodyParsed = z.object({ status: findingStatusSchema }).safeParse(body);
  if (!bodyParsed.success) return c.json({ error: 'invalid_status' }, 422);

  const newStatus = bodyParsed.data.status;

  const existing = await getFinding({ db: deps.db, tenantId: actor.tenantId, findingId });
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const oldStatus = existing.status;

  const result = await updateFindingStatus({
    db: deps.db,
    tenantId: actor.tenantId,
    findingId,
    status: newStatus as (typeof FINDING_STATUSES)[number],
  });

  if (!result.updated) return c.json({ error: 'not_found' }, 404);

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'finding.status_changed',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'finding',
    resourceId: findingId,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    metadata: { oldStatus, newStatus, assessmentId: existing.assessmentId },
  });

  const updated = await getFinding({ db: deps.db, tenantId: actor.tenantId, findingId });
  return c.json({ finding: findingPublic(updated) });
};
