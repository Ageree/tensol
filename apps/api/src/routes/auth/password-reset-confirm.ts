// POST /auth/password/reset/confirm — Sprint 3 C16, C26, C29.
//
// Body: {token, new_password}. Atomic single-use redemption via the repo;
// on success rotates the password hash and invalidates ALL of the user's
// sessions (force re-login).

import { hashResetToken } from '@cyberstrike/authz';
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

const bodySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  new_password: z.string().min(12).max(256),
});

export const handlePasswordResetConfirm = async (
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
    const platformTenantId = await ensurePlatformTenantId(deps);
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.password.reset.confirm',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'system',
      actorName: 'unknown',
      resourceType: 'password_reset_token',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'invalid_body' },
    });
    return c.json(canonical401Body(), 401);
  }

  const tokenHash = hashResetToken(body.token);
  const redeemed = await deps.repos.passwordResetTokens.redeem(tokenHash);
  if (!redeemed) {
    const platformTenantId = await ensurePlatformTenantId(deps);
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.password.reset.confirm',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'system',
      actorName: 'unknown',
      resourceType: 'password_reset_token',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'redeem_failed' },
    });
    return c.json(canonical401Body(), 401);
  }

  const passwordHash = await deps.hasher.hash(body.new_password);
  await deps.db
    .updateTable('users')
    .set({ password_hash: passwordHash })
    .where('id', '=', redeemed.userId)
    .execute();

  // C26 — invalidate all sessions: force re-login.
  await deps.sessionRepo.invalidateAllForUser(redeemed.userId);

  const user = await deps.db
    .selectFrom('users')
    .select(['email'])
    .where('id', '=', redeemed.userId)
    .executeTakeFirst();

  await audit(deps, {
    tenantId: redeemed.tenantId,
    action: 'auth.password.reset.confirm',
    outcome: 'success',
    actorType: 'user',
    actorId: redeemed.userId,
    actorName: user?.email ?? 'unknown',
    resourceType: 'user',
    resourceId: redeemed.userId,
    ip,
    userAgent: ua,
    traceId,
  });

  return c.json({ ok: true });
};
