import type { Context } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

const idParam = z.string().uuid();

const listQuerySchema = z.object({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  kind: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// =============================================================================
// GET /api/v1/scans/:id/findings
// =============================================================================

export const handleListScanFindings = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) return c.json({ error: 'unauthorized' }, 401);

  const parsed = idParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'not_found' }, 404);
  const scanId = parsed.data;

  // Verify tenant ownership of the scan (assessment).
  const assessment = await deps.db
    .selectFrom('assessments')
    .select(['id'])
    .where('id', '=', scanId)
    .where('tenant_id', '=', actor.tenantId)
    .executeTakeFirst();

  if (!assessment) return c.json({ error: 'not_found' }, 404);

  const q = listQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  const { severity, kind, page, limit } = q.success
    ? q.data
    : { severity: undefined, kind: undefined, page: 1, limit: 20 };

  // Load all matching findings and apply application-level filter.
  const allRows = await deps.db
    .selectFrom('findings')
    .selectAll()
    .where('assessment_id', '=', scanId)
    .where('tenant_id', '=', actor.tenantId)
    .orderBy('created_at', 'desc')
    .execute();

  const filtered = allRows.filter((r) => {
    if (severity && r.severity !== severity) return false;
    if (kind && r.type !== kind) return false;
    return true;
  });

  const total = filtered.length;
  const offset = (page - 1) * limit;
  const paged = filtered.slice(offset, offset + limit);

  const findings = paged.map((r) => ({
    id: r.id,
    assessmentId: r.assessment_id,
    type: r.type,
    severity: r.severity,
    confidence: r.confidence,
    status: r.status,
    affectedUrl: r.affected_url,
    reproduction: r.reproduction,
    validatedAt: r.validated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return c.json({ findings, total, page, limit });
};

// =============================================================================
// GET /api/v1/scans/:id/report.:format
// =============================================================================

export const handleScanReport = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) return c.json({ error: 'unauthorized' }, 401);

  const parsed = idParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'not_found' }, 404);
  const scanId = parsed.data;

  const format = c.req.param('format') as 'html' | 'pdf' | 'json' | 'zip';
  if (!['html', 'pdf', 'json', 'zip'].includes(format)) {
    return c.json({ error: 'invalid_format' }, 400);
  }

  // Verify tenant ownership.
  const assessment = await deps.db
    .selectFrom('assessments')
    .select(['id', 'project_id'])
    .where('id', '=', scanId)
    .where('tenant_id', '=', actor.tenantId)
    .executeTakeFirst();

  if (!assessment) return c.json({ error: 'not_found' }, 404);

  // Find the most recent ready report for this scan.
  const report = await deps.db
    .selectFrom('reports')
    .selectAll()
    .where('assessment_id', '=', scanId)
    .where('tenant_id', '=', actor.tenantId)
    .where('status', '=', 'ready')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  if (!report) return c.json({ error: 'report_not_ready' }, 404);

  if (!deps.objectStorage) return c.json({ error: 'object_storage_unavailable' }, 503);

  let objectKey: string | null = null;
  let contentType: string;
  let disposition: string | null = null;

  if (format === 'html') {
    objectKey = report.object_key_html;
    contentType = 'text/html; charset=utf-8';
  } else if (format === 'json') {
    objectKey = report.object_key_json;
    contentType = 'application/json';
  } else if (format === 'zip') {
    objectKey = report.object_key_zip;
    contentType = 'application/zip';
    disposition = `attachment; filename="report-${scanId}.zip"`;
  } else {
    // pdf — use zip artifact with pdf content type
    objectKey = report.object_key_zip;
    contentType = 'application/pdf';
    disposition = `attachment; filename="report-${scanId}.pdf"`;
  }

  if (!objectKey) return c.json({ error: 'report_artifact_missing' }, 500);

  let bytes: Buffer;
  try {
    bytes = await deps.objectStorage.get(objectKey);
  } catch {
    return c.json({ error: 'artifact_not_found' }, 404);
  }

  const traceId = newTraceId();
  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'report.downloaded',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'report',
    resourceId: report.id,
    assessmentId: scanId,
    projectId: assessment.project_id ?? null,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId,
    metadata: { format, scanId },
  });

  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (disposition) headers['Content-Disposition'] = disposition;

  return new Response(bytes, { status: 200, headers });
};
