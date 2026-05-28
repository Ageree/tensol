/**
 * T014 — emitSignedAudit tests.
 *
 * Pins down four guarantees:
 *   1. A single emit inserts exactly one row whose `signature` and
 *      `prev_signature` agree with `signEntry`/the prior row.
 *   2. Concurrent emits across multiple connections to the same on-disk DB
 *      serialise via `BEGIN IMMEDIATE` and produce a contiguous `id` range
 *      (1..N) with byte-perfectly chained signatures.
 *   3. The chain links: row N+1's `prev_signature` is row N's `signature`,
 *      and recomputing `signEntry(key, entryN+1, rowN.signature)` matches
 *      row N+1's stored signature exactly.
 *   4. Metadata top-level keys serialise alpha-sorted in `metadata_json`
 *      (same canonicalisation as T013).
 *
 * Setup mirrors `db/client.test.ts`: ad-hoc :memory: DB through `createDb`,
 * then we run the bundled migration SQL directly on the raw bun:sqlite
 * handle. Concurrency test uses a real temp file because two separate
 * `:memory:` opens do NOT share state.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import { auditLog } from "../db/schema.ts";
import { signEntry, type AuditEntry } from "./sign.ts";
import { emitSignedAudit } from "./emit.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-emit";

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

/** Build an AuditEntry from a stored row so we can recompute signatures and
 *  byte-compare against the chained `signature` column. */
function rowToEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  return {
    event: row.event,
    ts: row.ts,
    userId: row.userId,
    projectId: row.projectId,
    targetId: row.targetId,
    scanId: row.scanId,
    vpsInstanceId: row.vpsInstanceId,
    authProofId: row.authProofId,
    findingId: row.findingId,
    severity: row.severity,
    outcome: row.outcome,
    metadataJson: JSON.parse(row.metadataJson) as Record<string, unknown>,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-emit-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — single emit inserts one well-formed row.
// ---------------------------------------------------------------------------
test("single emit inserts one row with non-empty hex signature and prev_signature=''", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const result = await emitSignedAudit(
    db,
    { event: "scan_started", outcome: "success" },
    { key: KEY },
  );

  expect(result.id).toBeGreaterThan(0);
  expect(result.signature).toMatch(/^[0-9a-f]{64}$/);

  const rows = db.select().from(auditLog).all();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.id).toBe(result.id);
  expect(row.signature).toBe(result.signature);
  expect(row.prevSignature).toBe(""); // empty 13th field for first row
  expect(row.event).toBe("scan_started");
  expect(row.outcome).toBe("success");
  expect(row.metadataJson).toBe("{}");

  // Recompute and compare byte-perfectly.
  const recomputed = signEntry(KEY, rowToEntry(row), null);
  expect(recomputed).toBe(row.signature);
});

// ---------------------------------------------------------------------------
// Test 2 — defaults: ts comes from now(); ulid-style id field; metadata empty.
// ---------------------------------------------------------------------------
test("emit defaults ts to now() and metadata to empty object", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const before = Date.now();
  await emitSignedAudit(
    db,
    { event: "boot", outcome: "success" },
    { key: KEY },
  );
  const after = Date.now();

  const row = db.select().from(auditLog).get()!;
  expect(row.ts).toBeGreaterThanOrEqual(before);
  expect(row.ts).toBeLessThanOrEqual(after);
  expect(row.metadataJson).toBe("{}");
});

// ---------------------------------------------------------------------------
// Test 3 — chain: three sequential emits link via prev_signature.
// ---------------------------------------------------------------------------
test("sequential emits chain: each row's prev_signature equals previous row's signature", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const r1 = await emitSignedAudit(
    db,
    { event: "e1", outcome: "success", ts: 1700000000000 },
    { key: KEY },
  );
  const r2 = await emitSignedAudit(
    db,
    {
      event: "e2",
      outcome: "success",
      ts: 1700000060000,
      metadata: { b: 1, a: 2 },
    },
    { key: KEY },
  );
  const r3 = await emitSignedAudit(
    db,
    {
      event: "e3",
      outcome: "failure",
      ts: 1700000120000,
      severity: "high",
      finding_id: "f_01",
    },
    { key: KEY },
  );

  const rows = db
    .select()
    .from(auditLog)
    .orderBy(asc(auditLog.id))
    .all();
  expect(rows).toHaveLength(3);

  // id is autoincrement INTEGER PK → strictly monotonic.
  expect(rows[0]!.id).toBe(r1.id);
  expect(rows[1]!.id).toBe(r2.id);
  expect(rows[2]!.id).toBe(r3.id);

  // prev_signature links to the previous row's signature.
  expect(rows[0]!.prevSignature).toBe("");
  expect(rows[1]!.prevSignature).toBe(rows[0]!.signature);
  expect(rows[2]!.prevSignature).toBe(rows[1]!.signature);

  // Byte-perfectly recompute each row.
  expect(signEntry(KEY, rowToEntry(rows[0]!), null)).toBe(rows[0]!.signature);
  expect(signEntry(KEY, rowToEntry(rows[1]!), rows[0]!.signature)).toBe(
    rows[1]!.signature,
  );
  expect(signEntry(KEY, rowToEntry(rows[2]!), rows[1]!.signature)).toBe(
    rows[2]!.signature,
  );

  // Row 2's metadata_json must be alpha-sorted.
  expect(rows[1]!.metadataJson).toBe('{"a":2,"b":1}');
});

