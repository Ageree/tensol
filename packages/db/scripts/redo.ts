// Rollback the latest migration then re-apply it. Used by db:migrate:check
// to prove the latest migration is reversible (Sprint 2 contract B7).
// Usage: DATABASE_URL=postgres://... bun run packages/db/scripts/redo.ts

import { buildMigrator, databaseUrl } from './migrator.ts';

const main = async (): Promise<void> => {
  const { db, migrator } = await buildMigrator({ url: databaseUrl() });
  try {
    const down = await migrator.migrateDown();
    if (down.error) {
      console.error('redo: rollback failed:', down.error);
      process.exit(1);
    }
    for (const r of down.results ?? []) {
      console.warn(`redo down ${r.migrationName}: ${r.status}`);
    }

    const up = await migrator.migrateToLatest();
    if (up.error) {
      console.error('redo: re-apply failed:', up.error);
      process.exit(1);
    }
    for (const r of up.results ?? []) {
      console.warn(`redo up ${r.migrationName}: ${r.status}`);
    }
  } finally {
    await db.destroy();
  }
};

await main();
