// POST /auth/self-register — S24 SaaS foundation.
//
// Creates a new tenant + user in a single transaction, then issues a session
// cookie. This is the public self-serve registration path. It is NOT the
// bootstrap admin path (apps/api/src/routes/auth/register.ts — frozen).
//
// Rate limit: 5 per IP per 10 minutes (all attempts, success + failure).
// Auth: none (public endpoint).
// Audit: emits auth.self_register on every code path.

import type { Context } from 'hono';
import { z } from 'zod';
import { buildSetCookieHeader, mintSessionTokenPlaintext } from '../../cookies.ts';
import { createRateLimiter } from '../../middleware/rate-limit.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import { SessionRepo } from '../../session-repo.ts';
import type { RouteDeps } from '../shared.ts';
import { audit, ensurePlatformTenantId, newTraceId, sourceIp, userAgent } from '../shared.ts';

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(256),
  displayName: z.string().min(1).max(128),
});

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Dedicated rate limiter for self-register: keyed by source IP, counts all
// attempts (both successful and failed registrations consume a slot).
const selfRegisterLimiter = createRateLimiter({ maxFailures: 5, windowSeconds: 600 });

const buildSlug = (email: string): string => {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  const suffix = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  const local = email.split('@')[0] ?? 'user';
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 52);
  return `${base || 'user'}-${suffix}`;
};

export const handleSelfRegister = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);

  // Rate limit: all attempts decrement the bucket (before any DB work).
  const rateResult = selfRegisterLimiter.recordFailureAndCheck(ip);
  if (rateResult.rejected) {
    return c.json({ error: 'rate_limited', retry_after_seconds: rateResult.retryAfter }, 429);
  }

  // Lazy platform-tenant for unattributed failure audits.
  const getPlatformTenantId = () => ensurePlatformTenantId(deps);

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    const platformTenantId = await getPlatformTenantId();
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.self_register',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'system',
      actorName: 'self-register',
      resourceType: 'user',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'invalid_body' },
    });
    return c.json({ error: 'invalid_request' }, 400);
  }

  try {
    const result = await deps.db.transaction().execute(async (trx) => {
      // Global email uniqueness check (Z.1.5): DB constraint is per-tenant only.
      const existing = await trx
        .selectFrom('users')
        .select('id')
        .where('email', '=', body.email)
        .executeTakeFirst();
      if (existing) {
        return { emailTaken: true } as const;
      }

      const slug = buildSlug(body.email);
      const tenant = await trx
        .insertInto('tenants')
        .values({ name: body.displayName, slug, status: 'active' })
        .returning(['id', 'slug'])
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
          role: 'tenant_admin',
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      return { tenantId: tenant.id, userId: user.id } as const;
    });

    if ('emailTaken' in result) {
      const platformTenantId = await getPlatformTenantId();
      await audit(deps, {
        tenantId: platformTenantId,
        action: 'auth.self_register',
        outcome: 'failure',
        actorType: 'service',
        actorId: 'system',
        actorName: body.email,
        resourceType: 'user',
        resourceId: null,
        ip,
        userAgent: ua,
        traceId,
        metadata: { reason: 'email_taken' },
      });
      return c.json({ error: 'email_already_registered' }, 409);
    }

    // Emit success audit (user+tenant exist) before session issuance.
    await audit(deps, {
      tenantId: result.tenantId,
      action: 'auth.self_register',
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

    // Issue session AFTER TX commit — best-effort. If session fails, user+tenant
    // exist and the user can log in separately (success audit already emitted).
    const minted = mintSessionTokenPlaintext();
    const cookieValue = SessionRepo.formatCookieValue(result.userId, minted.plaintext);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await deps.sessionRepo.issue({
      tenantId: result.tenantId,
      userId: result.userId,
      plaintext: minted.plaintext,
      expiresAt,
      ip,
      userAgent: ua,
    });

    const cookieHeader = buildSetCookieHeader(
      { name: deps.config.cookieName, secure: deps.config.cookieSecure },
      cookieValue,
      expiresAt,
    );
    c.header('Set-Cookie', cookieHeader);

    return c.json({ ok: true, userId: result.userId, tenantId: result.tenantId }, 201);
  } catch {
    const platformTenantId = await getPlatformTenantId();
    await audit(deps, {
      tenantId: platformTenantId,
      action: 'auth.self_register',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'system',
      actorName: body.email,
      resourceType: 'user',
      resourceId: null,
      ip,
      userAgent: ua,
      traceId,
      metadata: { reason: 'tx_failed' },
    });
    return c.json({ error: 'internal_error' }, 500);
  }
};
