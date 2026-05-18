/**
 * T043 — Findings service tests.
 *
 * Pins down:
 *   1. storeFindings inserts new rows and returns inserted/skipped counts.
 *   2. Idempotency: re-storing the same finding (same title in same scan)
 *      is a no-op (skipped, no duplicate row).
 *   3. Partial batch overlap: mixed new/duplicate findings are counted
 *      separately.
 *   4. All five severity Zod values (`critical|high|medium|low|info`) are
 *      accepted as-is.
 *   5. `body_md` is stored verbatim — no transformation, no escaping.
 *   6. Dedup is title-based, NOT body-based: same title with different
 *      body still dedupes (second skipped).
 *   7. Dedup is per-scan: same title in two different scans both insert.
 *   8. `listFindings` returns rows ordered by severity descending
 *      (critical → high → medium → low → info), ties broken by
 *      `created_at` ascending.
 *   9. Empty `findings[]` is a clean no-op (no error, zero counts).
 *  10. Evidence object is serialized to `evidence_json`; missing evidence
 *      stores NULL.
 *
 * Setup mirrors targets/scans tests: fresh `:memory:` DB per test, raw
 * migration apply, manual user/project/target/scan seed via drizzle.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import {
  findings as findingsTable,
  projects as projectsTable,
  scans as scansTable,
  targets as targetsTable,
  users as usersTable,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import {
  computeDedupKey,
  listFindings,
  storeFindings,
} from "./service.ts";
import type { Finding } from "../schemas/webhook.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

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

function freshMemDb(): DB {
  const db = createDb(":memory:");
  applyMigrations(db);
  return db;
}

function seedScan(db: DB, ts: number): string {
  const userId = ulid(ts);
  db.insert(usersTable)
    .values({ id: userId, email: `u-${userId}@example.com`, createdAt: ts })
    .run();
  const projectId = ulid(ts + 1);
  db.insert(projectsTable)
    .values({ id: projectId, userId, name: "p", createdAt: ts })
    .run();
  const targetId = ulid(ts + 2);
  db.insert(targetsTable)
    .values({
      id: targetId,
      projectId,
      url: "https://example.com",
      status: "verified",
      verifiedAt: ts,
      createdAt: ts,
    })
    .run();
  const scanId = ulid(ts + 3);
  db.insert(scansTable)
    .values({
      id: scanId,
      userId,
      targetId,
      profile: "standard",
      status: "running",
      startedAt: ts,
    })
    .run();
  return scanId;
}

const F = (overrides: Partial<Finding> = {}): Finding => ({
  severity: "high",
  title: "SQLi in /search",
  body_md: "## Details\n\n- payload: `' OR 1=1`",
  ...overrides,
});

// ---------------------------------------------------------------------------
// computeDedupKey — formula pinned to data-model.md L153
// ---------------------------------------------------------------------------
test("computeDedupKey returns `${scan_id}:${sha256(title)}`", () => {
  const scanId = "01HX0000000000000000000001";
  const key = computeDedupKey(scanId, "SQLi");
  expect(key.startsWith(`${scanId}:`)).toBe(true);
  // sha256 hex is 64 chars
  const hex = key.slice(scanId.length + 1);
  expect(hex).toMatch(/^[0-9a-f]{64}$/);
});

test("computeDedupKey is deterministic across calls", () => {
  const a = computeDedupKey("S1", "title");
  const b = computeDedupKey("S1", "title");
  expect(a).toBe(b);
});

test("computeDedupKey differs for different titles in same scan", () => {
  const a = computeDedupKey("S1", "title-a");
  const b = computeDedupKey("S1", "title-b");
  expect(a).not.toBe(b);
});

// ---------------------------------------------------------------------------
// storeFindings — happy insert
// ---------------------------------------------------------------------------
test("storeFindings inserts two new findings and reports counts", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  const res = await storeFindings(db, {
    scanId,
    findings: [
      F({ title: "F1", severity: "critical" }),
      F({ title: "F2", severity: "medium" }),
    ],
    now: () => ts + 10,
  });

  expect(res.inserted).toBe(2);
  expect(res.skipped).toBe(0);
  expect(res.rows).toHaveLength(2);

  const rows = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, scanId))
    .all();
  expect(rows).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// storeFindings — duplicates skipped
// ---------------------------------------------------------------------------
test("storeFindings skips a previously-stored finding (same title, same scan)", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  await storeFindings(db, {
    scanId,
    findings: [F({ title: "DUP" })],
    now: () => ts + 10,
  });
  const second = await storeFindings(db, {
    scanId,
    findings: [F({ title: "DUP" })],
    now: () => ts + 20,
  });

  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(1);
  expect(second.rows).toHaveLength(0);

  const rows = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, scanId))
    .all();
  expect(rows).toHaveLength(1);
});

test("storeFindings partial overlap: 1 dup + 1 new → inserted=1 skipped=1", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  await storeFindings(db, {
    scanId,
    findings: [F({ title: "ALREADY" })],
    now: () => ts + 10,
  });
  const second = await storeFindings(db, {
    scanId,
    findings: [F({ title: "ALREADY" }), F({ title: "NEW" })],
    now: () => ts + 20,
  });

  expect(second.inserted).toBe(1);
  expect(second.skipped).toBe(1);
  expect(second.rows).toHaveLength(1);
  expect(second.rows[0]!.title).toBe("NEW");

  const rows = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, scanId))
    .all();
  expect(rows).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// storeFindings — all five severity values
// ---------------------------------------------------------------------------
test("storeFindings accepts all five Zod severity values", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  const severities: Finding["severity"][] = [
    "critical",
    "high",
    "medium",
    "low",
    "info",
  ];
  const res = await storeFindings(db, {
    scanId,
    findings: severities.map((s, i) =>
      F({ title: `T-${s}`, severity: s, body_md: `body-${i}` }),
    ),
    now: () => ts + 10,
  });

  expect(res.inserted).toBe(5);
  expect(res.skipped).toBe(0);

  const rows = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, scanId))
    .all();
  const storedSeverities = rows.map((r) => r.severity).sort();
  const expected: Finding["severity"][] = [
    "critical",
    "high",
    "info",
    "low",
    "medium",
  ];
  expect(storedSeverities).toEqual(expected.sort());
});

// ---------------------------------------------------------------------------
// storeFindings — markdown body stored verbatim
// ---------------------------------------------------------------------------
test("storeFindings stores body_md verbatim (no escaping, no transformation)", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  const body =
    "## Header\n\n- item with `code`\n- second item\n\n```sh\necho hi\n```\n";
  const res = await storeFindings(db, {
    scanId,
    findings: [F({ title: "MD-T", body_md: body })],
    now: () => ts + 10,
  });

  expect(res.inserted).toBe(1);
  expect(res.rows[0]!.body_md).toBe(body);

  const [row] = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, scanId))
    .all();
  expect(row!.bodyMd).toBe(body);
});

// ---------------------------------------------------------------------------
// dedup_key title-based — different body, same title → skipped
// ---------------------------------------------------------------------------
test("storeFindings dedups on title even when body_md differs", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  await storeFindings(db, {
    scanId,
    findings: [F({ title: "T", body_md: "first body" })],
    now: () => ts + 10,
  });
  const second = await storeFindings(db, {
    scanId,
    findings: [F({ title: "T", body_md: "second body — different" })],
    now: () => ts + 20,
  });

  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(1);

  const rows = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, scanId))
    .all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.bodyMd).toBe("first body");
});

// ---------------------------------------------------------------------------
// dedup_key per-scan — same title in two scans → both insert
// ---------------------------------------------------------------------------
test("storeFindings allows same title across different scans (dedup is per-scan)", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanA = seedScan(db, ts);
  const scanB = seedScan(db, ts + 100);

  const a = await storeFindings(db, {
    scanId: scanA,
    findings: [F({ title: "SAME" })],
    now: () => ts + 10,
  });
  const b = await storeFindings(db, {
    scanId: scanB,
    findings: [F({ title: "SAME" })],
    now: () => ts + 110,
  });

  expect(a.inserted).toBe(1);
  expect(b.inserted).toBe(1);

  const all = db.select().from(findingsTable).all();
  expect(all).toHaveLength(2);
  const scanIds = all.map((r) => r.scanId).sort();
  expect(scanIds).toEqual([scanA, scanB].sort());
});

// ---------------------------------------------------------------------------
// listFindings — ordering by severity DESC then created_at ASC
// ---------------------------------------------------------------------------
test("listFindings orders rows critical→high→medium→low→info, ties by created_at asc", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  // Insert in a deliberately scrambled order, with two `medium` rows to
  // verify the tiebreaker.
  let t = ts + 10;
  const order: Finding[] = [
    F({ title: "low-1", severity: "low" }),
    F({ title: "med-EARLY", severity: "medium" }),
    F({ title: "info-1", severity: "info" }),
    F({ title: "crit-1", severity: "critical" }),
    F({ title: "med-LATE", severity: "medium" }),
    F({ title: "high-1", severity: "high" }),
  ];
  for (const f of order) {
    await storeFindings(db, { scanId, findings: [f], now: () => t });
    t += 1;
  }

  const rows = await listFindings(db, { scanId });
  expect(rows.map((r) => r.title)).toEqual([
    "crit-1",
    "high-1",
    "med-EARLY",
    "med-LATE",
    "low-1",
    "info-1",
  ]);
});

// ---------------------------------------------------------------------------
// empty findings array is a clean no-op
// ---------------------------------------------------------------------------
test("storeFindings with empty findings[] is a no-op", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  const res = await storeFindings(db, {
    scanId,
    findings: [],
    now: () => ts + 10,
  });
  expect(res.inserted).toBe(0);
  expect(res.skipped).toBe(0);
  expect(res.rows).toHaveLength(0);

  const rows = db.select().from(findingsTable).all();
  expect(rows).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// evidence stored as JSON; absent evidence → NULL
// ---------------------------------------------------------------------------
test("storeFindings serialises evidence to JSON and stores NULL when omitted", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  await storeFindings(db, {
    scanId,
    findings: [
      F({
        title: "with-ev",
        evidence: { request: "GET / HTTP/1.1", response: "200 OK" },
      }),
      F({ title: "no-ev" }),
    ],
    now: () => ts + 10,
  });

  const rows = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, scanId))
    .all();
  const byTitle = new Map(rows.map((r) => [r.title, r]));

  expect(byTitle.get("no-ev")!.evidenceJson).toBeNull();

  const stored = byTitle.get("with-ev")!.evidenceJson;
  expect(typeof stored).toBe("string");
  expect(stored).not.toBeNull();
  const parsed = JSON.parse(stored!);
  expect(parsed).toEqual({ request: "GET / HTTP/1.1", response: "200 OK" });
});

// ---------------------------------------------------------------------------
// listFindings — unknown scan → empty array
// ---------------------------------------------------------------------------
test("listFindings returns [] for a scan with no findings", async () => {
  const db = freshMemDb();
  const ts = 1_700_000_000_000;
  const scanId = seedScan(db, ts);

  const rows = await listFindings(db, { scanId });
  expect(rows).toEqual([]);
});
