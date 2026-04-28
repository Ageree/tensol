// POST /auth/password/reset/request — Sprint 3 C26 (R3+R7), C29.
//
// Body: {email}. Hit path issues a reset token; miss path runs a dummy bcrypt
// hash to flatten timing. Always returns `202` with empty body to avoid user
// enumeration.

import { generateResetToken, hashResetToken } from '@cyberstrike/authz';
import type { Context } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import {
  type RouteDeps,
  audit,
  ensurePlatformTenantId,
  newTraceId,
  sourceIp,
  userAgent,
} from '../shared.ts';

const bodySchema = z.object({
  email: z.string().email().max(254),
});

export const handlePasswordResetRequest = async (
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
    return new Response(null, { status: 202 });
  }

  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'tenant_id', 'email', 'status'])
    .where('email', '=', body.email)
    .executeTakeFirst();

  if (!user || user.status !== 'active') {
    // C26 (R7) — dummy bcrypt work matches the hit-path bcrypt envelope.
    await deps.hasher.dummyVerify(body.email);
    const platformTenantId = await ensurePlatformTenantId(deps);
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.password.reset.request',
      outcome: 'miss',
      actorType: 'service',
      actorId: 'system',
      actorName: body.email,
      resourceType: 'user',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { email: body.email },
    });
    return new Response(null, { status: 202 });
  }

  const issued = generateResetToken(deps.nowMs?.() ?? Date.now());
  await deps.repos.passwordResetTokens.issue({
    tokenHash: issued.tokenHash,
    userId: user.id,
    tenantId: user.tenant_id,
    expiresAt: new Date(issued.expiresAtMs),
  });

  await audit(deps, {
    tenantId: user.tenant_id,
    action: 'auth.password.reset.request',
    outcome: 'issued',
    actorType: 'user',
    actorId: user.id,
    actorName: user.email,
    resourceType: 'user',
    resourceId: user.id,
    ip,
    userAgent: ua,
    traceId,
    // Token plaintext is intentionally NOT recorded; only the hash for traceability.
    metadata: { token_hash_prefix: issued.tokenHash.slice(0, 8) },
  });

  // For the slice (no email gateway) the audit-row carries the prefix; the
  // plaintext is delivered to the client of the reset request when running
  // in `local` so the dev workflow does not require an email sink.
  if (deps.config.appEnv === 'local') {
    return new Response(JSON.stringify({ token: issued.plaintext }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(null, { status: 202 });
};

export const _hashResetTokenForTest = hashResetToken;
