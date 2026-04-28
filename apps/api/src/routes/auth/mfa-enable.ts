// POST /auth/mfa/enable — Sprint 3 C25, C29.
//
// Issues a fresh TOTP secret (base32) for the authenticated user and persists
// to `mfa_secrets` with `enrolled_at = NULL`. The secret is returned to the
// client so it can be rendered as a QR code; the client must call /mfa/verify
// with the first valid code to flip `enrolled_at`.
//
// IMPORTANT (R9 / ADR 0003 §Decision): in production the `secret_encrypted`
// column MUST be encrypted with a per-tenant KMS-rooted key. Sprint 3 stores
// base32-plaintext as a deliberate slice limitation tracked for the security-
// hardening sprint.

import type { Context } from 'hono';
import type { SessionEnv } from '../../middleware/session.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

export const handleMfaEnable = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) return c.json({ error: 'unauthenticated' }, 401);

  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);

  // Replace any not-yet-enrolled secret. (Ones with `enrolled_at` set are
  // preserved — disabling MFA is a separate flow not in scope this sprint.)
  await deps.db
    .deleteFrom('mfa_secrets')
    .where('user_id', '=', actor.id)
    .where('enrolled_at', 'is', null)
    .execute();

  const secret = deps.totp.generateSecret();
  await deps.db
    .insertInto('mfa_secrets')
    .values({
      tenant_id: actor.tenantId,
      user_id: actor.id,
      secret_encrypted: secret,
      enrolled_at: null,
      algo: 'SHA1',
      digits: 6,
      period_seconds: 30,
    })
    .execute();

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'auth.mfa.enable',
    outcome: 'issued',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'mfa_secret',
    resourceId: actor.id,
    ip,
    userAgent: ua,
    traceId,
  });

  return c.json({ secret, algo: 'SHA1', digits: 6, period_seconds: 30 });
};
