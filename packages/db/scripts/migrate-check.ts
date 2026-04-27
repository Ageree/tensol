// db:migrate:check — Sprint 2 contract B7 / R4.
//
// Runs:
//   1. migrate up (applies everything)
//   2. pg_dump --schema-only (snapshot A)
//   3. rollback latest
//   4. migrate up
//   5. pg_dump --schema-only (snapshot B)
//   6. diff A B — exit 0 if identical, exit 1 otherwise.
//
// Catches enum OID drift, comment drift, constraint-ordering drift that a
// naive up/down comparison would miss.
//
// Usage:
//   DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike \
//     bun run packages/db/scripts/migrate-check.ts

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMigrator, databaseUrl } from './migrator.ts';

const dumpSchema = (databaseUrlValue: string, outFile: string): void => {
  const result = spawnSync(
    'pg_dump',
    ['--schema-only', '--no-owner', '--no-privileges', '--file', outFile, databaseUrlValue],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.status !== 0) {
    throw new Error(`pg_dump exited with status ${result.status}`);
  }
};

const main = async (): Promise<void> => {
  const url = databaseUrl();
  const work = mkdtempSync(join(tmpdir(), 'cs-migrate-check-'));
  const beforePath = join(work, 'schema.before.sql');
  const afterPath = join(work, 'schema.after.sql');

  try {
    {
      const { db, migrator } = await buildMigrator({ url });
      try {
        const r = await migrator.migrateToLatest();
        if (r.error) throw r.error;
      } finally {
        await db.destroy();
      }
    }
    dumpSchema(url, beforePath);

    {
      const { db, migrator } = await buildMigrator({ url });
      try {
        const down = await migrator.migrateDown();
        if (down.error) throw down.error;
        const up = await migrator.migrateToLatest();
        if (up.error) throw up.error;
      } finally {
        await db.destroy();
      }
    }
    dumpSchema(url, afterPath);

    const before = readFileSync(beforePath, 'utf8');
    const after = readFileSync(afterPath, 'utf8');
    if (before !== after) {
      console.error('migrate-check: schema drift detected after rollback+reapply.');
      const diff = spawnSync('diff', ['-u', beforePath, afterPath], { stdio: 'inherit' });
      process.exit(diff.status ?? 1);
    }
    console.warn('migrate-check: PASS — schema is deterministic across rollback+reapply.');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

await main();
