// POST /auth/login/mfa — Sprint 3 C22 step-2, C29.
//
// Body: {pre_auth_token, mfa_code}. Looks up the LRU entry, verifies
// non-expired/non-consumed, runs TOTP verify (with replay protection), marks
// consumed, issues session cookie.
//
// Failure paths all collapse to canonical 401 with `error: invalid_credentials`
// — no oracle distinguishing missing-token / expired / wrong-code / replay.

import type { Context } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import {
  type RouteDeps,
  audit,
  canonical401Body,
  ensurePlatformTenantId,
  newTraceId,
  sourceIp,
  userAgent,
} from '../shared.ts';
import { issueSessionCookie } from './login.ts';

const bodySchema = z.object({
  pre_auth_token: z.string().regex(/^[0-9a-f]{64}$/),
  mfa_code: z.string().regex(/^\d{6}$/),
});

export const handleLoginMfa = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.json(canonical401Body(), 401);
  }

  const principal = deps.preAuthStore.redeem(body.pre_auth_token);
  if (!principal) {
    // Cannot attribute to a user; audit with platform tenant.
    const platformTenantId = await ensurePlatformTenantId(deps);
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.login.mfa',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'system',
      actorName: 'unknown',
      resourceType: 'user',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'pre_auth_token_invalid' },
    });
    return c.json(canonical401Body(), 401);
  }

  const user = await deps.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', principal.userId)
    .executeTakeFirst();
  if (!user || user.status !== 'active') {
    await audit(deps, {
      tenantId: principal.tenantId,
      action: 'auth.login.mfa',
      outcome: 'failure',
      actorType: 'user',
      actorId: principal.userId,
      actorName: user?.email ?? 'unknown',
      resourceType: 'user',
      resourceId: principal.userId,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'user_inactive' },
    });
    return c.json(canonical401Body(), 401);
  }

  const mfa = await deps.db
    .selectFrom('mfa_secrets')
    .selectAll()
    .where('user_id', '=', user.id)
    .where('enrolled_at', 'is not', null)
    .executeTakeFirst();
  if (!mfa) {
    await audit(deps, {
      tenantId: user.tenant_id,
      action: 'auth.login.mfa',
      outcome: 'failure',
      actorType: 'user',
      actorId: user.id,
      actorName: user.email,
      resourceType: 'user',
      resourceId: user.id,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'no_mfa_secret' },
    });
    return c.json(canonical401Body(), 401);
  }

  const valid = deps.totp.verify({
    userId: user.id,
    secret: mfa.secret_encrypted,
    code: body.mfa_code,
  });
  if (!valid) {
    await audit(deps, {
      tenantId: user.tenant_id,
      action: 'auth.login.mfa',
      outcome: 'failure',
      actorType: 'user',
      actorId: user.id,
      actorName: user.email,
      resourceType: 'user',
      resourceId: user.id,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'mfa_code_invalid' },
    });
    return c.json(canonical401Body(), 401);
  }

  const { headerValue } = await issueSessionCookie(deps, user, ip, ua);
  await audit(deps, {
    tenantId: user.tenant_id,
    action: 'auth.login.mfa',
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
