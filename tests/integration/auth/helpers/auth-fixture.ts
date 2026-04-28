// Auth integration fixture — Sprint 3.
//
// Extends `tests/integration/db/helpers/db-fixture.ts` with the wiring
// required to exercise the live Hono app against a real Postgres:
//   - createApp() with a deterministic config (BCRYPT_COST=4 for fast tests)
//   - hasher / TOTP / pre-auth-store / rate-limiter live instances
//   - test-only cookie (`cs_session`, no __Host- prefix, secure=false)
//   - mintCookie() turns a seeded session into a Cookie header value
//   - bootstrap helper to register a platform_admin without going through
//     the live route (used by IDOR + RBAC tests)
//
// Cyrillic-path footgun: fileURLToPath only (B25, C5).

import { fileURLToPath } from 'node:url';
import {
  type AppOptions,
  type AuthApiConfig,
  SessionRepo,
  createApp,
  createPreAuthStore,
  createRateLimiter,
  resetPlatformTenantCache,
} from '@cyberstrike/api';
import { createBcryptHasher, createTotpVerifier } from '@cyberstrike/authz';
import { buildRepositories } from '@cyberstrike/db';
import {
  type DbFixture,
  hasDatabaseUrl,
  seedTenant,
  seedUser,
} from '../../db/helpers/db-fixture.ts';

const _here = fileURLToPath(new URL('.', import.meta.url));

export const TEST_COOKIE_NAME = 'cs_session';
export const TEST_BCRYPT_COST = 4;

export const buildTestConfig = (): AuthApiConfig =>
  Object.freeze({
    appEnv: 'local' as const,
    bcryptCost: TEST_BCRYPT_COST,
    bootstrapToken: undefined,
    cookieName: TEST_COOKIE_NAME,
    cookieSecure: false,
    sessionSecret: 'a'.repeat(64),
    databaseUrl: process.env.DATABASE_URL ?? '',
  });

export interface AuthFixture {
  readonly db: DbFixture['db'];
  readonly app: ReturnType<typeof createApp>['app'];
  readonly sessionRepo: SessionRepo;
  readonly hasher: AppOptions['hasher'];
  readonly totp: AppOptions['totp'];
  readonly preAuthStore: AppOptions['preAuthStore'];
  readonly rateLimiter: AppOptions['rateLimiter'];
  readonly config: AuthApiConfig;
}

export const buildAuthApp = (db: DbFixture['db']): AuthFixture => {
  const config = buildTestConfig();
  const hasher = createBcryptHasher({ cost: TEST_BCRYPT_COST });
  const totp = createTotpVerifier();
  const preAuthStore = createPreAuthStore();
  const rateLimiter = createRateLimiter({ maxFailures: 5, windowSeconds: 60 });
  const repos = buildRepositories(db);
  const created = createApp({
    config,
    db,
    repos,
    hasher,
    totp,
    preAuthStore,
    rateLimiter,
  });
  return {
    db,
    app: created.app,
    sessionRepo: created.sessionRepo,
    hasher,
    totp,
    preAuthStore,
    rateLimiter,
    config,
  };
};

export interface SeededLogin {
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  readonly cookieValue: string;
  readonly cookieHeader: string;
}

/**
 * Seed a tenant + user + session row, return a Cookie header that lets the
 * tenantGuard middleware authenticate the request. Skips the route layer so
 * tests that don't exercise the login path stay deterministic.
 */
