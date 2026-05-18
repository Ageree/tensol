/**
 * T015 — verify-chain tests.
 *
 * Four guarantees pinned down:
 *   1. `verifyChain(db, key)` on an empty `audit_log` returns ok with 0 rows.
 *   2. After seeding 10 rows via `emitSignedAudit`, verify returns ok with 10
 *      rows and the chain is byte-perfectly recomputable.
 *   3. Tampering with row 5's `metadata_json` (out-of-band UPDATE) causes
 *      verify to fail at exactly row 5 — every later row chains off the
 *      mutated row but cannot pass its own check because the prev-link
 *      hashes to a different value.
 *   4. Tampering with a row's `signature` column itself causes verify to
 *      fail at that row (different failure mode from metadata tamper:
 *      detected by signature mismatch against an untouched canonical msg).
 *
 * Setup mirrors `audit/emit.test.ts`: ad-hoc `:memory:` DB via `createDb`,
 * raw bun:sqlite handle to apply the bundled migration SQL. The CLI smoke
 * test uses an on-disk fixture because spawning `bun src/audit/verify-chain.ts`
 * in a new process cannot share a `:memory:` handle with the parent test.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import { auditLog } from "../db/schema.ts";
import { emitSignedAudit } from "./emit.ts";
import { verifyChain } from "./verify-chain.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-verify-chain";

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .sql migrations found in ${MIGRATIONS_DIR}`);
  }
  return files
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

function applyMigrations(db: DB): void {
  (db.$client as Database).exec(migrationSql());
}

async function seedRows(db: DB, n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await emitSignedAudit(
      db,
      {
        event: `e_${i}`,
        outcome: "success",
        ts: 1700000000000 + i * 1000,
        metadata: { i, payload: `row-${i}` },
      },
      { key: KEY },
    );
    ids.push(r.id);
  }
  return ids;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-verify-chain-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — empty DB → ok with 0 rows.
// ---------------------------------------------------------------------------
test("verifyChain returns ok with 0 rows on an empty audit_log", () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const res = verifyChain(db, KEY);
  expect(res.ok).toBe(true);
  expect(res.rows).toBe(0);
  expect(res.brokenAt).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Test 2 — 10 seeded rows → ok with 10 rows.
// ---------------------------------------------------------------------------
test("verifyChain returns ok after seeding 10 well-formed rows", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const ids = await seedRows(db, 10);
  expect(ids).toHaveLength(10);

  const res = verifyChain(db, KEY);
  expect(res.ok).toBe(true);
  expect(res.rows).toBe(10);
  expect(res.brokenAt).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Test 3 — tamper row 5 metadata → fails at row 5.
// ---------------------------------------------------------------------------
test("verifyChain detects metadata tampering at the exact row that was mutated", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const ids = await seedRows(db, 10);
  const targetId = ids[4]!; // "row 5" — 1-indexed in narrative.

  // Out-of-band metadata mutation: rewrite the JSON column on row 5 without
  // touching its signature. The canonical message changes → recomputed
  // signature no longer matches the stored one → verifier flags row 5.
  db.update(auditLog)
    .set({ metadataJson: '{"tampered":true}' })
    .where(eq(auditLog.id, targetId))
    .run();

  const res = verifyChain(db, KEY);
  expect(res.ok).toBe(false);
  expect(res.brokenAt).toBe(targetId);
  expect(res.rows).toBe(10);
});

// ---------------------------------------------------------------------------
// Test 4 — tamper signature column directly → fails at that row.
// ---------------------------------------------------------------------------
test("verifyChain detects direct signature tampering at the exact row", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const ids = await seedRows(db, 10);
  const targetId = ids[6]!; // "row 7".

  // Overwrite the signature with a valid-shape hex string that does NOT
  // correspond to any canonical message we know. Verifier should flag this
  // exact row.
  db.update(auditLog)
    .set({ signature: "deadbeef".repeat(8) })
    .where(eq(auditLog.id, targetId))
    .run();

  const res = verifyChain(db, KEY);
  expect(res.ok).toBe(false);
  expect(res.brokenAt).toBe(targetId);
});

// ---------------------------------------------------------------------------
// Test 5 — CLI smoke: `bun src/audit/verify-chain.ts --db <fixture>` exits 0
// on a fresh DB with applied migrations, and prints `chain ok: 0 rows`.
// Acceptance criterion from tasks.md line 38.
// ---------------------------------------------------------------------------
test("CLI exits 0 on a fresh DB and prints 'chain ok: 0 rows'", async () => {
  const dbPath = join(tmpDir, "cli-smoke.sqlite");

  // Bootstrap schema. Verify-chain CLI does NOT apply migrations to disk
  // DBs (only :memory: gets the convenience auto-apply) so we seed it here.
  const boot = createDb(dbPath);
  applyMigrations(boot);
  (boot.$client as Database).close();

  const cliPath = join(import.meta.dir, "verify-chain.ts");
  const proc = Bun.spawn(
    ["bun", "run", cliPath, "--db", dbPath, "--key", KEY],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  expect(exitCode).toBe(0);
  expect(stdout).toContain("chain ok: 0 rows");
});

// ---------------------------------------------------------------------------
// Test 6 — CLI exits 0 on `--db :memory:` (the literal acceptance command
// from tasks.md). `:memory:` per-process means a fresh empty DB each time,
// but verify needs schema present — the CLI must auto-apply migrations to
// `:memory:` so the SELECT does not blow up with "no such table".
// ---------------------------------------------------------------------------
test("CLI exits 0 on --db :memory: (acceptance criterion from tasks.md)", async () => {
  const cliPath = join(import.meta.dir, "verify-chain.ts");
  const proc = Bun.spawn(
    ["bun", "run", cliPath, "--db", ":memory:", "--key", KEY],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  expect(exitCode).toBe(0);
  expect(stdout).toContain("chain ok: 0 rows");
});

// ---------------------------------------------------------------------------
// Test 7 — CLI exits 1 and prints `chain broken at row X` on tampered DB.
// ---------------------------------------------------------------------------
test("CLI exits 1 and prints broken-at-row on tampered fixture", async () => {
  const dbPath = join(tmpDir, "cli-tamper.sqlite");
  const db = createDb(dbPath);
  applyMigrations(db);
  const ids = await seedRows(db, 5);
  const targetId = ids[2]!;
  db.update(auditLog)
    .set({ metadataJson: '{"tampered":true}' })
    .where(eq(auditLog.id, targetId))
    .run();
  (db.$client as Database).close();

  const cliPath = join(import.meta.dir, "verify-chain.ts");
  const proc = Bun.spawn(
    ["bun", "run", cliPath, "--db", dbPath, "--key", KEY],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  expect(exitCode).toBe(1);
  expect(stdout).toContain(`chain broken at row ${targetId}`);

  // Suppress unused-import warning.
  void sql;
});
