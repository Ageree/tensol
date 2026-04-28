// GET /api/v1/audit-events — Sprint 4 A14 / A15.
//
// Per-tenant, paginated, redacted audit-events read API.
//
//   - tenantGuard authenticates → actor present.
//   - assertCan(actor, list, audit_log) → 403 + RbacDenyError → handled by
//     global onError (deny-audit row + canonical 403 body).
//   - Strict zod query schema (R8): {limit, cursor} only. Unknown keys → 400.
//   - Cursor (R2): opaque base64 of {occurredAt, id}; ORDER BY occurred_at
//     DESC, id DESC; monotonically decreasing.
//   - IP/userAgent redaction (R1): own-row → original; other-row → null.
//
// Sentinel exclusion (A11/A12) is enforced inside `auditEventsForTenant` —
// callers cannot bypass.

import { RbacDenyError, assertCan } from '@cyberstrike/authz';
import { type AuditEventsTable, decodeCursor } from '@cyberstrike/db';
import type { Context } from 'hono';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import type { RouteDeps } from '../shared.ts';

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9+/=]+$/)
      .optional(),
  })
  .strict();

interface PublicAuditRow {
  readonly id: string;
  readonly actor: { readonly type: string; readonly id: string; readonly name: string };
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: string;
  readonly traceId: string;
  readonly occurredAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: Record<string, unknown> | null;
}

const isOwnRow = (row: Selectable<AuditEventsTable>, actorId: string): boolean =>
  row.actor_type === 'user' && row.actor_id === actorId;

const projectRow = (row: Selectable<AuditEventsTable>, ownerActorId: string): PublicAuditRow => {
  const own = isOwnRow(row, ownerActorId);
  const after = (row.after_state ?? null) as Record<string, unknown> | null;
  const { outcome: outcomeRaw, ...rest } =
    (after as { outcome?: unknown } & Record<string, unknown>) ?? {};
  const outcome = typeof outcomeRaw === 'string' ? outcomeRaw : '';
  const metadataWithoutOutcome: Record<string, unknown> | null =
    after && Object.keys(rest).length > 0 ? rest : null;
  return {
    id: row.id,
    actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name },
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? null,
    outcome,
    traceId: row.trace_id,
    occurredAt: row.occurred_at.toISOString(),
    ip: own ? row.ip : null,
    userAgent: own ? row.user_agent : null,
    metadata:
      metadataWithoutOutcome && Object.keys(metadataWithoutOutcome).length > 0
        ? metadataWithoutOutcome
        : null,
  };
};

export const handleListAuditEvents = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) return c.json({ error: 'unauthenticated' }, 401);

  // RBAC gate — assertCan returns a Decision; on deny, throw RbacDenyError so
  // the global onError handler (A8) emits the deny audit row + 403 body.
  const decision = assertCan(actor, 'list', 'audit_log');
  if (!decision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'audit_log',
      reason: `rbac: ${decision.reason}`,
    });
  }

  // Strict query parsing — unknown keys → 400 invalid_query (R8).
  const rawQuery: Record<string, string> = {};
  const url = new URL(c.req.url);
  for (const [k, v] of url.searchParams) {
    rawQuery[k] = v;
  }
  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return c.json({ error: 'invalid_query' }, 400);
  }

  const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !cursor) {
    return c.json({ error: 'invalid_query' }, 400);
  }

  const page = await deps.repos.auditEventsForTenant.findForTenantPage(
    cursor
      ? { tenantId: actor.tenantId, limit: parsed.data.limit, cursor }
      : { tenantId: actor.tenantId, limit: parsed.data.limit },
  );

  return c.json({
    rows: page.rows.map((row) => projectRow(row, actor.id)),
    nextCursor: page.nextCursor,
  });
};
