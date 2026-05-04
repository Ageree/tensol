// Local dev runner — Bun.serve entry that wires createApp() against the local
// docker-compose Postgres. NOT for production; production deployment is the
// S28 task (Terraform + managed PG + container build).
//
// Usage: `bun apps/api/src/serve.ts` from repo root, with DATABASE_URL set.
// Defaults assume `infra/docker/docker-compose.local.yml` is up on :5433.

import { createBcryptHasher, createTotpVerifier } from '@cyberstrike/authz';
import { createDatabase } from '@cyberstrike/db';
import { loadAuthApiConfig } from './config.ts';
import { createApp } from './factory.ts';
import { createPreAuthStore } from './pre-auth-tokens.ts';
import { DEFAULT_LOGIN_RATE_LIMIT, createRateLimiter } from './middleware/rate-limit.ts';

const PORT = Number(process.env.PORT ?? '3000');

const main = async (): Promise<void> => {
  const config = loadAuthApiConfig();
  const db = createDatabase({ url: config.databaseUrl });
  const hasher = createBcryptHasher({ cost: config.bcryptCost });
  const totp = createTotpVerifier();
  const preAuthStore = createPreAuthStore();
  const rateLimiter = createRateLimiter(DEFAULT_LOGIN_RATE_LIMIT);

  const { app } = createApp({
    config,
    db,
    hasher,
    totp,
    preAuthStore,
    rateLimiter,
  });

  Bun.serve({ port: PORT, fetch: app.fetch });
  // biome-ignore lint/suspicious/noConsole: dev-runner stdout is intentional.
  console.log(`apps/api listening on :${PORT} (env=${config.appEnv})`);
};

void main();
