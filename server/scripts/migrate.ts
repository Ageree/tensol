#!/usr/bin/env bun
/**
 * Bun-native SQLite migrator.
 *
 * Promoted from VM-side `/opt/tensol/migrate-once.ts` to replace the
 * `drizzle-kit migrate` pipeline, which pulls in Node + an ABI-matched
 * `better-sqlite3` build that doesn't survive an alpine + bun image.
 *
 * Behaviour:
 *   - Resolves the DB path from `process.env.TENSOL_DB_URL` (accepts
 *     `file:` URLs and bare paths). Falls back to `./data/tensol.db`
 *     relative to the server dir.
 *   - Discovers every `*.sql` file in `server/migrations/` (sorted by
 *     filename, which is also their numeric order — `0000_init.sql`,
 *     `0010_blackbox_mvp.sql`, `0011_webhook_dedup.sql`, ...).
 *   - Tracks applied migrations in a `__migrations` table so reruns are
 *     idempotent.
 *   - Splits each `.sql` file on the `--> statement-breakpoint` marker
 *     produced by drizzle-kit and runs the statements one-by-one inside
 *     a transaction.
 *
 * Usage:
 *   bun run scripts/migrate.ts
 *   TENSOL_DB_URL=file:/tmp/x.db bun run scripts/migrate.ts
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MIGRATIONS_TABLE = "__migrations";

function resolveDbPath(): string {
  const raw = process.env.TENSOL_DB_URL ?? "file:./data/tensol.db";
  // Accept `file:` URLs and bare relative/absolute paths.
  const stripped = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  // Drop a leading `//` if present (file://./path style).
  const cleaned = stripped.replace(/^\/\//, "");
  return resolve(cleaned);
}

function resolveMigrationsDir(): string {
  // This script lives at server/scripts/migrate.ts, so the migrations
  // directory is one level up.
  return resolve(import.meta.dir, "..", "migrations");
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  try {
    statSync(dir);
  } catch {
    mkdirSync(dir, { recursive: true });
  }
}

function splitStatements(sql: string): string[] {
  // drizzle-kit emits `--> statement-breakpoint` between every CREATE/INDEX
  // statement. The marker appears in two shapes:
  //   1) inline at end of a statement:  CREATE INDEX ...;--> statement-breakpoint
  //   2) on its own line:               --> statement-breakpoint
  //
  // It can also appear inside a `--` comment line (e.g. a header that
  // explains the format) which we must NOT treat as a real breakpoint.
  //
  // Strategy: drop any line that begins (after whitespace) with `--` but
  // is NOT the inline-trailing form. Then split on the marker. Plain `;`
  // splitting is unsafe because TRIGGER/VIEW bodies contain inner
  // semicolons.
  const cleaned = sql
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Keep blank lines (separator), keep SQL lines.
      if (trimmed.length === 0) return true;
      // The standalone breakpoint marker itself starts with `-->`. Keep it.
      if (trimmed.startsWith("-->")) return true;
      // Drop pure `--` comment lines.
      if (trimmed.startsWith("--")) return false;
      return true;
    })
    .join("\n");

  return cleaned
    .split(/-->\s*statement-breakpoint\s*/g)
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

function main(): void {
  const dbPath = resolveDbPath();
  const migrationsDir = resolveMigrationsDir();

  ensureParentDir(dbPath);

  console.log(`[migrate] db=${dbPath}`);
  console.log(`[migrate] migrations=${migrationsDir}`);

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       tag TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );

  const appliedRows = db
    .query<{ tag: string }, []>(`SELECT tag FROM ${MIGRATIONS_TABLE}`)
    .all();
  const applied = new Set(appliedRows.map((r) => r.tag));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("[migrate] no .sql files found — nothing to do");
    db.close();
    return;
  }

  let appliedCount = 0;
  for (const file of files) {
    const tag = file.replace(/\.sql$/, "");
    if (applied.has(tag)) {
      console.log(`[migrate] skip ${tag} (already applied)`);
      continue;
    }

    const filePath = join(migrationsDir, file);
    const sql = readFileSync(filePath, "utf8");
    const statements = splitStatements(sql);

    console.log(`[migrate] apply ${tag} (${statements.length} statements)`);

    db.exec("BEGIN");
    try {
      for (const stmt of statements) {
        db.exec(stmt);
      }
      db.run(
        `INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES (?, ?)`,
        [tag, Date.now()],
      );
      db.exec("COMMIT");
      appliedCount += 1;
    } catch (err) {
      db.exec("ROLLBACK");
      console.error(`[migrate] FAILED on ${tag}:`, err);
      db.close();
      process.exit(1);
    }
  }

  console.log(`[migrate] done — applied ${appliedCount}, skipped ${files.length - appliedCount}`);
  db.close();
}

main();
