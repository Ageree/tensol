// POST /auth/mfa/verify — Sprint 3 C25, C29.
//
// Accepts the first valid TOTP code for a user's pending (un-enrolled) MFA
// secret and flips `enrolled_at = now()`. Replays in the same step window are
// rejected with `outcome=replay` (TOTP LRU does the bookkeeping inside
// totp.verify()).

import type { Context } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

const bodySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

export const handleMfaVerify = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) return c.json({ error: 'unauthenticated' }, 401);

  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const mfa = await deps.db
    .selectFrom('mfa_secrets')
    .selectAll()
    .where('user_id', '=', actor.id)
    .where('enrolled_at', 'is', null)
    .executeTakeFirst();

  if (!mfa) {
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'auth.mfa.verify',
      outcome: 'failure',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'mfa_secret',
      resourceId: actor.id,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'no_pending_secret' },
    });
    return c.json({ error: 'invalid_request' }, 400);
  }

  // Detect replay: try once; if rejected and the code is otherwise valid, treat
  // as replay. We surface that via a separate read of the LRU... simpler: try
  // verify; if false and the same code+secret would have validated within
  // ±1-step against current time, mark replay. Simpler still: rely on the
  // verifier returning false and emit `outcome=failure` for everything that
  // didn't pass; reserve `replay` for the case where the secret is already
  // enrolled — bumped into mfa-verify replay test to assert behaviour.
  const ok = deps.totp.verify({
    userId: actor.id,
    secret: mfa.secret_encrypted,
    code: body.code,
  });

  if (!ok) {
    // Probe: if the same code is the *current* TOTP, the failure must have
    // come from the replay LRU (we accepted it earlier). This lets us
    // distinguish replay (`outcome=replay`) from a wrong code (`outcome=failure`).
    const currentCode = deps.totp.generateCode(mfa.secret_encrypted);
    const outcome: 'replay' | 'failure' = currentCode === body.code ? 'replay' : 'failure';
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'auth.mfa.verify',
      outcome,
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'mfa_secret',
      resourceId: actor.id,
      ip,
      userAgent: ua,
      traceId,
    });
    return c.json({ error: 'invalid_code' }, 401);
  }

  await deps.db
    .updateTable('mfa_secrets')
    .set({ enrolled_at: new Date() })
    .where('id', '=', mfa.id)
    .execute();

  await deps.db
    .updateTable('users')
    .set({ mfa_enrolled: true })
    .where('id', '=', actor.id)
    .execute();

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'auth.mfa.verify',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'mfa_secret',
    resourceId: actor.id,
    ip,
    userAgent: ua,
    traceId,
  });

  return c.json({ ok: true });
};
