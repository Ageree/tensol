/**
 * T013 — DDL contract test for migration `0010_blackbox_mvp.sql`.
 *
 * Strategy:
 *   1. Apply `migrations/0000_init.sql` THEN `migrations/0010_blackbox_mvp.sql`
 *      to a fresh `:memory:` SQLite DB (must layer because 0010 ALTERs/DROPs
 *      tables created by 0000).
 *   2. Assert the post-0010 schema shape via SQLite `PRAGMA` introspection:
 *      table presence/absence, per-column shape, indexes (count + spot-check),
 *      foreign keys, CHECK constraints, full smoke insert chain.
 *
 * This test locks in T011 ↔ T012 parity. If the migration SQL drifts from
 * `specs/002-blackbox-mvp/data-model.md` (E1–E11) or from `server/src/db/schema.ts`,
 * one of these PRAGMA assertions fails.
 *
 * Bun + bun:sqlite native — no better-sqlite3 import (Constitution III).
 */
import { test, expect, beforeAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// PRAGMA row shapes (mirror server/src/db/schema.test.ts)
// ---------------------------------------------------------------------------
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

/**
 * Strip drizzle's `--> statement-breakpoint` markers so bun:sqlite `exec()`
 * sees a clean multi-statement SQL blob.
 */
function loadMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(
    /-->\s*statement-breakpoint/g,
    "",
  );
}

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(loadMigration("0000_init.sql"));
  db.exec(loadMigration("0010_blackbox_mvp.sql"));
  // 0011 layers `webhook_dedup` on top of the 0010 baseline. Applied here
  // so the table-presence + index assertions below cover the post-0011
  // shape that production boots into via applyMigrationsOnce().
  db.exec(loadMigration("0011_webhook_dedup.sql"));
  // Foreign keys default OFF; turn ON so FK + CASCADE assertions in the
  // smoke insert chain behave like production (createDb in client.ts also
  // enables them per connection).
  db.exec("PRAGMA foreign_keys = ON;");
});

// ---------------------------------------------------------------------------
// PRAGMA helpers
// ---------------------------------------------------------------------------
function tableInfo(name: string): ColumnRow[] {
  return db
    .prepare(`PRAGMA table_info(${name})`)
    .all() as unknown as ColumnRow[];
}

function indexList(name: string): IndexRow[] {
  return db
    .prepare(`PRAGMA index_list(${name})`)
    .all() as unknown as IndexRow[];
}

function indexInfo(name: string): IndexInfoRow[] {
  return db
    .prepare(`PRAGMA index_info(${name})`)
    .all() as unknown as IndexInfoRow[];
}

function foreignKeyList(name: string): ForeignKeyRow[] {
  return db
    .prepare(`PRAGMA foreign_key_list(${name})`)
    .all() as unknown as ForeignKeyRow[];
}

function columnNames(name: string): string[] {
  return tableInfo(name).map((c) => c.name);
}

function indexColumnNames(idxName: string): string[] {
  return indexInfo(idxName)
    .sort((a, b) => a.seqno - b.seqno)
    .map((i) => i.name);
}

function allTables(): string[] {
  return (db.prepare(`PRAGMA table_list`).all() as unknown as TableListRow[])
    .filter(
      (t) =>
        t.schema === "main" &&
        !t.name.startsWith("sqlite_") &&
        !t.name.startsWith("__drizzle"),
    )
    .map((t) => t.name)
    .sort();
}

function allUserIndexes(): string[] {
  // origin = 'c' (CREATE INDEX) or 'u' (UNIQUE). Exclude 'pk' (auto from
  // PRIMARY KEY) and sqlite-internal auto-indexes which surface with the
  // `sqlite_autoindex_*` name prefix.
  const tables = allTables();
  const names: string[] = [];
  for (const t of tables) {
    for (const idx of indexList(t)) {
      if (idx.name.startsWith("sqlite_autoindex_")) continue;
      names.push(idx.name);
    }
  }
  return names.sort();
}