export const seedLoggedInUser = async (
  fx: AuthFixture & { db: DbFixture['db'] },
  args: {
    tenantSlug: string;
    email: string;
    password?: string;
    role?: string;
  },
): Promise<SeededLogin> => {
  const tenantId = await seedTenant(fx as unknown as DbFixture, {
    name: args.tenantSlug,
    slug: args.tenantSlug,
  });
  const password = args.password ?? 'correct-horse-battery-staple';
  const passwordHash = await fx.hasher.hash(password);
  const userId = await seedUser(fx as unknown as DbFixture, tenantId, {
    email: args.email,
    role: args.role ?? 'security_lead',
  });
  // Overwrite password_hash since seedUser uses a placeholder.
  await fx.db
    .updateTable('users')
    .set({ password_hash: passwordHash })
    .where('id', '=', userId)
    .execute();

  const plaintext = '0123456789abcdef'.repeat(4); // 64-char hex
  const issued = await fx.sessionRepo.issue({
    tenantId,
    userId,
    plaintext,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  void issued;

  const cookieValue = SessionRepo.formatCookieValue(userId, plaintext);
  const cookieHeader = `${TEST_COOKIE_NAME}=${cookieValue}`;

  return {
    tenantId,
    userId,
    email: args.email,
    password,
    cookieValue,
    cookieHeader,
  };
};

/**
 * Sprint 5 F1 — seed an ADDITIONAL logged-in user inside an EXISTING tenant.
 * Used by IT files that need a tenant_admin alongside a security_lead in the
 * same tenant (e.g. assessment-approve flow). `seedLoggedInUser` always creates
 * a new tenant, so calling it twice with the same slug fails on the unique
 * constraint AND lands the second user in a different tenant. This helper
 * fixes both.
 */
export const seedExtraLoggedInUser = async (
  fx: AuthFixture & { db: DbFixture['db'] },
  args: {
    tenantId: string;
    email: string;
    password?: string;
    role?: string;
  },
): Promise<SeededLogin> => {
  const password = args.password ?? 'correct-horse-battery-staple';
  const passwordHash = await fx.hasher.hash(password);
  const userId = await seedUser(fx as unknown as DbFixture, args.tenantId, {
    email: args.email,
    role: args.role ?? 'security_lead',
  });
  await fx.db
    .updateTable('users')
    .set({ password_hash: passwordHash })
    .where('id', '=', userId)
    .execute();

  const plaintext = '0123456789abcdef'.repeat(4);
  await fx.sessionRepo.issue({
    tenantId: args.tenantId,
    userId,
    plaintext,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const cookieValue = SessionRepo.formatCookieValue(userId, plaintext);
  const cookieHeader = `${TEST_COOKIE_NAME}=${cookieValue}`;

  return {
    tenantId: args.tenantId,
    userId,
    email: args.email,
    password,
    cookieValue,
    cookieHeader,
  };
};

/**
 * Reset every auth-relevant table between tests. The append-only tables
 * (`audit_events`) reject DELETE/TRUNCATE under their enforce_append_only()
 * trigger; we temporarily DISABLE triggers, truncate, then re-enable.
 * Runs as a single statement-block so a test failure cannot leave the
 * trigger disabled.
 */
export const resetAuthState = async (db: DbFixture['db']): Promise<void> => {
  const { sql } = await import('kysely');
  await sql
    .raw(`
    DO $$
    BEGIN
      ALTER TABLE audit_events DISABLE TRIGGER USER;
      ALTER TABLE assessment_approvals DISABLE TRIGGER USER;
      ALTER TABLE target_ownership_claims DISABLE TRIGGER USER;
      DELETE FROM idempotency_keys;
      DELETE FROM assessment_approvals;
      DELETE FROM target_ownership_claims;
      DELETE FROM assessment_targets;
      DELETE FROM assessment_scope_rules;
      DELETE FROM assessments;
      DELETE FROM targets;
      DELETE FROM password_reset_tokens;
      DELETE FROM user_sessions;
      DELETE FROM mfa_secrets;
      DELETE FROM audit_events;
      DELETE FROM projects;
      DELETE FROM users;
      DELETE FROM tenants;
      UPDATE platform_settings SET bootstrap_consumed_at = NULL WHERE lock = 'x';
      ALTER TABLE audit_events ENABLE TRIGGER USER;
      ALTER TABLE assessment_approvals ENABLE TRIGGER USER;
      ALTER TABLE target_ownership_claims ENABLE TRIGGER USER;
    EXCEPTION WHEN OTHERS THEN
      ALTER TABLE audit_events ENABLE TRIGGER USER;
      ALTER TABLE assessment_approvals ENABLE TRIGGER USER;
      ALTER TABLE target_ownership_claims ENABLE TRIGGER USER;
      RAISE;
    END $$;
  `)
    .execute(db);
  // The platform-tenant row was just deleted; clear the cache so the next
  // lazy lookup re-creates it.
  resetPlatformTenantCache();
};

export const countAuditEvents = async (db: DbFixture['db']): Promise<number> => {
  const row = await db
    .selectFrom('audit_events')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
};

export const latestAuditOutcome = async (
  db: DbFixture['db'],
): Promise<{ action: string; outcome: string } | null> => {
  const row = await db
    .selectFrom('audit_events')
    .select(['action', 'after_state'])
    .orderBy('occurred_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const after = row.after_state as { outcome?: string } | null;
  return { action: row.action, outcome: after?.outcome ?? '' };
};

export { hasDatabaseUrl };
