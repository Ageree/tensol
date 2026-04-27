// Apply all pending migrations.
// Usage: DATABASE_URL=postgres://... bun run packages/db/scripts/migrate.ts

import { buildMigrator, databaseUrl } from './migrator.ts';

const main = async (): Promise<void> => {
  const { db, migrator } = await buildMigrator({ url: databaseUrl() });
  try {
    const { error, results } = await migrator.migrateToLatest();
    for (const r of results ?? []) {
      const status = r.status === 'Success' ? 'ok' : r.status;
      console.warn(`migrate ${r.direction.toLowerCase()} ${r.migrationName}: ${status}`);
    }
    if (error) {
      console.error('migrate failed:', error);
      process.exit(1);
    }
  } finally {
    await db.destroy();
  }
};

await main();
