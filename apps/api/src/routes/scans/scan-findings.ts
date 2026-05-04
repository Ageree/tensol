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

  const severityNorm = severity?.toLowerCase();
  const kindNorm = kind?.toLowerCase();
  const filtered = allRows.filter((r) => {
    if (severityNorm && r.severity.toLowerCase() !== severityNorm) return false;
    if (kindNorm && r.type.toLowerCase() !== kindNorm) return false;
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

  const formatRaw = c.req.param('format');
  const formatParsed = z.enum(['html', 'json', 'zip']).safeParse(formatRaw);
  if (!formatParsed.success) return c.json({ error: 'invalid_format' }, 400);
  const format = formatParsed.data;

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

  if (!report) return c.json({ error: 'report_not_ready' }, 409);

  if (!deps.objectStorage) return c.json({ error: 'object_storage_unavailable' }, 503);

  const objectKeyMap = {
    html: report.object_key_html as string | null,
    json: report.object_key_json as string | null,
    zip: report.object_key_zip as string | null,
  };
  const contentTypeMap = {
    html: 'text/html; charset=utf-8',
    json: 'application/json',
    zip: 'application/zip',
  };

  const objectKey = objectKeyMap[format];
  const contentType = contentTypeMap[format];
  const disposition =
    format !== 'html' ? `attachment; filename="report-${scanId}.${format}"` : null;

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
    resourceId: String(report.id),
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
