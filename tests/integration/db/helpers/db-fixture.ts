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

export { runInTenant };
