// POST /api/v1/domains/verify/start  — issues a DNS-TXT verification token for a target.
// GET  /api/v1/domains/verify/check  — checks DNS TXT record and flips ownership status.
//
// P46: DnsResolver is DI-injected via RouteDeps.dnsResolver.
//      Production binding: node:dns/promises.resolveTxt (set in factory.ts).
//      Test override: inline object — NO env-flag branches here.

import type { Context } from 'hono';
import { z } from 'zod';
import { assertOwnership } from '../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

export interface TxtDnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

const idSchema = z.string().uuid();

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

const safeJson = async (c: Context<SessionEnv>): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

const randomHex = (bytes: number): string => {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
};

// =============================================================================
// POST /api/v1/domains/verify/start — A-25-5
// =============================================================================

export const handleVerifyStart = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);

  const raw = await safeJson(c);
  const parsed = z.object({ targetId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

  const { targetId } = parsed.data;

  const target = await deps.db
    .selectFrom('targets')
    .select(['id', 'tenant_id', 'kind', 'value'])
    .where('id', '=', targetId)
    .executeTakeFirst();

  if (!target) return c.json({ error: 'not_found' }, 404);

  assertOwnership(actor.tenantId, {
    resourceType: 'target',
    resourceId: target.id,
    resourceTenantId: target.tenant_id,
  });

  if (target.kind !== 'domain') return c.json({ error: 'target_not_domain' }, 422);

  const domain = target.value;

  const existing = await deps.db
    .selectFrom('domain_verifications')
    .selectAll()
    .where('target_id', '=', targetId)
    .executeTakeFirst();

  if (existing) {
    if (existing.status === 'verified') {
      return c.json({ alreadyVerified: true }, 200);
    }
    if (existing.status === 'pending' && new Date(existing.expires_at) > new Date()) {
      return c.json(
        {
          token: existing.token,
          instructions: `Add a DNS TXT record: _cs-verify.${domain} → ${existing.token}`,
          expires_at: new Date(existing.expires_at).toISOString(),
        },
        200,
      );
    }
    // Expired or status='expired' — delete and re-create.
    await deps.db.deleteFrom('domain_verifications').where('id', '=', existing.id).execute();
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'domain.verify.expired',
      outcome: 'success',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'target',
      resourceId: targetId,
      ip,
      userAgent: ua,
      traceId,
      metadata: { domain, reason: 'token_expired_at_start' },
    });
  }

  const token = `cs-verify=${randomHex(32)}`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await deps.db
    .insertInto('domain_verifications')
    .values({
      tenant_id: actor.tenantId,
      target_id: targetId,
      domain,
      token,
      status: 'pending',
      expires_at: expiresAt,
    })
    .execute();

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'domain.verify.requested',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: targetId,
    ip,
    userAgent: ua,
    traceId,
    metadata: { domain, expires_at: expiresAt.toISOString() },
  });

  return c.json(
    {
      token,
      instructions: `Add a DNS TXT record: _cs-verify.${domain} → ${token}`,
      expires_at: expiresAt.toISOString(),
    },
    201,
  );
};

// =============================================================================
// GET /api/v1/domains/verify/check — A-25-6
// =============================================================================

export const handleVerifyCheck = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);

  const url = new URL(c.req.url);
  const targetIdRaw = url.searchParams.get('targetId');
  const targetIdParsed = idSchema.safeParse(targetIdRaw);
  if (!targetIdParsed.success) return c.json({ error: 'invalid_query' }, 400);
  const targetId = targetIdParsed.data;

  const row = await deps.db
    .selectFrom('domain_verifications')
    .selectAll()
    .where('target_id', '=', targetId)
    .executeTakeFirst();

  if (!row) return c.json({ error: 'verification_not_found' }, 404);

  assertOwnership(actor.tenantId, {
    resourceType: 'domain_verification',
    resourceId: row.id,
    resourceTenantId: row.tenant_id,
  });

  if (row.status === 'verified') {
    return c.json(
      {
        status: 'verified',
        verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
      },
      200,
    );
  }

  if (new Date(row.expires_at) <= new Date()) {
    await deps.db
      .updateTable('domain_verifications')
      .set({ status: 'expired', updated_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'domain.verify.expired',
      outcome: 'failure',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'target',
      resourceId: targetId,
      ip,
      userAgent: ua,
      traceId,
      metadata: { domain: row.domain },
    });
    return c.json({ error: 'token_expired' }, 410);
  }

  let txtRecords: string[][];
  try {
    txtRecords = await deps.dnsResolver.resolveTxt(`_cs-verify.${row.domain}`);
  } catch {
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'domain.verify.failed',
      outcome: 'failure',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'target',
      resourceId: targetId,
      ip,
      userAgent: ua,
      traceId,
      metadata: { domain: row.domain, reason: 'dns_lookup_error' },
    });
    return c.json({ error: 'dns_lookup_failed' }, 502);
  }

  // Emit 'checked' for every DNS lookup performed (M1 fix: join multi-part parts).
  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'domain.verify.checked',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: targetId,
    ip,
    userAgent: ua,
    traceId,
    metadata: { domain: row.domain },
  });

  const tokenFound = txtRecords.some((parts) => parts.join('') === row.token);

  if (!tokenFound) {
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'domain.verify.failed',
      outcome: 'failure',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'target',
      resourceId: targetId,
      ip,
      userAgent: ua,
      traceId,
      metadata: { domain: row.domain, reason: 'token_not_found' },
    });
    return c.json({ status: 'pending' }, 200);
  }

  // Token found — atomically flip both statuses.
  const now = new Date();
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('domain_verifications')
      .set({ status: 'verified', verified_at: now, updated_at: now })
      .where('id', '=', row.id)
      .execute();
    await trx
      .updateTable('targets')
      .set({ ownership_status: 'verified', updated_at: now })
      .where('id', '=', targetId)
      .execute();
  });

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'domain.verify.confirmed',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: targetId,
    ip,
    userAgent: ua,
    traceId,
    metadata: { domain: row.domain },
  });

  return c.json({ status: 'verified' }, 200);
};
