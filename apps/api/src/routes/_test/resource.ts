// GET /_test/resource/:id — Sprint 3 C27, C28a-e + Sprint 4 A8.
//
// Loads a project row and runs `assertOwnership` against the actor's tenantId.
// On cross-tenant, `assertOwnership` throws `RbacDenyError` which is caught
// by the global Hono `onError` handler in factory.ts — that handler emits the
// deny audit row synchronously and returns the canonical 403 body. The route
// no longer catches the error itself (Sprint 3 implementation handled it
// locally; Sprint 4 centralises so every write route gets the same treatment).

import type { Context } from 'hono';
import { assertOwnership } from '../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import type { RouteDeps } from '../shared.ts';

export const handleTestResource = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) {
    return c.json({ error: 'unauthenticated' }, 401);
  }

  const id = c.req.param('id');
  if (!id) return c.json({ error: 'invalid_request' }, 400);

  const project = await deps.db
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!project) {
    // 404 leaks existence; canonicalise as 403 to match the cross-tenant exit.
    return c.json({ error: 'forbidden' }, 403);
  }

  // Lets RbacDenyError propagate to the global onError handler (factory.ts).
  // C18c body sanitisation + Sprint 4 A8 deny-audit emission both happen there.
  assertOwnership(actor.tenantId, {
    resourceType: 'project',
    resourceId: project.id,
    resourceTenantId: project.tenant_id,
  });

  return c.json({
    id: project.id,
    name: project.name,
    description: project.description,
  });
};
