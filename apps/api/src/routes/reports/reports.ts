// Sprint 14 — report routes.
//
// POST /assessments/:id/reports  → enqueue build, return report_id + status
// GET  /reports/:id              → status + download URL when ready
// GET  /reports/:id/download     → stream bytes from object storage

import { RbacDenyError, assertCan } from '@cyberstrike/authz';
import {
  findReportByIdCrossTenant,
  findReportByIdempotencyKey,
  insertReport,
} from '@cyberstrike/db';
import type { Context } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

const uuidParam = z.string().uuid();

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

const isUniqueViolation = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as Error).message ?? '');
  return msg.includes('23505') || msg.includes('duplicate key value');
};

// ============================================================================
// POST /assessments/:id/reports
// ============================================================================

export const handleBuildReport = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const createDecision = assertCan(actor, 'create', 'report');
  if (!createDecision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'report',
      reason: `rbac: ${createDecision.reason}`,
    });
  }

  const parsedId = uuidParam.safeParse(c.req.param('id'));
  if (!parsedId.success) return c.json({ error: 'invalid_assessment_id' }, 400);
  const assessmentId = parsedId.data;

  // Idempotency-Key required (S5 middleware already validates + caches — this
  // check is defence-in-depth for code paths that bypass middleware in tests).
  const idempotencyKey = c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key') ?? null;
  if (!idempotencyKey) return c.json({ error: 'idempotency_key_required' }, 400);

  // Load assessment — tenant-scoped.
  const assessment = await deps.db
    .selectFrom('assessments')
    .select(['id', 'project_id', 'tenant_id'])
    .where('id', '=', assessmentId)
    .where('tenant_id', '=', actor.tenantId)
    .executeTakeFirst();
  if (!assessment) return c.json({ error: 'assessment_not_found' }, 404);

  // Idempotency: same key → same report_id.
  const scopedKey = `report.build:${idempotencyKey}`;
  const existing = await findReportByIdempotencyKey({
    db: deps.db,
    tenantId: actor.tenantId,
    idempotencyKey: scopedKey,
  });
  if (existing) {
    return c.json({ reportId: existing.id, status: existing.status }, 202);
  }

  // Insert report row (status=queued).
  let reportId: string;
  try {
    const inserted = await insertReport({
      db: deps.db,
      tenantId: actor.tenantId,
      assessmentId,
      idempotencyKey: scopedKey,
    });
    reportId = inserted.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Concurrent POST with same key — re-read and return existing.
      const race = await findReportByIdempotencyKey({
        db: deps.db,
        tenantId: actor.tenantId,
        idempotencyKey: scopedKey,
      });
      if (race) return c.json({ reportId: race.id, status: race.status }, 202);
    }
    throw err;
  }

  // Enqueue `report.build` job via outbox pattern (jobs table).
  const traceId = newTraceId();
  const jobIdemKey = `report.build:${reportId}`;
  // biome-ignore lint/suspicious/noExplicitAny: pg expects text for jsonb column.
  const payload: any = JSON.stringify({
    tenantId: actor.tenantId,
    projectId: assessment.project_id ?? null,
    assessmentId,
    reportId,
    traceId,
  });

  try {
    await deps.db
      .insertInto('jobs')
      .values({
        tenant_id: actor.tenantId,
        project_id: assessment.project_id ?? null,
        assessment_id: assessmentId,
        kind: 'report.build',
        status: 'pending',
        attempt: 0,
        max_attempts: 3,
        idempotency_key: jobIdemKey,
        not_before: null,
        trace_id: traceId,
        payload,
      })
      .execute();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Duplicate job — idempotent, proceed.
  }

  // Emit report.build.requested audit.
  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'report.build.requested',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'report',
    resourceId: reportId,
    projectId: assessment.project_id ?? null,
    assessmentId,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId,
    metadata: { idempotencyKey: scopedKey },
  });

  return c.json({ reportId, status: 'queued' }, 202);
};

// ============================================================================
// GET /reports/:id
// ============================================================================

export const handleGetReport = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const readDecision = assertCan(actor, 'read', 'report');
  if (!readDecision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'report',
      reason: `rbac: ${readDecision.reason}`,
    });
  }

  const parsedId = uuidParam.safeParse(c.req.param('id'));
  if (!parsedId.success) return c.json({ error: 'invalid_report_id' }, 400);
  const reportId = parsedId.data;

  // Load without tenant filter to distinguish cross-tenant from not-found.
  const row = await findReportByIdCrossTenant({ db: deps.db, reportId });
  if (!row) return c.json({ error: 'not_found' }, 404);

  // Cross-tenant → 404 (don't leak existence).
  if (row.tenantId !== actor.tenantId) {
    return c.json({ error: 'not_found' }, 404);
  }

  return c.json({
    report: {
      id: row.id,
      assessmentId: row.assessmentId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      failureReason: row.failureReason,
      sha256Html: row.status === 'ready' ? row.sha256Html : undefined,
      sha256Json: row.status === 'ready' ? row.sha256Json : undefined,
      sha256Zip: row.status === 'ready' ? row.sha256Zip : undefined,
      downloadUrl: row.status === 'ready' ? `/api/v1/reports/${reportId}/download` : undefined,
    },
  });
};

// ============================================================================
// GET /reports/:id/download
// ============================================================================

export const handleDownloadReport = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const dlDecision = assertCan(actor, 'read', 'report');
  if (!dlDecision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'report',
      reason: `rbac: ${dlDecision.reason}`,
    });
  }

  const parsedId = uuidParam.safeParse(c.req.param('id'));
  if (!parsedId.success) return c.json({ error: 'invalid_report_id' }, 400);
  const reportId = parsedId.data;

  const row = await findReportByIdCrossTenant({ db: deps.db, reportId });
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.tenantId !== actor.tenantId) return c.json({ error: 'not_found' }, 404);
  if (row.status !== 'ready') return c.json({ error: 'report_not_ready' }, 409);
  if (!row.objectKeyZip) return c.json({ error: 'report_artifact_missing' }, 500);

  if (!deps.objectStorage) return c.json({ error: 'object_storage_unavailable' }, 503);

  let bytes: Buffer;
  try {
    bytes = await deps.objectStorage.get(row.objectKeyZip);
  } catch {
    return c.json({ error: 'artifact_not_found' }, 404);
  }

  // Emit report.downloaded audit.
  const traceId = newTraceId();
  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'report.downloaded',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'report',
    resourceId: reportId,
    assessmentId: row.assessmentId,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId,
    metadata: { sha256Zip: row.sha256Zip },
  });

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="report-${reportId}.zip"`,
      'X-Sha256': row.sha256Zip ?? '',
    },
  });
};
