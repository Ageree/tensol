// Shared migrator factory used by migrate / rollback / redo / check scripts.
// Cyrillic-path footgun guard (B25): use fileURLToPath, never URL.pathname.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FileMigrationProvider, Migrator } from 'kysely';
import { type DbConfig, createDatabase } from '../src/db.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = `${here}../migrations`;

/**
 * Filtered FileMigrationProvider: ignores `_common.ts` and any file whose
 * basename starts with `_`. Kysely's default provider would otherwise try
 * to load the helper module as a migration and crash because it has no
 * `up` / `down` exports.
 */
class FilteredFileMigrationProvider extends FileMigrationProvider {
  override async getMigrations() {
    const all = await super.getMigrations();
    const filtered: Record<string, (typeof all)[string]> = {};
    for (const [name, mig] of Object.entries(all)) {
      if (!name.startsWith('_')) {
        filtered[name] = mig;
      }
    }
    return filtered;
  }
}

export interface MigratorBundle {
  // biome-ignore lint/suspicious/noExplicitAny: Kysely instance is typed; the structural fallback is fine here.
  readonly db: any;
  readonly migrator: Migrator;
}

export const buildMigrator = async (config: DbConfig): Promise<MigratorBundle> => {
  const db = createDatabase(config);
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

export const listMigrationFiles = (): ReadonlyArray<string> =>
  readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
    .sort();

export const databaseUrl = (): string => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for migration scripts');
  }
  return url;
};
