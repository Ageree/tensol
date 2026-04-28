// Sprint 3 contract C1 + Sprint 4 A8/A9 — Hono `createApp(options)` factory.
//
// Sprint 4 wiring additions:
//   - Global `onError` handler catches `RbacDenyError`, calls `denyAudit`
//     synchronously (before the response is sent), and returns the canonical
//     403 body. If `denyAudit` itself throws (DB outage), the handler returns
//     500 instead of 403 (A8 NQ-A — silently dropping the audit row would
//     violate the auditability invariant).
//   - `buildRepositories({onCrossTenantAttempt})` is plumbed from this layer
//     so every cross-tenant-row touch from a `MutableRepository` produces
//     a deny audit row attributed to the actor's tenant (R3).

import { denyAudit } from '@cyberstrike/audit';
import { type PasswordHasher, RbacDenyError, type TotpVerifier } from '@cyberstrike/authz';
import { type Database, type Repositories, buildRepositories } from '@cyberstrike/db';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { AuthApiConfig } from './config.ts';
import type { RateLimiter } from './middleware/rate-limit.ts';
import { type SessionEnv, sessionMiddleware } from './middleware/session.ts';
import type { PreAuthStore } from './pre-auth-tokens.ts';
import { registerRoutes } from './routes/register-routes.ts';
import { ensurePlatformTenantId } from './routes/shared.ts';
import { SessionRepo } from './session-repo.ts';

export interface AppOptions {
  readonly config: AuthApiConfig;
  readonly db: Kysely<Database>;
  /**
   * Optional pre-built `Repositories`. When provided, the caller is
   * responsible for wiring `onCrossTenantAttempt` (Sprint 4 A9). When omitted,
   * `createApp` builds repos internally with the deny-audit closure attached.
   * Tests typically pass their own to share fixture state.
   */
  readonly repos?: Repositories;
  readonly hasher: PasswordHasher;
  readonly totp: TotpVerifier;
  readonly preAuthStore: PreAuthStore;
  readonly rateLimiter: RateLimiter;
}

const newTraceId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export const createApp = (options: AppOptions) => {
  const sessionRepo = new SessionRepo(options.db, { hasher: options.hasher });

  // A9 — onCrossTenantAttempt closure. Fires whenever MutableRepository
  // detects a cross-tenant row touch. Audit row attributed to the actor's
  // tenant; the row's tenant lands in metadata.attemptedResourceTenantId.
  const repos: Repositories =
    options.repos ??
    buildRepositories(options.db, {
      onCrossTenantAttempt: (event) => {
        // Fire-and-forget: A9's contract is "produces an audit row". Errors
        // are surfaced via the same noisy fail-fast path as A8 (denyAudit
        // throws → unhandled rejection → process logs); the route layer that
        // triggered the attempt has already received its tenant-isolation
        // error from the repository.
        void denyAudit(
          { db: options.db },
          {
            tenantId: event.actorTenantId,
            action: 'tenant.cross_tenant_attempt',
            outcome: 'cross_tenant',
            actorType: 'service',
            actorId: 'system',
            actorName: 'mutable-repository',
            resourceType: event.resourceType,
            resourceId: event.resourceId,
            reason: 'repository-level cross-tenant detected',
            traceId: newTraceId(),
            metadata: {
              attemptedResourceTenantId: event.rowTenantId,
              operation: event.operation,
            },
          },
        );
      },
    });

  const app = new Hono<SessionEnv>();

  app.onError(async (err, c) => {
    // A8 — RbacDenyError → synchronous denyAudit + 403. If denyAudit throws,
    // return 500 instead of 403 (NQ-A).
    if (err instanceof RbacDenyError) {
      const actor = c.get('actor');
      const sourceIpHeader = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip');
      const ip = sourceIpHeader?.split(',')[0]?.trim() ?? null;
      const userAgent = c.req.header('user-agent') ?? null;

      try {
        const tenantId =
          err.actorTenantId.length > 0
            ? err.actorTenantId
            : await ensurePlatformTenantId({ db: options.db });
        await denyAudit(
          { db: options.db },
          {
            tenantId,
            action: 'rbac.deny',
            outcome: 'forbidden',
            actorType: actor ? 'user' : 'service',
            actorId: actor?.id ?? 'system',
            actorName: actor?.email ?? 'anonymous',
            resourceType: err.attemptedResourceType,
            resourceId: err.attemptedResourceId ?? null,
            reason: err.reason,
            ip,
            userAgent,
            traceId: newTraceId(),
            metadata: err.targetedTenantId
              ? { attemptedResourceTenantId: err.targetedTenantId }
              : undefined,
          },
        );
      } catch {
        // A8 NQ-A — silently dropping the audit row violates the auditability
        // invariant. Return 500 instead of 403.
        return c.json({ error: 'internal_error' }, 500);
      }
      // Body is byte-equal to Sprint 3 C18c — no UUIDs, no leakage.
      return c.json({ error: 'forbidden' }, 403);
    }

    const isProd = options.config.appEnv === 'production';
    return c.json(
      {
        error: 'internal_error',
        ...(isProd ? {} : { detail: err.message }),
      },
      500,
    );
  });

  // Always attempt to populate session context; routes opt into auth via
  // tenantGuard (C28a-c).
  app.use(
    '*',
    sessionMiddleware({
      cookieName: options.config.cookieName,
      sessionRepo,
      db: options.db,
    }),
  );

  app.get('/health', (c) =>
    c.json({ status: 'ok', appEnv: options.config.appEnv, name: 'apps/api' }),
  );

  registerRoutes(app, {
    config: options.config,
    db: options.db,
    repos,
    hasher: options.hasher,
    totp: options.totp,
    preAuthStore: options.preAuthStore,
    rateLimiter: options.rateLimiter,
    sessionRepo,
  });

  return { app, sessionRepo };
};

export type CreatedApp = ReturnType<typeof createApp>;
