import type { Context } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

const checkoutSchema = z
  .object({
    tier: z.enum(['light', 'medium', 'aggressive']),
  })
  .strict();

// =============================================================================
// POST /api/v1/billing/checkout — UPSERT subscription tier
// =============================================================================

export const handleBillingCheckout = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { tier } = parsed.data;

  await deps.db
    .insertInto('subscriptions')
    .values({
      tenant_id: actor.tenantId,
      tier,
      status: 'active',
    })
    .onConflict((oc) =>
      oc.column('tenant_id').doUpdateSet({
        tier,
        status: 'active',
        updated_at: new Date(),
      }),
    )
    .execute();

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'billing.checkout.completed',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'subscription',
    resourceId: actor.tenantId,
    ip: sourceIp(c),
    userAgent: userAgent(c),
    traceId: newTraceId(),
    metadata: { tier },
  });

  return c.json({ success: true, tier });
};

// =============================================================================
// GET /api/v1/billing/subscription — read current subscription
// =============================================================================

export const handleGetSubscription = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const row = await deps.db
    .selectFrom('subscriptions')
    .select(['tier', 'status'])
    .where('tenant_id', '=', actor.tenantId)
    .executeTakeFirst();

  if (!row) return c.json({ tier: null, status: 'none' });

  return c.json({ tier: row.tier, status: row.status });
};
