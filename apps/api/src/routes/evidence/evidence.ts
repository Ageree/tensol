// Sprint 11 — evidence routes.
//
// Endpoints (all under /api/v1):
//   GET /evidence/:id              metadata + sha256; cross-tenant → 403 + audit
//   GET /findings/:id/evidence     list evidence for a finding

import { assertCan } from '@cyberstrike/authz';
import { listFindingEvidence } from '@cyberstrike/db';
import type { Context } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

const idParam = z.string().uuid();

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

export const handleGetEvidence = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  assertCan(actor, 'read', 'evidence');

  const parsed = idParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'invalid_evidence_id' }, 400);
  const evidenceId = parsed.data;

  // Load WITHOUT tenant filter to distinguish cross-tenant from not-found.
  const row = await deps.db
    .selectFrom('finding_evidence')
    .select(['id', 'finding_id', 'kind', 'object_storage_key', 'sha256', 'size_bytes', 'tenant_id'])
    .where('id', '=', evidenceId)
    .executeTakeFirst();

  if (!row) return c.json({ error: 'not_found' }, 404);

  const rowTenantId = String(row.tenant_id);
  if (rowTenantId !== actor.tenantId) {
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'rbac.deny',
      outcome: 'cross_tenant',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'evidence',
      resourceId: evidenceId,
      ip: sourceIp(c),
      userAgent: userAgent(c),
      traceId: newTraceId(),
      metadata: {
        reason: 'cross-tenant evidence access attempt',
        attemptedResourceTenantId: rowTenantId,
      },
    });
    return c.json({ error: 'forbidden' }, 403);
  }

  const objectKey = String(row.object_storage_key);
  const kind = String(row.kind);
  const wantsDownload = c.req.query('download') === '1';

  if (deps.objectStorage && (kind === 'screenshot' || wantsDownload)) {
    let bytes: Buffer;
    try {
      bytes = await deps.objectStorage.get(objectKey);
    } catch {
      return c.json({ error: 'object_not_found' }, 404);
    }
    const contentType = kind === 'screenshot' ? 'image/png' : 'application/octet-stream';
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': contentType, 'X-Sha256': String(row.sha256) },
    });
  }

  return c.json({
    evidence: {
      id: String(row.id),
      findingId: String(row.finding_id),
      kind,
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes),
      downloadUrl: `/api/v1/evidence/${evidenceId}?download=1`,
    },
  });
};

export const handleListFindingEvidence = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  assertCan(actor, 'list', 'evidence');

  const parsed = idParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'invalid_finding_id' }, 400);
  const findingId = parsed.data;

  const rows = await listFindingEvidence({ db: deps.db, tenantId: actor.tenantId, findingId });

  return c.json({
    evidence: rows.map((e) => ({
      id: e.id,
      findingId,
      kind: e.kind,
      sha256: e.sha256,
      sizeBytes: e.sizeBytes,
      downloadUrl: `/api/v1/evidence/${e.id}?download=1`,
    })),
  });
};
