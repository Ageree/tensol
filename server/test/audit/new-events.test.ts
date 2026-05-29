/**
 * T015 — new-events chain test for Blackbox MVP audit event-types.
 *
 * Pins down three guarantees over the 29 new event-type literals enumerated
 * in `specs/002-blackbox-mvp/data-model.md` §E8:
 *
 *   1. `BLACKBOX_AUDIT_EVENTS` exported from `audit/emit.ts` contains
 *      exactly the 29 literals (no drift between code and spec).
 *   2. Each literal can be emitted as a free-form `event` via
 *      `emitSignedAudit` and produces a row whose `signature` chains
 *      correctly off the prior row. After 29 emits the chain length is 29
 *      and `verifyChain` returns ok.
 *   3. The 13-field signed-message shape is unchanged — every persisted
 *      row exposes `prev_signature`, `signature`, `metadata_json`, and the
 *      11 identity/outcome columns the signer expects.
 *
 * Reconciliation with the brief: T014 brief mentions "28 new event-type
 * literals". The actual count in data-model.md §E8 (commit ddee1b3) is
 * **29** — counted via `grep -oE '\`[a-z_]+\`' | sort -u | wc -l`. We track
 * the spec, not the brief; if §E8 ever drops to 28 this test will fail
 * loudly at `EXPECTED_NEW_EVENTS.length`.
 *
 * Setup mirrors `audit/emit.test.ts` + `audit/verify-chain.test.ts`:
 * ad-hoc `:memory:` DB via `createDb`, raw bun:sqlite handle to apply the
 * bundled migration SQL (0000_init.sql then 0010_blackbox_mvp.sql per T013).
 */
import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { asc } from "drizzle-orm";
import { createDb, type DB } from "../../src/db/client.ts";
import { auditLog } from "../../src/db/schema.ts";
import {
  emitSignedAudit,
  BLACKBOX_AUDIT_EVENTS,
  type BlackboxAuditEvent,
} from "../../src/audit/emit.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-new-events";

/** The 38 literals from data-model.md §E8 + feature 004 additions, copied
 *  verbatim. Source-of-truth duplication is deliberate: if
 *  `BLACKBOX_AUDIT_EVENTS` drifts from the spec, the equality assertion
 *  below catches it. (29 blackbox-mvp events + 9 sthrip PR-review events) */
const EXPECTED_NEW_EVENTS: readonly BlackboxAuditEvent[] = [
  "scan_order_created",
  "scan_order_attack_surface_updated",
  "scan_order_safety_updated",
  "dns_verify_requested",
  "dns_verified",
  "dns_verify_failed",
  "free_quota_consumed",
  "free_quota_refunded",
  "scan_order_launched",
  "vm_provisioning",
  "vm_ready",
  "scan_started",
  "finding_ingested",
  "scan_completed",
  "scan_failed",
  "vm_teardown",
  "pdf_render_requested",
  "pdf_rendered",
  "pdf_render_failed",
  "email_send_requested",
  "email_sent",
  "email_send_failed",
  "scan_cancelled",
  "inquiry_received",
  "inquiry_telegram_sent",
  "inquiry_telegram_failed",
  "inquiry_status_changed",
  "webhook_invalid_signature",
  "webhook_received",
  // 004-sthrip PR-review (9)
  "github_app_installed",
  "github_app_uninstalled",
  "github_app_suspended",
  "review_repo_enabled",
  "review_repo_disabled",
  "review_settings_changed",
  "review_finding_verified",
  "review_thread_resolved",
  "review_category_suppressed",
] as const;

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

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
  applyMigrations(db);
});

// ---------------------------------------------------------------------------
// Test 1 — `BLACKBOX_AUDIT_EVENTS` matches the spec list exactly.
// ---------------------------------------------------------------------------
test("BLACKBOX_AUDIT_EVENTS exposes the 38 literals from data-model §E8 + feature 004", () => {
  // Length first — surfaces a "you added or removed an event" drift loudly
  // before the set-equality assertion buries it.
  // 29 blackbox-mvp events + 9 sthrip PR-review events = 38 total
  expect(BLACKBOX_AUDIT_EVENTS.length).toBe(EXPECTED_NEW_EVENTS.length);
  expect(EXPECTED_NEW_EVENTS.length).toBe(38);

  // Set-equality regardless of ordering — the union is order-insensitive at
  // the TypeScript level so we compare as sets.
  const codeSet = new Set<string>(BLACKBOX_AUDIT_EVENTS);
  const specSet = new Set<string>(EXPECTED_NEW_EVENTS);
  expect(codeSet).toEqual(specSet);
});

