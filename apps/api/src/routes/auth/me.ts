// GET /auth/me — Sprint 3 C24.
//
// Returns the actor + tenant slug for an authenticated session. Sits behind
// `tenantGuard` so 401 cases are handled uniformly.

import type { Context } from 'hono';
import type { SessionEnv } from '../../middleware/session.ts';
import type { RouteDeps } from '../shared.ts';

export const handleMe = async (deps: RouteDeps, c: Context<SessionEnv>): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) {
    // Should be unreachable behind tenantGuard, but defensive.
    return c.json({ error: 'unauthenticated' }, 401);
  }

  const tenant = await deps.db
    .selectFrom('tenants')
    .select(['id', 'slug'])
    .where('id', '=', actor.tenantId)
    .executeTakeFirst();

  return c.json({
    actor: {
      id: actor.id,
      email: actor.email,
      role: actor.role,
      tenantId: actor.tenantId,
    },
    tenant: tenant ? { id: tenant.id, slug: tenant.slug } : null,
  });
};
