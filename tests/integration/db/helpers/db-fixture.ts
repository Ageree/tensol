// Shared fixture for PG-dependent integration tests.
//
// Strategy: tests gate themselves with `describe.skipIf(!process.env.DATABASE_URL)`.
// When DATABASE_URL is set (CI service container or local docker compose),
// the suite spins up a fresh schema, applies migrations, runs the scenario,
// then drops the schema in afterAll. When DATABASE_URL is absent (sandbox),
// the suite skips cleanly — `bun test` reports the suite as skipped, not failed.
//
// Cyrillic-path footgun guarded via fileURLToPath (B25).

import { fileURLToPath } from 'node:url';
import { type Database, createDatabase, runInTenant } from '@cyberstrike/db';
import { FileMigrationProvider, type Kysely, Migrator } from 'kysely';

const here = fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = `${here}../../../../packages/db/migrations`;

class FilteredFileMigrationProvider extends FileMigrationProvider {
  override async getMigrations() {
    const all = await super.getMigrations();
    const filtered: Record<string, (typeof all)[string]> = {};
    for (const [name, mig] of Object.entries(all)) {
      if (!name.startsWith('_')) filtered[name] = mig;
    }
    return filtered;
  }
}

export const hasDatabaseUrl = (): boolean =>
  typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;

export interface DbFixture {
  readonly db: Kysely<Database>;
  readonly migrator: Migrator;
}

export const createFixture = async (): Promise<DbFixture> => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set for db integration tests');
  const db = createDatabase({ url });
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const migrator = new Migrator({
    db,
    provider: new FilteredFileMigrationProvider({
      fs: { readdir: fs.readdir },
      path: { join: path.join },
      migrationFolder: migrationsDir,
    }),
  });
  return { db, migrator };
};

export const applyAllMigrations = async (f: DbFixture): Promise<void> => {
  const { error, results } = await f.migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  for (const r of results ?? []) {
    if (r.status === 'Error') {
      throw new Error(`migration ${r.migrationName} failed`);
    }
  }
};

export const rollbackAllMigrations = async (f: DbFixture): Promise<void> => {
  // Walk down until the migrator reports nothing left to revert.
  for (let i = 0; i < 100; i += 1) {
    const { results, error } = await f.migrator.migrateDown();
    if (error) throw error instanceof Error ? error : new Error(String(error));
    if (!results || results.length === 0) return;
  }
};

export const dropAllTables = async (f: DbFixture): Promise<void> => {
  // Drop in reverse-fk order via DROP TABLE IF EXISTS ... CASCADE wrapped in a tx.
  // Used by afterAll to guarantee a clean slate even if migrations partial-applied.
  const { sql } = await import('kysely');
  const tables = [
    'reports',
    'llm_audit_events',
    'audit_events',
    'finding_evidence',
    'findings',
    'candidate_findings',
    'observations_browser',
    'decepticon_sessions',
    'jobs',
    'assessment_artifacts',
    'assessment_scope_rules',
    'assessments',
    'targets',
    'projects',
    'platform_settings',
    'password_reset_tokens',
    'mfa_secrets',
    'user_sessions',
    'users',
    'tenants',
    'kysely_migration',
    'kysely_migration_lock',
  ];
  for (const t of tables) {
    await sql.raw(`DROP TABLE IF EXISTS "${t}" CASCADE`).execute(f.db);
  }
  await sql.raw('DROP FUNCTION IF EXISTS enforce_append_only()').execute(f.db);
};

export const seedTenant = async (
  f: DbFixture,
  args: { name: string; slug: string },
): Promise<string> => {
  const row = await f.db
    .insertInto('tenants')
    .values({ name: args.name, slug: args.slug, status: 'active' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

/**
 * Seed a user inside the given tenant. Required by tests that insert rows
 * into tables with FKs to `users` (assessments.created_by, user_sessions,
 * mfa_secrets, audit_events.actor_id when actor_type='user').
 *
 * Sprint 2 evaluator F2: optimistic-lock test was inserting an assessment
 * without a users row → FK violation. Centralising user seeding here keeps
 * the FK chain honest as more aggregates land in later sprints.
 */
export const seedUser = async (
  f: DbFixture,
  tenantId: string,
  args: { email: string; displayName?: string; role?: string },
): Promise<string> => {
  const row = await f.db
    .insertInto('users')
    .values({
      tenant_id: tenantId,
      email: args.email,
      password_hash: 'placeholder-not-a-real-hash',
      display_name: args.displayName ?? args.email,
      status: 'active',
      role: args.role ?? 'security_lead',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

/**
 * Seed a session row for a user. Sprint 3 contract C17 — `tenantGuard` middleware
 * looks up `user_sessions` by token_hash. The hash format here is opaque (the
 * test merely needs a stable identifier in token_hash); production routes use
 * bcrypt(token).
 */
export const seedSession = async (
  f: DbFixture,
  args: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt?: Date;
    ip?: string;
    userAgent?: string;
  },
): Promise<string> => {
  const row = await f.db
    .insertInto('user_sessions')
    .values({
      tenant_id: args.tenantId,
      user_id: args.userId,
      token_hash: args.tokenHash,
      expires_at: args.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      ip: args.ip ?? null,
      user_agent: args.userAgent ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

/**
 * Seed an MFA secret row for a user. Used by mfa.test.ts and login.test.ts
 * fixtures. Caller passes the base32-plaintext secret; production encrypts
 * (Sprint 7 — see ADR 0003 §Limitations R9).
 */
export const seedMfaSecret = async (
  f: DbFixture,
  args: {
    tenantId: string;
    userId: string;
    secretEncrypted: string;
    enrolledAt?: Date | null;
    algo?: string;
    digits?: number;
    period?: number;
  },
): Promise<string> => {
  const row = await f.db
    .insertInto('mfa_secrets')
    .values({
      tenant_id: args.tenantId,
      user_id: args.userId,
      secret_encrypted: args.secretEncrypted,
      enrolled_at: args.enrolledAt ?? null,
      algo: args.algo ?? 'SHA1',
      digits: args.digits ?? 6,
      period_seconds: args.period ?? 30,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

/**
 * Seed a password-reset token row. Caller passes the sha256-hash (token_hash)
 * AND the plaintext for tests that exercise the redemption flow. Defaults to
 * a 15-minute TTL.
 */
export const seedPasswordResetToken = async (
  f: DbFixture,
  args: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt?: Date;
    consumedAt?: Date | null;
  },
): Promise<void> => {
  await f.db
    .insertInto('password_reset_tokens')
    .values({
      token_hash: args.tokenHash,
      tenant_id: args.tenantId,
      user_id: args.userId,
      expires_at: args.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
      consumed_at: args.consumedAt ?? null,
    })
    .execute();
};

/**
 * Set platform_settings.bootstrap_consumed_at — useful for the C21b "already
 * consumed → 410 Gone" assertion. Migration 015 seeds the singleton row;
 * this helper just flips the column.
 */
export const seedPlatformSettings = async (
  f: DbFixture,
  args: { bootstrapConsumedAt?: Date | null },
): Promise<void> => {
  await f.db
    .updateTable('platform_settings')
    .set({ bootstrap_consumed_at: args.bootstrapConsumedAt ?? null })
    .where('lock', '=', 'x')
    .execute();
};

export { runInTenant };
