// Sprint 3 contract C17 — session middleware.
//
// Reads the session cookie; if present, looks up `user_sessions` via the
// SessionRepo (which validates bcrypt(token) → token_hash). Loads the user
// row and attaches `actor` + `tenantId` to the Hono context. On miss, sets
// `actor = null`.
//
// Routes that require auth use `tenantGuard` (next file) which returns 401 /
// 403 on missing or expired session. This middleware is silent — it just
// populates context.

import type { UserActor } from '@cyberstrike/authz';
import type { Database } from '@cyberstrike/db';
import type { Context, MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import { readSessionCookie } from '../cookies.ts';
import type { SessionRepo } from '../session-repo.ts';

export interface SessionMiddlewareDeps {
  readonly cookieName: string;
  readonly sessionRepo: SessionRepo;
  readonly db: Kysely<Database>;
}

export type SessionEnv = {
  Variables: {
    actor: UserActor | null;
    sessionId: string | null;
    sessionExpired: boolean;
  };
};

export const sessionMiddleware = (deps: SessionMiddlewareDeps): MiddlewareHandler<SessionEnv> => {
  return async (c: Context<SessionEnv>, next) => {
    c.set('actor', null);
    c.set('sessionId', null);
    c.set('sessionExpired', false);

    const cookieHeader = c.req.header('cookie');
    const cookieValue = readSessionCookie(cookieHeader, deps.cookieName);
    if (!cookieValue) {
      await next();
      return;
    }

    const lookup = await deps.sessionRepo.findByCookieValue(cookieValue);
    if (!lookup) {
      await next();
      return;
    }

    const sess = lookup.session as unknown as {
      id: string;
      user_id: string;
      tenant_id: string;
      expires_at: Date;
    };
    if (sess.expires_at.getTime() <= Date.now()) {
      c.set('sessionExpired', true);
      c.set('sessionId', sess.id);
      await next();
      return;
    }

    const userRow = await deps.db
      .selectFrom('users')
      .select(['id', 'tenant_id', 'email', 'display_name', 'role', 'status'])
      .where('id', '=', sess.user_id)
      .executeTakeFirst();

    if (!userRow || userRow.status !== 'active') {
      await next();
      return;
    }

    const actor: UserActor = {
      type: 'user',
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.display_name,
      role: userRow.role as UserActor['role'],
      tenantId: userRow.tenant_id,
    };
    c.set('actor', actor);
    c.set('sessionId', sess.id);

    await next();
  };
};
