// POST /auth/logout — Sprint 3 C23, C29.
//
// Idempotent: deletes the session row if present, clears the cookie either
// way. Audit row emitted with `outcome=success` when a session was deleted,
// `outcome=no_session` when the request had no live session.

import type { Context } from 'hono';
import { type CookieAttributes, buildClearCookieHeader } from '../../cookies.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import {
  type RouteDeps,
  audit,
  ensurePlatformTenantId,
  newTraceId,
  sourceIp,
  userAgent,
} from '../shared.ts';

const cookieAttrs = (deps: RouteDeps): CookieAttributes => ({
  name: deps.config.cookieName,
  secure: deps.config.cookieSecure,
});

export const handleLogout = async (deps: RouteDeps, c: Context<SessionEnv>): Promise<Response> => {
  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);
  const sessionId = c.get('sessionId');
  const actor = c.get('actor');
  const expired = c.get('sessionExpired');

  const clearHeader = buildClearCookieHeader(cookieAttrs(deps));

  if (!sessionId || (!actor && !expired)) {
    const platformTenantId = await ensurePlatformTenantId(deps);
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.logout',
      outcome: 'no_session',
      actorType: 'service',
      actorId: 'system',
      actorName: 'anonymous',
      resourceType: 'user_session',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': clearHeader },
    });
  }

  await deps.sessionRepo.invalidateById(sessionId);

  const tenantId = actor?.tenantId ?? (await ensurePlatformTenantId(deps));
  await audit(deps, {
    tenantId,
    action: 'auth.logout',
    outcome: 'success',
    actorType: actor ? 'user' : 'service',
    actorId: actor?.id ?? 'system',
    actorName: actor?.email ?? 'expired-session',
    resourceType: 'user_session',
    resourceId: sessionId,
    ip,
    userAgent: ua,
    traceId,
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': clearHeader },
  });
};
