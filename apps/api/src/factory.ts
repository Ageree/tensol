// Sprint 3 contract C1 — Hono `createApp(options)` factory.
//
// This file wires the foundational middleware stack (session → tenant-guard
// composition, error handler, audit hook). Concrete route handlers land in
// src/routes/auth/* and are registered in createApp. The factory accepts
// dependency-injected primitives so tests can wire mocked hashers, in-memory
// session repos, fake clocks, etc.

import type { PasswordHasher, TotpVerifier } from '@cyberstrike/authz';
import type { Database, Repositories } from '@cyberstrike/db';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { AuthApiConfig } from './config.ts';
import type { RateLimiter } from './middleware/rate-limit.ts';
import { type SessionEnv, sessionMiddleware } from './middleware/session.ts';
import type { PreAuthStore } from './pre-auth-tokens.ts';
import { registerRoutes } from './routes/register-routes.ts';
import { SessionRepo } from './session-repo.ts';

export interface AppOptions {
  readonly config: AuthApiConfig;
  readonly db: Kysely<Database>;
  readonly repos: Repositories;
  readonly hasher: PasswordHasher;
  readonly totp: TotpVerifier;
  readonly preAuthStore: PreAuthStore;
  readonly rateLimiter: RateLimiter;
}

export const createApp = (options: AppOptions) => {
  const sessionRepo = new SessionRepo(options.db, { hasher: options.hasher });

  const app = new Hono<SessionEnv>();

  app.onError((err, c) => {
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
    repos: options.repos,
    hasher: options.hasher,
    totp: options.totp,
    preAuthStore: options.preAuthStore,
    rateLimiter: options.rateLimiter,
    sessionRepo,
  });

  return { app, sessionRepo };
};

export type CreatedApp = ReturnType<typeof createApp>;
