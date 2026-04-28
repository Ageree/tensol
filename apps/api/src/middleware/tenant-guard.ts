// Sprint 3 contract C17/C28 — tenantGuard middleware.
//
// Sits AFTER `sessionMiddleware`. Validates that an authenticated actor is
// present and the session is not expired. Returns canonical responses:
//   - no actor + no session       → 401 {error: 'unauthenticated'}
//   - no actor + expired session  → 401 {error: 'session_expired'}
//   - actor present                → next()
//
// C19 — error bodies are intentionally minimal (no email, no UUIDs).
// C28a-c assertions cover the three negative branches end-to-end.

import type { Context, MiddlewareHandler } from 'hono';
import type { SessionEnv } from './session.ts';

export const tenantGuard = (): MiddlewareHandler<SessionEnv> => {
  return async (c: Context<SessionEnv>, next) => {
    const expired = c.get('sessionExpired') === true;
    const actor = c.get('actor');

    if (!actor) {
      if (expired) {
        return c.json({ error: 'session_expired' }, 401);
      }
      return c.json({ error: 'unauthenticated' }, 401);
    }
    await next();
    return;
  };
};
