// Rollback the most recently applied migration.
// Usage: DATABASE_URL=postgres://... bun run packages/db/scripts/rollback.ts

import { buildMigrator, databaseUrl } from './migrator.ts';

const main = async (): Promise<void> => {
  const { db, migrator } = await buildMigrator({ url: databaseUrl() });
  try {
    const { error, results } = await migrator.migrateDown();
    for (const r of results ?? []) {
      console.warn(`rollback ${r.direction.toLowerCase()} ${r.migrationName}: ${r.status}`);
    }
    if (error) {
      console.error('rollback failed:', error);
      process.exit(1);
    }
  } finally {
    await db.destroy();
  }
};

await main();