// ---------------------------------------------------------------------------
// Test 2 — emit one row per literal, chain extends, verifyChain ok.
// ---------------------------------------------------------------------------
test("emit one row per new event-type → chain extends, verifyChain ok", async () => {
  // Emit one row per literal in declared order. Fixed `ts` per row so the
  // canonical message is reproducible across CI runs.
  for (let i = 0; i < EXPECTED_NEW_EVENTS.length; i++) {
    const ev = EXPECTED_NEW_EVENTS[i]!;
    const res = await emitSignedAudit(
      db,
      {
        event: ev,
        outcome: "success",
        ts: 1_700_000_000_000 + i * 1000,
        metadata: { idx: i, kind: "blackbox-mvp" },
      },
      { key: KEY },
    );
    // Autoincrement id should equal i+1 since we started on a fresh DB.
    expect(res.id).toBe(i + 1);
    expect(typeof res.signature).toBe("string");
    expect(res.signature.length).toBe(64); // hex sha256
  }

  // Read all 29 rows ordered by id and assert event names match in order.
  const rows = db.select().from(auditLog).orderBy(asc(auditLog.id)).all();
  expect(rows.length).toBe(EXPECTED_NEW_EVENTS.length);
  for (let i = 0; i < rows.length; i++) {
    expect(rows[i]!.event).toBe(EXPECTED_NEW_EVENTS[i]!);
  }

  // The whole chain must verify byte-perfectly.
  const result = verifyChain(db, KEY);
  expect(result.ok).toBe(true);
  expect(result.rows).toBe(EXPECTED_NEW_EVENTS.length);
  expect(result.brokenAt).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Test 3 — 13-field signed-message shape unchanged (spot-check 2 rows).
// ---------------------------------------------------------------------------
test("signed-message shape unchanged: 13 fields per row, populated as expected", async () => {
  // Emit just two rows so we can spot-check both the "first row in chain"
  // (prev_signature = "") and a "linked row" (prev_signature = prior sig)
  // cases without re-running the full 29-row sweep.
  await emitSignedAudit(
    db,
    {
      event: "scan_order_created",
      outcome: "success",
      ts: 1_700_000_000_000,
      user_id: "u_test_0001",
      project_id: "p_test_0001",
      metadata: { foo: "bar" },
    },
    { key: KEY },
  );
  await emitSignedAudit(
    db,
    {
      event: "dns_verified",
      outcome: "success",
      ts: 1_700_000_001_000,
      target_id: "t_test_0001",
      metadata: {},
    },
    { key: KEY },
  );

  const rows = db.select().from(auditLog).orderBy(asc(auditLog.id)).all();
  expect(rows.length).toBe(2);

  const [first, second] = rows;
  // First row: prev_signature is empty string per emit.ts convention (we
  // sign null but persist "" — this is the v2 chain convention).
  expect(first!.prevSignature).toBe("");
  expect(first!.signature.length).toBe(64);
  expect(first!.metadataJson).toBe('{"foo":"bar"}');
  expect(first!.outcome).toBe("success");
  expect(first!.userId).toBe("u_test_0001");
  expect(first!.projectId).toBe("p_test_0001");

  // Second row: prev_signature equals first row's signature → chain link.
  expect(second!.prevSignature).toBe(first!.signature);
  expect(second!.signature.length).toBe(64);
  expect(second!.metadataJson).toBe("{}");
  expect(second!.targetId).toBe("t_test_0001");
});

// ---------------------------------------------------------------------------
// Test 4 — BlackboxAuditEvent union is a strict subset of `string` (no
// runtime constraint on `EmitArgs.event` per Constitution X — the 13-field
// shape is frozen, free-form `event` is allowed for 001-compat with literals
// like `auth_login_succeeded`, `target_created`, etc.). Verify a "bogus"
// event still emits but is NOT a member of the typed union.
// ---------------------------------------------------------------------------
test("bogus event-type emits at runtime (free-form `event` is intentional) but is not a BlackboxAuditEvent", async () => {
  // Runtime: bogus events DO emit (Constitution X freezes the signed-message
  // shape, NOT the event-type enum — there's no CHECK constraint on
  // `audit_log.event`). This preserves backward-compat with feature 001
  // literals like `auth_login_succeeded`.
  const res = await emitSignedAudit(
    db,
    {
      event: "fake.event",
      outcome: "success",
      ts: 1_700_000_000_000,
      metadata: {},
    },
    { key: KEY },
  );
  expect(res.id).toBe(1);
  expect(res.signature.length).toBe(64);

  // TypeScript-level: `"fake.event"` is NOT assignable to
  // `BlackboxAuditEvent`. We assert this via the typed `includes` check:
  // the union narrows the array's `includes` argument, so passing a string
  // literal not in the union would be a compile error if `as` were dropped.
  // The runtime test below confirms membership semantics.
  const blackboxSet = new Set<string>(BLACKBOX_AUDIT_EVENTS);
  expect(blackboxSet.has("fake.event")).toBe(false);
  expect(blackboxSet.has("scan_order_created")).toBe(true);
});