// ---------------------------------------------------------------------------
// 1. Table presence / absence
// ---------------------------------------------------------------------------
describe("table presence", () => {
  const EXPECTED_PRESENT = [
    "users",
    "sessions",
    "scan_orders",
    "scans",
    "scan_events",
    "findings",
    "deep_inquiries",
    "evidence_artifacts",
    "reports",
    "pending_signups",
    "audit_log",
    "vps_instances",
    "jobs",
    // 0011 — webhook idempotency table.
    "webhook_dedup",
  ] as const;

  const EXPECTED_ABSENT = [
    "auth_proofs",
    "targets",
    "projects",
    "magic_link_tokens",
  ] as const;

  test("14 expected tables exist (13 from 0010 + webhook_dedup from 0011)", () => {
    const tables = allTables();
    for (const expected of EXPECTED_PRESENT) {
      expect(tables).toContain(expected);
    }
  });

  test("legacy tables dropped by 0010", () => {
    const tables = allTables();
    for (const dropped of EXPECTED_ABSENT) {
      expect(tables).not.toContain(dropped);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Per-table column shape (8 critical tables)
// ---------------------------------------------------------------------------
describe("column shape", () => {
  test("users has telegram + free-quota columns", () => {
    const cols = columnNames("users").sort();
    expect(cols).toEqual(
      [
        "id",
        "email",
        "created_at",
        "free_quick_consumed_at",
        "free_quick_consumed_count",
        "telegram_user_id",
        "telegram_username",
      ].sort(),
    );
    const info = tableInfo("users");
    // telegram_user_id INTEGER, nullable
    const tgUid = info.find((c) => c.name === "telegram_user_id");
    expect(tgUid?.type.toUpperCase()).toBe("INTEGER");
    expect(tgUid?.notnull).toBe(0);
    // telegram_username TEXT, nullable
    const tgUname = info.find((c) => c.name === "telegram_username");
    expect(tgUname?.type.toUpperCase()).toBe("TEXT");
    expect(tgUname?.notnull).toBe(0);
    // free_quick_consumed_at INTEGER, nullable
    const fqAt = info.find((c) => c.name === "free_quick_consumed_at");
    expect(fqAt?.type.toUpperCase()).toBe("INTEGER");
    expect(fqAt?.notnull).toBe(0);
    // free_quick_consumed_count INTEGER NOT NULL DEFAULT 0
    const fqCount = info.find((c) => c.name === "free_quick_consumed_count");
    expect(fqCount?.type.toUpperCase()).toBe("INTEGER");
    expect(fqCount?.notnull).toBe(1);
    expect(fqCount?.dflt_value).toBe("0");
  });

  test("scan_orders 21-column shape", () => {
    const cols = columnNames("scan_orders").sort();
    expect(cols).toEqual(
      [
        "id",
        "user_id",
        "status",
        "tier",
        "primary_domain",
        "attack_surface_json",
        "safety_rps",
        "dns_verify_token",
        "dns_verify_requested_at",
        "dns_verified_at",
        "dns_check_attempts",
        "vps_instance_id",
        "vps_provider",
        "vps_zone",
        "scan_id",
        "failure_reason",
        "cancelled_at",
        "payment_kind",
        "amount_kopecks",
        "created_at",
        "updated_at",
      ].sort(),
    );
    const info = tableInfo("scan_orders");
    expect(info.find((c) => c.name === "id")?.pk).toBe(1);
    expect(info.find((c) => c.name === "status")?.dflt_value).toBe("'draft'");
    expect(info.find((c) => c.name === "safety_rps")?.dflt_value).toBe("50");
    expect(info.find((c) => c.name === "attack_surface_json")?.dflt_value).toBe(
      "'[]'",
    );
  });

  test("scans rebuilt with scan_order_id (no target_id)", () => {
    const cols = columnNames("scans").sort();
    expect(cols).toEqual(
      [
        "id",
        "user_id",
        "scan_order_id",
        "profile",
        "status",
        "failure_reason",
        "started_at",
        "completed_at",
        "usage_tokens",
        "usage_usd_cents",
      ].sort(),
    );
    expect(cols).not.toContain("target_id");
  });

  test("findings full 18-column shape (E5)", () => {
    const cols = columnNames("findings").sort();
    expect(cols).toEqual(
      [
        "id",
        "scan_id",
        "external_id",
        "severity",
        "title",
        "target",
        "cvss_score",
        "cvss_vector",
        "cvss_version",
        "cwe_json",
        "mitre_json",
        "confidence",
        "phase",
        "agent",
        "body_md",
        "raw_yaml_json",
        "evidence_keys_json",
        "discovered_at",
        "created_at",
      ].sort(),
    );
    // dedup_key (from 0000 stub) MUST be gone
    expect(cols).not.toContain("dedup_key");
    expect(cols).not.toContain("evidence_json");
    const info = tableInfo("findings");
    expect(info.find((c) => c.name === "cvss_score")?.type.toUpperCase()).toBe(
      "REAL",
    );
    expect(info.find((c) => c.name === "cwe_json")?.dflt_value).toBe("'[]'");
  });

  test("deep_inquiries shape (E6)", () => {
    const cols = columnNames("deep_inquiries").sort();
    expect(cols).toEqual(
      [
        "id",
        "user_id",
        "company",
        "contact_name",
        "position",
        "email",
        "phone",
        "domains_text",
        "desired_date",
        "budget_band",
        "scope_text",
        "consent_accepted_at",
        "status",
        "telegram_sent_at",
        "telegram_send_attempts",
        "created_at",
        "updated_at",
      ].sort(),
    );
    expect(tableInfo("deep_inquiries").find((c) => c.name === "status")
      ?.dflt_value).toBe("'new'");
  });

  test("evidence_artifacts shape (E9)", () => {
    const cols = columnNames("evidence_artifacts").sort();
    expect(cols).toEqual(
      [
        "id",
        "scan_id",
        "bucket",
        "key",
        "size_bytes",
        "expires_at",
        "created_at",
      ].sort(),
    );
  });

  test("reports shape (E10)", () => {
    const cols = columnNames("reports").sort();
    expect(cols).toEqual(
      [
        "id",
        "scan_id",
        "status",
        "bucket",
        "key",
        "byte_size",
        "render_attempts",
        "last_error",
        "expires_at",
        "created_at",
        "updated_at",
      ].sort(),
    );
    const info = tableInfo("reports");
    expect(info.find((c) => c.name === "status")?.dflt_value).toBe("'pending'");
    expect(info.find((c) => c.name === "render_attempts")?.dflt_value).toBe(
      "0",
    );
  });

  test("pending_signups shape (telegram pivot)", () => {
    const cols = columnNames("pending_signups").sort();
    expect(cols).toEqual(
      [
        "id",
        "token",
        "telegram_username",
        "chat_id",
        "status",
        "created_at",
        "expires_at",
      ].sort(),
    );
    const info = tableInfo("pending_signups");
    expect(info.find((c) => c.name === "status")?.dflt_value).toBe(
      "'pending'",
    );
    expect(info.find((c) => c.name === "chat_id")?.type.toUpperCase()).toBe(
      "INTEGER",
    );
    expect(info.find((c) => c.name === "chat_id")?.notnull).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Indexes: count + spot-check
// ---------------------------------------------------------------------------
describe("indexes", () => {
  test("29 total user-defined indexes across all tables (27 from 0010 + 2 from 0011)", () => {
    const idxs = allUserIndexes();
    expect(idxs.length).toBe(29);
  });

  test("spot-check 6 critical indexes by name", () => {
    const all = new Set(allUserIndexes());
    const expected = [
      "scan_orders_user_created_idx",
      "scans_scan_order_id_idx",
      "findings_scan_severity_idx",
      "users_telegram_user_id_uq",
      "users_telegram_username_uq",
      "pending_signups_username_status_expires_idx",
    ] as const;
    for (const name of expected) {
      expect(all.has(name)).toBe(true);
    }
  });

  test("users.telegram_user_id index is UNIQUE", () => {
    const idx = indexList("users").find(
      (i) => i.name === "users_telegram_user_id_uq",
    );
    expect(idx?.unique).toBe(1);
    expect(indexColumnNames("users_telegram_user_id_uq")).toEqual([
      "telegram_user_id",
    ]);
  });

  test("users.telegram_username index is UNIQUE", () => {
    const idx = indexList("users").find(
      (i) => i.name === "users_telegram_username_uq",
    );
    expect(idx?.unique).toBe(1);
    expect(indexColumnNames("users_telegram_username_uq")).toEqual([
      "telegram_username",
    ]);
  });

  test("reports.scan_id UNIQUE (1:1 with scans)", () => {
    const idx = indexList("reports").find(
      (i) => i.name === "reports_scan_id_uq",
    );
    expect(idx?.unique).toBe(1);
  });

  test("pending_signups composite index columns ordered", () => {
    expect(
      indexColumnNames("pending_signups_username_status_expires_idx"),
    ).toEqual(["telegram_username", "status", "expires_at"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Foreign keys
// ---------------------------------------------------------------------------
describe("foreign keys", () => {
  test("scans.scan_order_id → scan_orders.id (cascade)", () => {
    const fks = foreignKeyList("scans");
    const fk = fks.find((f) => f.from === "scan_order_id");
    expect(fk?.table).toBe("scan_orders");
    expect(fk?.to).toBe("id");
    expect(fk?.on_delete.toUpperCase()).toBe("CASCADE");
  });

  test("scans.user_id → users.id (cascade)", () => {
    const fks = foreignKeyList("scans");
    expect(
      fks.some(
        (f) => f.from === "user_id" && f.table === "users" && f.to === "id",
      ),
    ).toBe(true);
  });

  test("findings.scan_id → scans.id (cascade)", () => {
    const fks = foreignKeyList("findings");
    const fk = fks.find((f) => f.from === "scan_id");
    expect(fk?.table).toBe("scans");
    expect(fk?.on_delete.toUpperCase()).toBe("CASCADE");
  });

  test("evidence_artifacts.scan_id → scans.id (cascade)", () => {
    const fks = foreignKeyList("evidence_artifacts");
    const fk = fks.find((f) => f.from === "scan_id");
    expect(fk?.table).toBe("scans");
    expect(fk?.on_delete.toUpperCase()).toBe("CASCADE");
  });

  test("reports.scan_id → scans.id (cascade)", () => {
    const fks = foreignKeyList("reports");
    const fk = fks.find((f) => f.from === "scan_id");
    expect(fk?.table).toBe("scans");
    expect(fk?.on_delete.toUpperCase()).toBe("CASCADE");
  });

  test("deep_inquiries.user_id → users.id (set null, not cascade)", () => {
    const fks = foreignKeyList("deep_inquiries");
    const fk = fks.find((f) => f.from === "user_id");
    expect(fk?.table).toBe("users");
    expect(fk?.on_delete.toUpperCase()).toBe("SET NULL");
  });

  test("pending_signups has NO foreign keys (pre-user row)", () => {
    expect(foreignKeyList("pending_signups").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. CHECK constraints — round-trip
// ---------------------------------------------------------------------------
describe("CHECK constraints", () => {
  // Helper: open an isolated `:memory:` DB so smoke inserts don't pollute the
  // shared `db` used by the other PRAGMA tests.
  function freshDb(): Database {
    const d = new Database(":memory:");
    d.exec(loadMigration("0000_init.sql"));
    d.exec(loadMigration("0010_blackbox_mvp.sql"));
    d.exec("PRAGMA foreign_keys = ON;");
    return d;
  }

  function seedScan(d: Database): { userId: string; scanId: string } {
    const userId = "u_test_001";
    const orderId = "o_test_001";
    const scanId = "s_test_001";
    const now = Date.now();
    d.prepare(
      `INSERT INTO users (id, email, created_at, free_quick_consumed_count)
       VALUES (?, ?, ?, 0)`,
    ).run(userId, "test@example.com", now);
    d.prepare(
      `INSERT INTO scan_orders (
         id, user_id, tier, primary_domain, dns_verify_token,
         created_at, updated_at
       ) VALUES (?, ?, 'quick', 'example.com', 'tok_dns', ?, ?)`,
    ).run(orderId, userId, now, now);
    d.prepare(
      `INSERT INTO scans (
         id, user_id, scan_order_id, profile, status, started_at
       ) VALUES (?, ?, ?, 'standard', 'running', ?)`,
    ).run(scanId, userId, orderId, now);
    return { userId, scanId };
  }

  test("findings.severity rejects unknown value", () => {
    const d = freshDb();
    const { scanId } = seedScan(d);
    const now = Date.now();
    expect(() =>
      d
        .prepare(
          `INSERT INTO findings (
             id, scan_id, external_id, severity, title, target,
             body_md, raw_yaml_json, created_at
           ) VALUES (?, ?, ?, 'bogus', ?, ?, ?, ?, ?)`,
        )
        .run(
          "f_bad",
          scanId,
          "ext-1",
          "Bad severity",
          "https://example.com",
          "# body",
          "{}",
          now,
        ),
    ).toThrow();
    d.close();
  });

  test("findings.severity accepts known values", () => {
    const d = freshDb();
    const { scanId } = seedScan(d);
    const now = Date.now();
    const insertOne = (id: string, sev: string): void => {
      d.prepare(
        `INSERT INTO findings (
           id, scan_id, external_id, severity, title, target,
           body_md, raw_yaml_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        scanId,
        `ext-${id}`,
        sev,
        `t-${id}`,
        "https://example.com",
        "# body",
        "{}",
        now,
      );
    };
    for (const sev of [
      "critical",
      "high",
      "medium",
      "low",
      "informational",
    ]) {
      expect(() => insertOne(`f_${sev}`, sev)).not.toThrow();
    }
    d.close();
  });

  test("scan_orders.tier rejects unknown value", () => {
    const d = freshDb();
    const userId = "u_tier_test";
    const now = Date.now();
    d.prepare(
      `INSERT INTO users (id, email, created_at, free_quick_consumed_count)
       VALUES (?, ?, ?, 0)`,
    ).run(userId, "tier@example.com", now);
    expect(() =>
      d
        .prepare(
          `INSERT INTO scan_orders (
             id, user_id, tier, primary_domain, dns_verify_token,
             created_at, updated_at
           ) VALUES (?, ?, 'ultra', 'example.com', 'tok', ?, ?)`,
        )
        .run("o_bad_tier", userId, now, now),
    ).toThrow();
    d.close();
  });

  test("scan_orders.safety_rps rejects out-of-range", () => {
    const d = freshDb();
    const userId = "u_rps_test";
    const now = Date.now();
    d.prepare(
      `INSERT INTO users (id, email, created_at, free_quick_consumed_count)
       VALUES (?, ?, ?, 0)`,
    ).run(userId, "rps@example.com", now);
    expect(() =>
      d
        .prepare(
          `INSERT INTO scan_orders (
             id, user_id, tier, primary_domain, dns_verify_token, safety_rps,
             created_at, updated_at
           ) VALUES (?, ?, 'quick', 'example.com', 'tok', 9999, ?, ?)`,
        )
        .run("o_bad_rps", userId, now, now),
    ).toThrow();
    d.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Smoke insert chain — full E1→E10 happy path
// ---------------------------------------------------------------------------
describe("smoke insert chain", () => {
  test("full chain: user → scan_order → scan → scan_event → finding → deep_inquiry → evidence → report", () => {
    const d = new Database(":memory:");
    d.exec(loadMigration("0000_init.sql"));
    d.exec(loadMigration("0010_blackbox_mvp.sql"));
    d.exec("PRAGMA foreign_keys = ON;");

    const now = Date.now();
    const userId = "u_smoke_1";
    const orderId = "o_smoke_1";
    const scanId = "s_smoke_1";
    const eventId = "e_smoke_1";
    const findingId = "f_smoke_1";
    const inquiryId = "i_smoke_1";
    const evidenceId = "ev_smoke_1";
    const reportId = "r_smoke_1";

    // 1. user (with telegram pivot fields)
    d.prepare(
      `INSERT INTO users (
         id, email, created_at, free_quick_consumed_count,
         telegram_user_id, telegram_username
       ) VALUES (?, ?, ?, 0, ?, ?)`,
    ).run(userId, "smoke@example.com", now, 123456789, "smoketest");

    // 2. scan_order
    d.prepare(
      `INSERT INTO scan_orders (
         id, user_id, tier, primary_domain, dns_verify_token,
         created_at, updated_at
       ) VALUES (?, ?, 'quick', 'example.com', 'dns_token_abc', ?, ?)`,
    ).run(orderId, userId, now, now);

    // 3. scan
    d.prepare(
      `INSERT INTO scans (
         id, user_id, scan_order_id, profile, status, started_at
       ) VALUES (?, ?, ?, 'standard', 'running', ?)`,
    ).run(scanId, userId, orderId, now);

    // 4. scan_event
    d.prepare(
      `INSERT INTO scan_events (
         id, scan_id, event_type, payload_json, created_at
       ) VALUES (?, ?, 'agent_started', '{}', ?)`,
    ).run(eventId, scanId, now);

    // 5. finding (good severity)
    d.prepare(
      `INSERT INTO findings (
         id, scan_id, external_id, severity, title, target,
         body_md, raw_yaml_json, created_at
       ) VALUES (?, ?, ?, 'high', ?, ?, ?, ?, ?)`,
    ).run(
      findingId,
      scanId,
      "ext-smoke-1",
      "SQLi on /search",
      "https://example.com/search",
      "# Body",
      "{}",
      now,
    );

    // 6. deep_inquiry (lead-gen — linked to user via SET NULL FK)
    d.prepare(
      `INSERT INTO deep_inquiries (
         id, user_id, company, contact_name, email, phone,
         domains_text, scope_text, consent_accepted_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      inquiryId,
      userId,
      "Acme Corp",
      "Jane Doe",
      "jane@acme.example",
      "+10000000000",
      "acme.example",
      "external + internal infra",
      now,
      now,
      now,
    );

    // 7. evidence_artifact
    d.prepare(
      `INSERT INTO evidence_artifacts (
         id, scan_id, bucket, key, size_bytes, expires_at, created_at
       ) VALUES (?, ?, 'evidence', 'scans/s_smoke_1/ev1.json', 1024, ?, ?)`,
    ).run(evidenceId, scanId, now + 30 * 86_400_000, now);

    // 8. report (UNIQUE scan_id — must succeed exactly once)
    d.prepare(
      `INSERT INTO reports (
         id, scan_id, status, created_at, updated_at
       ) VALUES (?, ?, 'pending', ?, ?)`,
    ).run(reportId, scanId, now, now);

    // Verify counts via SELECT — proves both writes and reads work.
    const userCount = d
      .prepare(`SELECT COUNT(*) as c FROM users WHERE id = ?`)
      .get(userId) as { c: number };
    expect(userCount.c).toBe(1);

    const findingCount = d
      .prepare(`SELECT COUNT(*) as c FROM findings WHERE scan_id = ?`)
      .get(scanId) as { c: number };
    expect(findingCount.c).toBe(1);

    // Second report for same scan must violate UNIQUE(scan_id)
    expect(() =>
      d
        .prepare(
          `INSERT INTO reports (
             id, scan_id, status, created_at, updated_at
           ) VALUES (?, ?, 'pending', ?, ?)`,
        )
        .run("r_dup", scanId, now, now),
    ).toThrow();

    d.close();
  });

  test("pending_signups chain (no user yet — pivot pre-account row)", () => {
    const d = new Database(":memory:");
    d.exec(loadMigration("0000_init.sql"));
    d.exec(loadMigration("0010_blackbox_mvp.sql"));
    d.exec("PRAGMA foreign_keys = ON;");

    const now = Date.now();
    d.prepare(
      `INSERT INTO pending_signups (
         id, token, telegram_username, chat_id, status, created_at, expires_at
       ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).run("ps_1", "tok_abc_xyz", "alice", 999, now, now + 600_000);

    // Token UNIQUE — second insert with same token must throw.
    expect(() =>
      d
        .prepare(
          `INSERT INTO pending_signups (
             id, token, telegram_username, status, created_at, expires_at
           ) VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .run("ps_2", "tok_abc_xyz", "bob", now, now + 600_000),
    ).toThrow();

    // status rejects unknown value
    expect(() =>
      d
        .prepare(
          `INSERT INTO pending_signups (
             id, token, telegram_username, status, created_at, expires_at
           ) VALUES (?, ?, ?, 'bogus', ?, ?)`,
        )
        .run("ps_3", "tok_other", "carol", now, now + 600_000),
    ).toThrow();

    d.close();
  });
});

// ---------------------------------------------------------------------------
// 7. Migration 0011 — webhook_dedup table contract
// ---------------------------------------------------------------------------
describe("migration 0011_webhook_dedup", () => {
  function freshDbWith0011(): Database {
    const d = new Database(":memory:");
    d.exec(loadMigration("0000_init.sql"));
    d.exec(loadMigration("0010_blackbox_mvp.sql"));
    d.exec(loadMigration("0011_webhook_dedup.sql"));
    d.exec("PRAGMA foreign_keys = ON;");
    return d;
  }

  test("webhook_dedup table present after 0011 applied", () => {
    expect(allTables()).toContain("webhook_dedup");
  });

  test("webhook_dedup column shape", () => {
    const cols = columnNames("webhook_dedup").sort();
    expect(cols).toEqual(
      [
        "id",
        "webhook_kind",
        "dedup_key",
        "received_at",
        "metadata_json",
      ].sort(),
    );
    const info = tableInfo("webhook_dedup");
    expect(info.find((c) => c.name === "id")?.pk).toBe(1);
    expect(info.find((c) => c.name === "webhook_kind")?.notnull).toBe(1);
    expect(info.find((c) => c.name === "dedup_key")?.notnull).toBe(1);
    expect(info.find((c) => c.name === "received_at")?.notnull).toBe(1);
    // metadata_json is nullable diag column
    expect(info.find((c) => c.name === "metadata_json")?.notnull).toBe(0);
  });

  test("UNIQUE(webhook_kind, dedup_key) index exists with correct columns", () => {
    const idx = indexList("webhook_dedup").find(
      (i) => i.name === "uniq_webhook_dedup_kind_key",
    );
    expect(idx?.unique).toBe(1);
    expect(indexColumnNames("uniq_webhook_dedup_kind_key")).toEqual([
      "webhook_kind",
      "dedup_key",
    ]);
  });

  test("kind+received_at composite index exists", () => {
    const idx = indexList("webhook_dedup").find(
      (i) => i.name === "idx_webhook_dedup_kind_received_at",
    );
    expect(idx).toBeDefined();
    // First column is webhook_kind (PRAGMA index_info exposes them in
    // declaration order); DESC ordering on received_at is honoured by the
    // SQL but not surfaced via PRAGMA — column presence is the contract.
    expect(indexColumnNames("idx_webhook_dedup_kind_received_at")).toEqual([
      "webhook_kind",
      "received_at",
    ]);
  });

  test("UNIQUE collision: same (kind, key) twice → throw on second insert", () => {
    const d = freshDbWith0011();
    const now = Date.now();
    const stmt = d.prepare(
      `INSERT INTO webhook_dedup
         (id, webhook_kind, dedup_key, received_at, metadata_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    expect(() =>
      stmt.run("d_1", "scan_complete", "order_abc", now, null),
    ).not.toThrow();
    expect(() =>
      stmt.run("d_2", "scan_complete", "order_abc", now + 1, null),
    ).toThrow();
    // Different kind OR different key — both should succeed.
    expect(() =>
      stmt.run("d_3", "scan_complete", "order_xyz", now, null),
    ).not.toThrow();
    expect(() =>
      stmt.run("d_4", "other_kind", "order_abc", now, null),
    ).not.toThrow();
    d.close();
  });
});
