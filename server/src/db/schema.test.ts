/**
 * T010 — DDL contract test for the initial migration.
 *
 * Strategy:
 *   1. Apply `migrations/0000_init.sql` to a fresh `:memory:` SQLite DB.
 *   2. Assert every expected table, column, FK, and index exists via PRAGMA.
 *
 * If any table/column/index drifts from `specs/001-backend-v2/data-model.md`,
 * this test fails — the migration file is the single source of truth at
 * runtime, the schema.ts is what generates it.
 */
import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: 0 | 1;
}

interface IndexRow {
  seq: number;
  name: string;
  unique: 0 | 1;
  origin: "c" | "u" | "pk";
  partial: 0 | 1;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface TableListRow {
  schema: string;
  name: string;
  type: string;
  ncol: number;
  wr: 0 | 1;
  strict: 0 | 1;
}

let db: Database;

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

beforeAll(() => {
  db = new Database(":memory:");
  // Drizzle 0000_init.sql uses `--> statement-breakpoint` markers between
  // statements; better-sqlite3 `exec()` handles multi-statement SQL fine,
  // but we strip the markers first so they don't pollute statement parsing.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .sql migrations found in ${MIGRATIONS_DIR}`);
  }
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(
      /-->\s*statement-breakpoint/g,
      "",
    );
    db.exec(sql);
  }
});

const EXPECTED_TABLES = [
  "users",
  "sessions",
  "magic_link_tokens",
  "projects",
  "targets",
  "auth_proofs",
  "scans",
  "findings",
  "audit_log",
  "vps_instances",
  "jobs",
] as const;

function tableInfo(name: string): ColumnRow[] {
  return db.prepare(`PRAGMA table_info(${name})`).all() as unknown as ColumnRow[];
}

function indexList(name: string): IndexRow[] {
  return db.prepare(`PRAGMA index_list(${name})`).all() as unknown as IndexRow[];
}

function indexInfo(name: string): IndexInfoRow[] {
  return db.prepare(`PRAGMA index_info(${name})`).all() as unknown as IndexInfoRow[];
}

function foreignKeyList(name: string): ForeignKeyRow[] {
  return db.prepare(`PRAGMA foreign_key_list(${name})`).all() as unknown as ForeignKeyRow[];
}

function columnNames(name: string): string[] {
  return tableInfo(name).map((c) => c.name);
}

function indexColumnNames(idxName: string): string[] {
  return indexInfo(idxName)
    .sort((a, b) => a.seqno - b.seqno)
    .map((i) => i.name);
}

function hasIndexOn(table: string, cols: string[]): boolean {
  const expected = cols.join(",");
  return indexList(table).some(
    (idx) => indexColumnNames(idx.name).join(",") === expected,
  );
}

test("all 11 expected tables exist", () => {
  const tables = (
    db.prepare(`PRAGMA table_list`).all() as unknown as TableListRow[]
  )
    .filter(
      (t) =>
        t.schema === "main" &&
        !t.name.startsWith("sqlite_") &&
        !t.name.startsWith("__drizzle"),
    )
    .map((t) => t.name)
    .sort();

  for (const expected of EXPECTED_TABLES) {
    expect(tables).toContain(expected);
  }
});

test("users columns + indexes", () => {
  expect(columnNames("users").sort()).toEqual(
    ["id", "email", "created_at"].sort(),
  );
  const info = tableInfo("users");
  expect(info.find((c) => c.name === "id")?.pk).toBe(1);
  expect(info.find((c) => c.name === "email")?.notnull).toBe(1);
  // email UNIQUE
  const idxs = indexList("users");
  const emailIdx = idxs.find(
    (i) => indexColumnNames(i.name).join(",") === "email",
  );
  expect(emailIdx?.unique).toBe(1);
});

test("sessions columns + FK + indexes", () => {
  expect(columnNames("sessions").sort()).toEqual(
    ["id", "user_id", "created_at", "expires_at"].sort(),
  );
  const fks = foreignKeyList("sessions");
  expect(fks.some((fk) => fk.table === "users" && fk.from === "user_id")).toBe(
    true,
  );
  expect(hasIndexOn("sessions", ["user_id"])).toBe(true);
  expect(hasIndexOn("sessions", ["expires_at"])).toBe(true);
});

test("magic_link_tokens columns + indexes", () => {
  expect(columnNames("magic_link_tokens").sort()).toEqual(
    ["token", "email", "expires_at", "used_at"].sort(),
  );
  const info = tableInfo("magic_link_tokens");
  expect(info.find((c) => c.name === "token")?.pk).toBe(1);
  expect(info.find((c) => c.name === "used_at")?.notnull).toBe(0);
  expect(hasIndexOn("magic_link_tokens", ["email"])).toBe(true);
  expect(hasIndexOn("magic_link_tokens", ["expires_at"])).toBe(true);
});

test("projects columns + FK + indexes", () => {
  expect(columnNames("projects").sort()).toEqual(
    ["id", "user_id", "name", "created_at"].sort(),
  );
  const fks = foreignKeyList("projects");
  expect(fks.some((fk) => fk.table === "users" && fk.from === "user_id")).toBe(
    true,
  );
  expect(hasIndexOn("projects", ["user_id"])).toBe(true);
});

