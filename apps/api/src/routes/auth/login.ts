// POST /auth/login — Sprint 3 C18b, C19, C20, C22 (R2), C26 (R7), C29.
//
// Two-step protocol step 1. Outcomes:
//   valid + MFA enrolled  → 401 + {pre_auth_token, expires_in: 60}
//                            audit `outcome=mfa_required`
//   valid + no MFA        → 200 + Set-Cookie + {actor}
//                            audit `outcome=success`
//   invalid (any reason)  → 401 + canonical body  (audit `outcome=failure`)
//   rate-limited          → 429 + {retry_after_seconds}
//
// C26 (R7) — `dummyVerify` runs whenever the user is missing so the response
// time has the same wall-clock envelope as a real verify.

import type { Database, UsersTable } from '@cyberstrike/db';
import type { Context } from 'hono';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import {
  type CookieAttributes,
  buildSetCookieHeader,
  mintSessionTokenPlaintext,
} from '../../cookies.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import { SessionRepo } from '../../session-repo.ts';
import {
  type RouteDeps,
  audit,
  canonical401Body,
  ensurePlatformTenantId,
  newTraceId,
  sourceIp,
  userAgent,
} from '../shared.ts';

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour, fixed (sliding refresh in Sprint 5)

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const cookieAttrs = (deps: RouteDeps): CookieAttributes => ({
  name: deps.config.cookieName,
  secure: deps.config.cookieSecure,
});

const findUserByEmail = async (
  db: Kysely<Database>,
  email: string,
): Promise<Selectable<UsersTable> | undefined> =>
  db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();

const isMfaEnrolled = async (db: Kysely<Database>, userId: string): Promise<boolean> => {
  const row = await db
    .selectFrom('mfa_secrets')
    .select(['id'])
    .where('user_id', '=', userId)
    .where('enrolled_at', 'is not', null)
    .executeTakeFirst();
  return !!row;
};

export const issueSessionCookie = async (
  deps: RouteDeps,
  user: Pick<Selectable<UsersTable>, 'id' | 'tenant_id'>,
  ip: string,
  ua: string | null,
): Promise<{ headerValue: string; sessionId: string }> => {
  const minted = mintSessionTokenPlaintext();
  const cookieValue = SessionRepo.formatCookieValue(user.id, minted.plaintext);
  const expiresAt = new Date((deps.nowMs?.() ?? Date.now()) + SESSION_TTL_MS);
  const issued = await deps.sessionRepo.issue({
    tenantId: user.tenant_id,
    userId: user.id,
    plaintext: minted.plaintext,
    expiresAt,
    ip,
    userAgent: ua,
  });
  const headerValue = buildSetCookieHeader(cookieAttrs(deps), cookieValue, expiresAt);
  return { headerValue, sessionId: issued.id };
};

export const handleLogin = async (deps: RouteDeps, c: Context<SessionEnv>): Promise<Response> => {
  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.json(canonical401Body(), 401);
  }

  // C18b — count as "failure" up-front; reset the bucket on success.
  const verdict = deps.rateLimiter.recordFailureAndCheck(ip);
  if (verdict.rejected) {
    return c.json({ error: 'too_many_requests', retry_after_seconds: verdict.retryAfter }, 429);
  }

  const user = await findUserByEmail(deps.db, body.email);

  // C26 (R7) — flatten timing on user-miss with bcrypt-equivalent dummy work.
  if (!user) {
    await deps.hasher.dummyVerify(body.password);
    // Audit failure with actor unknown — use platform tenant + 'system' actor
    // so the row still satisfies the audit_events.tenant_id FK.
    const platformTenantId = await ensurePlatformTenantId(deps);
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.login.password',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'system',
      actorName: body.email,
      resourceType: 'user',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'unknown_email' },
    });
    return c.json(canonical401Body(), 401);
  }

  if (user.status !== 'active') {
    // Treat as a generic credential failure to avoid status-based oracle.
    await deps.hasher.dummyVerify(body.password);
    await audit(deps, {
      tenantId: user.tenant_id,
      action: 'auth.login.password',
      outcome: 'failure',
      actorType: 'user',
      actorId: user.id,
      actorName: user.email,
      resourceType: 'user',
      resourceId: user.id,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'user_inactive' },
    });
    return c.json(canonical401Body(), 401);
  }

  const ok = await deps.hasher.verify(body.password, user.password_hash);
  if (!ok) {
    await audit(deps, {
      tenantId: user.tenant_id,
      action: 'auth.login.password',
      outcome: 'failure',
      actorType: 'user',
      actorId: user.id,
      actorName: user.email,
      resourceType: 'user',
      resourceId: user.id,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'bad_password' },
    });
    return c.json(canonical401Body(), 401);
  }

  // Credentials valid — reset the rate-limit bucket so the user is not held back.
  deps.rateLimiter.reset(ip);

  if (await isMfaEnrolled(deps.db, user.id)) {
    const issued = deps.preAuthStore.issue({ userId: user.id, tenantId: user.tenant_id });
    await audit(deps, {
      tenantId: user.tenant_id,
      action: 'auth.login.password',
      outcome: 'mfa_required',
      actorType: 'user',
      actorId: user.id,
      actorName: user.email,
      resourceType: 'user',
      resourceId: user.id,
      ip,
      userAgent: ua,
      traceId,
    });
    return c.json({ pre_auth_token: issued.token, expires_in: issued.expiresInSeconds }, 401);
  }

  const { headerValue } = await issueSessionCookie(deps, user, ip, ua);
  await audit(deps, {
    tenantId: user.tenant_id,
    action: 'auth.login.password',
    outcome: 'success',
    actorType: 'user',
    actorId: user.id,
    actorName: user.email,
    resourceType: 'user',
    resourceId: user.id,
    ip,
    userAgent: ua,
    traceId,
  });
  return new Response(
    JSON.stringify({
      actor: {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id,
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': headerValue,
      },
    },
  );
};
