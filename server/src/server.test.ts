import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createDb } from "./db/client.ts";
import { applyMigrationsOnce } from "./server.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

function raw(db: ReturnType<typeof createDb>): Database {
  return db.$client as Database;
}

function execMigrationFile(db: ReturnType<typeof createDb>, file: string): void {
  raw(db).exec(
    readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(
      /-->\s*statement-breakpoint/g,
      "",
    ),
  );
}

function tableExists(db: ReturnType<typeof createDb>, name: string): boolean {
  return Boolean(
    raw(db)
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name),
  );
}

function appliedTags(db: ReturnType<typeof createDb>): string[] {
  return raw(db)
    .query<{ tag: string }, []>("SELECT tag FROM __migrations ORDER BY tag")
    .all()
    .map((row) => row.tag);
}

describe("applyMigrationsOnce", () => {
  test("warms an older DB and applies new migrations instead of skipping on users", () => {
    const db = createDb(":memory:");
    execMigrationFile(db, "0000_init.sql");

    expect(tableExists(db, "users")).toBe(true);
    expect(tableExists(db, "agent_api_tokens")).toBe(false);

    const first = applyMigrationsOnce(db, MIGRATIONS_DIR);

    expect(first.applied).toBe(true);
    expect(tableExists(db, "agent_api_tokens")).toBe(true);
    expect(appliedTags(db)).toContain("0000_init");
    expect(appliedTags(db)).toContain("0015_agent_api_tokens");

    const second = applyMigrationsOnce(db, MIGRATIONS_DIR);
    expect(second.applied).toBe(false);
  });
});