test("targets columns + FK + indexes", () => {
  expect(columnNames("targets").sort()).toEqual(
    ["id", "project_id", "url", "status", "verified_at", "created_at"].sort(),
  );
  const fks = foreignKeyList("targets");
  expect(
    fks.some((fk) => fk.table === "projects" && fk.from === "project_id"),
  ).toBe(true);
  expect(hasIndexOn("targets", ["project_id"])).toBe(true);
  expect(hasIndexOn("targets", ["status"])).toBe(true);
});

test("auth_proofs columns + FK + indexes", () => {
  expect(columnNames("auth_proofs").sort()).toEqual(
    [
      "id",
      "target_id",
      "challenge",
      "method",
      "status",
      "created_at",
      "verified_at",
      "expires_at",
    ].sort(),
  );
  const fks = foreignKeyList("auth_proofs");
  expect(
    fks.some((fk) => fk.table === "targets" && fk.from === "target_id"),
  ).toBe(true);
  expect(hasIndexOn("auth_proofs", ["target_id"])).toBe(true);
  expect(hasIndexOn("auth_proofs", ["status"])).toBe(true);
  expect(hasIndexOn("auth_proofs", ["expires_at"])).toBe(true);
});

test("scans columns + FKs + indexes", () => {
  expect(columnNames("scans").sort()).toEqual(
    [
      "id",
      "user_id",
      "target_id",
      "profile",
      "status",
      "failure_reason",
      "started_at",
      "completed_at",
      "usage_tokens",
      "usage_usd_cents",
    ].sort(),
  );
  const fks = foreignKeyList("scans");
  expect(fks.some((fk) => fk.table === "users" && fk.from === "user_id")).toBe(
    true,
  );
  expect(
    fks.some((fk) => fk.table === "targets" && fk.from === "target_id"),
  ).toBe(true);
  expect(hasIndexOn("scans", ["user_id"])).toBe(true);
  expect(hasIndexOn("scans", ["target_id"])).toBe(true);
  expect(hasIndexOn("scans", ["status"])).toBe(true);
});

test("findings columns + FK + indexes (dedup_key UNIQUE)", () => {
  expect(columnNames("findings").sort()).toEqual(
    [
      "id",
      "scan_id",
      "severity",
      "title",
      "body_md",
      "evidence_json",
      "created_at",
      "dedup_key",
    ].sort(),
  );
  const fks = foreignKeyList("findings");
  expect(fks.some((fk) => fk.table === "scans" && fk.from === "scan_id")).toBe(
    true,
  );
  expect(hasIndexOn("findings", ["scan_id"])).toBe(true);

  const dedupIdx = indexList("findings").find(
    (i) => indexColumnNames(i.name).join(",") === "dedup_key",
  );
  expect(dedupIdx?.unique).toBe(1);
});

test("audit_log columns + autoincrement id + indexes", () => {
  const cols = columnNames("audit_log").sort();
  expect(cols).toEqual(
    [
      "id",
      "ts",
      "event",
      "user_id",
      "project_id",
      "target_id",
      "scan_id",
      "vps_instance_id",
      "auth_proof_id",
      "finding_id",
      "severity",
      "outcome",
      "metadata_json",
      "prev_signature",
      "signature",
    ].sort(),
  );
  const info = tableInfo("audit_log");
  expect(info.find((c) => c.name === "id")?.pk).toBe(1);
  // No FKs — audit_log refs are denormalized strings (intentionally; see
  // data-model.md: "nullable FKs" semantically, but we keep them as plain
  // text columns for operational flexibility and to never block writes).
  expect(hasIndexOn("audit_log", ["scan_id"])).toBe(true);
  expect(hasIndexOn("audit_log", ["event"])).toBe(true);
  expect(hasIndexOn("audit_log", ["ts"])).toBe(true);
});

test("vps_instances columns + FK + indexes (scan_id UNIQUE)", () => {
  expect(columnNames("vps_instances").sort()).toEqual(
    [
      "id",
      "scan_id",
      "provider",
      "provider_server_id",
      "ipv4",
      "status",
      "sign_key",
      "created_at",
      "destroyed_at",
    ].sort(),
  );
  const fks = foreignKeyList("vps_instances");
  expect(fks.some((fk) => fk.table === "scans" && fk.from === "scan_id")).toBe(
    true,
  );

  const scanIdx = indexList("vps_instances").find(
    (i) => indexColumnNames(i.name).join(",") === "scan_id",
  );
  expect(scanIdx?.unique).toBe(1);
  expect(hasIndexOn("vps_instances", ["status"])).toBe(true);
});

test("jobs columns + composite index + type index", () => {
  expect(columnNames("jobs").sort()).toEqual(
    [
      "id",
      "type",
      "payload_json",
      "status",
      "scheduled_at",
      "attempts",
      "last_error",
      "created_at",
      "updated_at",
    ].sort(),
  );
  // Composite (status, scheduled_at)
  expect(hasIndexOn("jobs", ["status", "scheduled_at"])).toBe(true);
  expect(hasIndexOn("jobs", ["type"])).toBe(true);
});

test("foreign_keys PRAGMA can be enabled (sanity)", () => {
  db.exec("PRAGMA foreign_keys = ON;");
  const r = db
    .prepare("PRAGMA foreign_keys")
    .get() as unknown as { foreign_keys: number };
  expect(r.foreign_keys).toBe(1);
});
