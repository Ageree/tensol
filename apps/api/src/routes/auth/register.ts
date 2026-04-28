// POST /auth/register — Sprint 3 C21a/b/c, C29.
//
// Bootstrap-only registration: creates the very first platform_admin user +
// owning tenant, gated by `platform_settings.bootstrap_consumed_at` and a
// strong `BOOTSTRAP_TOKEN`. After success, `platform_settings` is flipped
// atomically and any subsequent attempt returns 410 Gone.
//
// Body shape: `{email, password, displayName, tenantSlug, tenantName, bootstrapToken}`.
// All fields validated via zod. Audit row emitted EXACTLY ONCE per attempt
// (success | failure | gone) per C29.

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
  password: z.string().min(12).max(256),
  displayName: z.string().min(1).max(128),
  tenantSlug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  tenantName: z.string().min(1).max(128),
  bootstrapToken: z.string().min(1).max(256),
});

const tokenAcceptable = (
  provided: string,
  expected: string | undefined,
  isLocal: boolean,
): boolean => {
  if (isLocal && !expected) return true; // C21c local-only fallback
  if (!expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
};

export const handleRegister = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);
  const isLocal = deps.config.appEnv === 'local';

  // C21b: read singleton; if already consumed → 410 Gone (audit `outcome=gone`).
  const settings = await deps.repos.platformSettings.read();
  const platformTenantId = await ensurePlatformTenantId(deps);
  if (settings.bootstrapConsumedAt !== null) {
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.register',
      outcome: 'gone',
      actorType: 'service',
      actorId: 'system',
      actorName: 'bootstrap',
      resourceType: 'platform_settings',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
    });
    return c.json({ error: 'bootstrap_already_consumed' }, 410);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.register',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'system',
      actorName: 'bootstrap',
      resourceType: 'platform_settings',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'invalid_body' },
    });
    return c.json({ error: 'invalid_request' }, 400);
  }

  if (!tokenAcceptable(body.bootstrapToken, deps.config.bootstrapToken, isLocal)) {
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.register',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'system',
      actorName: 'bootstrap',
      resourceType: 'platform_settings',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'bad_token' },
    });
    return c.json({ error: 'invalid_request' }, 400);
  }

  // Atomic bootstrap-consume race: insert tenant + user inside a tx, then flip
  // platform_settings. If the flip's row count is 0, we lost the race → roll
  // back via second INSERT failing on tenant slug uniqueness OR re-throw.
  try {
    const result = await deps.db.transaction().execute(async (trx) => {
      const tenant = await trx
        .insertInto('tenants')
        .values({ name: body.tenantName, slug: body.tenantSlug, status: 'active' })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      const passwordHash = await deps.hasher.hash(body.password);
      const user = await trx
        .insertInto('users')
        .values({
          tenant_id: tenant.id,
          email: body.email,
          password_hash: passwordHash,
          display_name: body.displayName,
          status: 'active',
          role: 'platform_admin',
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      // C21b atomic consume-once invariant.
      const consumed = await deps.repos.platformSettings.consumeBootstrap();
      if (!consumed) {
        throw new Error('bootstrap_race_lost');
      }
      return { tenantId: tenant.id, userId: user.id };
    });

    await audit(deps, {
      tenantId: result.tenantId,
      action: 'auth.register',
      outcome: 'success',
      actorType: 'user',
      actorId: result.userId,
      actorName: body.email,
      resourceType: 'user',
      resourceId: result.userId,
      ip,
      userAgent: ua,
      traceId,
    });
    return c.json({ ok: true, userId: result.userId, tenantId: result.tenantId }, 201);
  } catch (err) {
    const reason = (err as Error).message === 'bootstrap_race_lost' ? 'gone' : 'failure';
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.register',
      outcome: reason,
      actorType: 'service',
      actorId: 'system',
      actorName: 'bootstrap',
      resourceType: 'platform_settings',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: (err as Error).message },
    });
    if (reason === 'gone') {
      return c.json({ error: 'bootstrap_already_consumed' }, 410);
    }
    return c.json({ error: 'invalid_request' }, 400);
  }
};