// ---------------------------------------------------------------------------
// Test 4 — CRITICAL: concurrent emits across separate connections serialise
// via BEGIN IMMEDIATE; ids form a contiguous range; chain verifies.
// ---------------------------------------------------------------------------
test(
  "concurrent emits across connections produce contiguous chained rows",
  async () => {
    const dbPath = join(tmpDir, "concurrent-emit.sqlite");

    // Bootstrap schema on a throwaway connection.
    const boot = createDb(dbPath);
    applyMigrations(boot);
    (boot.$client as Database).close();

    const N = 5;
    const conns = Array.from({ length: N }, () => createDb(dbPath));

    try {
      await Promise.all(
        conns.map((conn, i) =>
          emitSignedAudit(
            conn,
            {
              event: "concurrent",
              outcome: "success",
              metadata: { i },
            },
            { key: KEY },
          ),
        ),
      );

      const rows = boot
        ? // boot is closed; use any live conn
          conns[0]!
            .select()
            .from(auditLog)
            .orderBy(asc(auditLog.id))
            .all()
        : [];

      expect(rows).toHaveLength(N);

      // ids must be contiguous 1..N (autoincrement, no gaps from rollback).
      for (let i = 0; i < N; i++) {
        expect(rows[i]!.id).toBe(i + 1);
      }

      // First row has empty prev; subsequent rows chain.
      expect(rows[0]!.prevSignature).toBe("");
      for (let i = 1; i < N; i++) {
        expect(rows[i]!.prevSignature).toBe(rows[i - 1]!.signature);
      }

      // Byte-perfectly recompute every signature.
      let prev: string | null = null;
      for (const row of rows) {
        const expected = signEntry(KEY, rowToEntry(row), prev);
        expect(row.signature).toBe(expected);
        prev = row.signature;
      }
    } finally {
      for (const conn of conns) {
        (conn.$client as Database).close();
      }
    }
  },
  20_000,
);

// ---------------------------------------------------------------------------
// Test 5 — metadata top-level keys are stored alpha-sorted (canonicalised).
// ---------------------------------------------------------------------------
test("metadata stored alpha-sorted in metadata_json column", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  await emitSignedAudit(
    db,
    {
      event: "sortcheck",
      outcome: "success",
      metadata: { zeta: 1, alpha: 2, mu: 3 },
    },
    { key: KEY },
  );

  const row = db.select().from(auditLog).get()!;
  expect(row.metadataJson).toBe('{"alpha":2,"mu":3,"zeta":1}');
  // Keys appear in alpha order in the raw JSON string.
  const json = row.metadataJson;
  expect(json.indexOf("alpha")).toBeLessThan(json.indexOf("mu"));
  expect(json.indexOf("mu")).toBeLessThan(json.indexOf("zeta"));
});

// ---------------------------------------------------------------------------
// Test 6 — nullable fields round-trip correctly through the canonical msg.
// ---------------------------------------------------------------------------
test("nullable foreign keys persist as NULL and canonicalise to empty fields", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  await emitSignedAudit(
    db,
    {
      event: "finding_recorded",
      outcome: "success",
      ts: 1700000120000,
      project_id: "p_01",
      target_id: "t_01",
      scan_id: "s_01",
      vps_instance_id: "v_01",
      finding_id: "f_01",
      severity: "high",
      metadata: { cve: "CVE-2024-1234" },
    },
    { key: KEY },
  );

  const row = db.select().from(auditLog).get()!;
  expect(row.userId).toBeNull();
  expect(row.authProofId).toBeNull();
  expect(row.projectId).toBe("p_01");
  expect(row.severity).toBe("high");

  // The recomputed signature is the same as a direct signEntry call.
  const expected = signEntry(KEY, rowToEntry(row), null);
  expect(row.signature).toBe(expected);

  // Silence unused import (sql/eq are documented surface here even if not
  // used by every test).
  void sql;
  void eq;
});
