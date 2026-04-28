// GET /_test/resource/:id — Sprint 3 C27, C28a-e.
//
// Sprint-3-only fixture endpoint exercising the full middleware-shape matrix
// (C28a: no cookie / C28b: deleted session / C28c: expired session / C28d:
// cross-tenant / C28e: positive control). Loads a project row and runs
// `assertOwnership` against the actor's tenantId; on cross-tenant the
// generic 403 body is returned (no UUIDs leaked — C18c).

import { RbacDenyError } from '@cyberstrike/authz';
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

  try {
    assertOwnership(actor.tenantId, {
      resourceType: 'project',
      resourceId: project.id,
      resourceTenantId: project.tenant_id,
    });
  } catch (err) {
    if (err instanceof RbacDenyError) {
      // C18c — body MUST NOT contain any UUID.
      return c.json({ error: 'forbidden' }, 403);
    }
    throw err;
  }

  return c.json({
    id: project.id,
    name: project.name,
    description: project.description,
  });
};
