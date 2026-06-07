/**
 * T065 — Integration test for `scan_timeout_watcher` periodic handler (T064).
 *
 * What this pins down (per task brief + spec FR-022):
 *   1. HAPPY PATH — one scan with status='running' and started_at older than
 *      90 minutes is detected. The watcher:
 *        - flips `scans.status` to `failed` with `failure_reason='scan_timeout'`
 *        - flips `scan_orders.status` to `failed` with the same reason
 *        - refunds the user's free-tier quota
 *        - enqueues a `teardown_scan_vm` job (via existing CloudProvider
 *          teardown infrastructure) carrying the scan_order's
 *          `vps_instance_id` + `vps_zone`
 *        - emits a `scan_failed` signed-audit row with
 *          `metadata.reason='scan_timeout'`
 *        - emits a `free_quota_refunded` signed-audit row
 *      Returns `{ processed: 1 }`.
 *
 *   2. MULTIPLE TIMED-OUT SCANS — 3 expired scans → all 3 processed, 3
 *      teardown jobs enqueued, 3 scan_failed audits emitted.
 *
 *   3. WITHIN TIMEOUT WINDOW — a scan started 30 min ago is left alone:
 *      no state mutation, no jobs, no audit. Returns `{ processed: 0 }`.
 *
 *   4. NO RUNNING SCANS — empty database (or all completed/cancelled/failed):
 *      `{ processed: 0 }`; no audit rows; no jobs.
 *
 *   5. ALREADY-FAILED SCAN — even if its started_at is older than 90 min,
 *      a scan in status='failed' is skipped (the WHERE clause filters on
 *      status='running' only).
 *
 *   6. COMPLETED SCAN — same as above for status='completed'.
 *
 *   7. IDEMPOTENCY — running tick() twice in a row processes the timeouts
 *      on the first pass, then yields `{ processed: 0 }` on the second
 *      pass because the rows are no longer in status='running'. No
 *      duplicate audits, no duplicate jobs.
 *
 * Why `scan_failed` (not `scan_timeout`):
 *   BLACKBOX_AUDIT_EVENTS in audit/emit.ts:72-114 does NOT contain
 *   `scan_timeout`. Same substitution rationale as spawn-scan-vm.ts:
 *   we carry the discriminator in `metadata.reason='scan_timeout'`.
 *
 * Why `teardown_scan_vm` is enqueued (not invoked directly):
 *   Teardown is an out-of-band side effect that can take minutes (GCP
 *   long-running ops, polling). The watcher must remain fast and atomic
 *   per its 5-minute tick cadence. Enqueueing matches the pattern used
 *   by scan-orders/service.cancelOrder (T036).
 *
 * Migrations: bundles all `*.sql` files in server/migrations/ in lex order
 * (mirrors the spawn-scan-vm.test.ts and teardown-scan-vm.test.ts
 * harness for parity).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  auditLog,
  jobs,
  scanOrders,
  scans,
  users,
} from "../../src/db/schema.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { refundFreeQuickQuota } from "../../src/free-tier/service.ts";
import { createScanTimeoutWatcher } from "../../src/jobs/handlers/scan-timeout-watcher.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
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

const TEST_AUDIT_KEY = "test-audit-signing-key-scan-timeout-watcher";

const NINETY_MIN_MS = 90 * 60 * 1000;
const NOW = 1_700_000_000_000;
const DOMAIN = "example.test";

interface SeedOpts {
  userId: string;
  orderId: string;
  scanId: string;
  startedAt: number;
  scanStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
  orderStatus?:
    | "draft"
    | "dns_pending"
    | "dns_verified"
    | "vm_provisioning"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  vpsInstanceId?: string;
  vpsZone?: string;
  consumeQuota?: boolean;
}

/**
 * Seed a user + scan_order + scan triple. Defaults reflect a happy-path
 * "running scan" — status='running' on both rows, VPS attached, free-tier
 * quota consumed.
 */
function seedRunningScan(db: DB, opts: SeedOpts, now: number): void {
  const {
    userId,
    orderId,
    scanId,
    startedAt,
    scanStatus = "running",
    orderStatus = "running",
    vpsInstanceId = `fake-vm-${scanId}`,
    vpsZone = "ru-central1-a",
    consumeQuota = true,
  } = opts;

  db.insert(users)
    .values({
      id: userId,
      email: `${userId}@x.test`,
      createdAt: now - 24 * 60 * 60 * 1000,
      freeQuickConsumedAt: consumeQuota ? startedAt : null,
      freeQuickConsumedCount: consumeQuota ? 1 : 0,
    })
    .run();

  db.insert(scanOrders)
    .values({
      id: orderId,
      userId,
      status: orderStatus,
      tier: "quick",
      primaryDomain: DOMAIN,
      attackSurfaceJson: JSON.stringify([{ hostname: DOMAIN, included: true }]),
      safetyRps: 50,
      dnsVerifyToken: `tensol-verify-${"x".repeat(26)}`,
      dnsVerifiedAt: startedAt,
      dnsCheckAttempts: 1,
      vpsProvider: "gcp",
      vpsInstanceId,
      vpsZone,
      paymentKind: "free_quick",
      scanId,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    .run();

  db.insert(scans)
    .values({
      id: scanId,
      userId,
      scanOrderId: orderId,
      profile: "recon",
      status: scanStatus,
      startedAt,
    })
    .run();
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-scan-timeout-watcher-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1 — HAPPY PATH (one expired scan)
// ───────────────────────────────────────────────────────────────────────────
test("happy path: one expired scan → scan+order failed, quota refunded, teardown enqueued, scan_failed + free_quota_refunded audits", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const startedAt = NOW - NINETY_MIN_MS - 10 * 60 * 1000; // 100 min ago
  seedRunningScan(
    db,
    {
      userId: "01H0USER000000000000000001",
      orderId: "01H0ORD0000000000000000001",
      scanId: "01H0SCAN000000000000000001",
      startedAt,
      vpsInstanceId: "fake-vm-expired-1",
      vpsZone: "ru-central1-a",
    },
    NOW,
  );

  const watcher = createScanTimeoutWatcher({
    db,
    refundFreeQuickQuota: (uid) => refundFreeQuickQuota(db, uid),
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await watcher.tick();
  expect(res.processed).toBe(1);

  // scan flipped to failed.
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, "01H0SCAN000000000000000001"))
    .get();
  expect(scanRow!.status).toBe("failed");
  expect(scanRow!.failureReason).toBe("scan_timeout");
  expect(scanRow!.completedAt).toBe(NOW);

  // scan_order flipped to failed.
  const orderRow = db
    .select()
    .from(scanOrders)
    .where(eq(scanOrders.id, "01H0ORD0000000000000000001"))
    .get();
  expect(orderRow!.status).toBe("failed");
  expect(orderRow!.failureReason).toBe("scan_timeout");

  // Free-tier quota refunded.
  const userAfter = db
    .select()
    .from(users)
    .where(eq(users.id, "01H0USER000000000000000001"))
    .get();
  expect(userAfter!.freeQuickConsumedAt).toBeNull();
  expect(userAfter!.freeQuickConsumedCount).toBe(0);

  // teardown_scan_vm job enqueued with vps_instance_id + vps_zone.
  const teardownJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "teardown_scan_vm"))
    .all();
  expect(teardownJobs).toHaveLength(1);
  expect(teardownJobs[0]!.status).toBe("pending");
  const teardownPayload = JSON.parse(teardownJobs[0]!.payloadJson) as Record<
    string,
    unknown
  >;
  expect(teardownPayload.scan_order_id).toBe("01H0ORD0000000000000000001");
  expect(teardownPayload.scan_id).toBe("01H0SCAN000000000000000001");
  expect(teardownPayload.vps_instance_id).toBe("fake-vm-expired-1");
  expect(teardownPayload.vps_zone).toBe("ru-central1-a");

  // scan_failed audit emitted, metadata.reason='scan_timeout'.
  const scanFailedAudit = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(scanFailedAudit).toHaveLength(1);
  expect(scanFailedAudit[0]!.outcome).toBe("failure");
  expect(scanFailedAudit[0]!.scanId).toBe("01H0SCAN000000000000000001");
  const failMeta = JSON.parse(
    scanFailedAudit[0]!.metadataJson,
  ) as Record<string, unknown>;
  expect(failMeta.reason).toBe("scan_timeout");
  expect(failMeta.scan_order_id).toBe("01H0ORD0000000000000000001");

  // free_quota_refunded audit emitted.
  const refundAudit = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "free_quota_refunded"))
    .all();
  expect(refundAudit).toHaveLength(1);
  expect(refundAudit[0]!.userId).toBe("01H0USER000000000000000001");

  // Audit chain still valid.
  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2 — MULTIPLE expired scans
// ───────────────────────────────────────────────────────────────────────────
test("multiple expired scans: 3 timed out → all 3 processed, 3 teardown jobs, 3 scan_failed audits", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const startedAt = NOW - NINETY_MIN_MS - 5 * 60 * 1000; // 95 min ago
  for (let i = 1; i <= 3; i++) {
    seedRunningScan(
      db,
      {
        userId: `01H0USER00000000000000000${i}`,
        orderId: `01H0ORD000000000000000000${i}`,
        scanId: `01H0SCAN00000000000000000${i}`,
        startedAt: startedAt - i * 60 * 1000,
        vpsInstanceId: `fake-vm-expired-${i}`,
      },
      NOW,
    );
  }

  const watcher = createScanTimeoutWatcher({
    db,
    refundFreeQuickQuota: (uid) => refundFreeQuickQuota(db, uid),
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await watcher.tick();
  expect(res.processed).toBe(3);

  const failed = db
    .select()
    .from(scans)
    .where(eq(scans.failureReason, "scan_timeout"))
    .all();
  expect(failed).toHaveLength(3);

  const teardownJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "teardown_scan_vm"))
    .all();
  expect(teardownJobs).toHaveLength(3);

  const scanFailedAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(scanFailedAudits).toHaveLength(3);

  const refundAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "free_quota_refunded"))
    .all();
  expect(refundAudits).toHaveLength(3);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3 — WITHIN timeout window (scan started 30 min ago — leave alone)
// ───────────────────────────────────────────────────────────────────────────
test("within timeout window: scan started 30 min ago is NOT processed", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const startedAt = NOW - 30 * 60 * 1000; // 30 min ago — well within 90 min
  seedRunningScan(
    db,
    {
      userId: "01H0USER000000000000000001",
      orderId: "01H0ORD0000000000000000001",
      scanId: "01H0SCAN000000000000000001",
      startedAt,
    },
    NOW,
  );

  const watcher = createScanTimeoutWatcher({
    db,
    refundFreeQuickQuota: (uid) => refundFreeQuickQuota(db, uid),
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await watcher.tick();
  expect(res.processed).toBe(0);

  // No state changes.
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, "01H0SCAN000000000000000001"))
    .get();
  expect(scanRow!.status).toBe("running");
  expect(scanRow!.failureReason).toBeNull();

  // No teardown jobs.
  const teardownJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "teardown_scan_vm"))
    .all();
  expect(teardownJobs).toHaveLength(0);

  // No audits.
  const audits = db.select().from(auditLog).all();
  expect(audits).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4 — NO running scans (empty DB)
// ───────────────────────────────────────────────────────────────────────────
test("no running scans: empty result, no audits, no jobs", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const watcher = createScanTimeoutWatcher({
    db,
    refundFreeQuickQuota: (uid) => refundFreeQuickQuota(db, uid),
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await watcher.tick();
  expect(res.processed).toBe(0);

  const audits = db.select().from(auditLog).all();
  expect(audits).toHaveLength(0);

  const allJobs = db.select().from(jobs).all();
  expect(allJobs).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5 — ALREADY-FAILED scan is skipped
// ───────────────────────────────────────────────────────────────────────────
test("already-failed scan: skipped even when started_at is older than 90 min", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const startedAt = NOW - NINETY_MIN_MS - 30 * 60 * 1000; // 120 min ago
  seedRunningScan(
    db,
    {
      userId: "01H0USER000000000000000001",
      orderId: "01H0ORD0000000000000000001",
      scanId: "01H0SCAN000000000000000001",
      startedAt,
      scanStatus: "failed",
      orderStatus: "failed",
    },
    NOW,
  );

  const watcher = createScanTimeoutWatcher({
    db,
    refundFreeQuickQuota: (uid) => refundFreeQuickQuota(db, uid),
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await watcher.tick();
  expect(res.processed).toBe(0);

  // No teardown enqueued for an already-failed scan.
  const teardownJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "teardown_scan_vm"))
    .all();
  expect(teardownJobs).toHaveLength(0);

  // No audits.
  const audits = db.select().from(auditLog).all();
  expect(audits).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 6 — COMPLETED scan is skipped
// ───────────────────────────────────────────────────────────────────────────
test("completed scan: skipped even when started_at is older than 90 min", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const startedAt = NOW - NINETY_MIN_MS - 5 * 60 * 1000; // 95 min ago
  seedRunningScan(
    db,
    {
      userId: "01H0USER000000000000000001",
      orderId: "01H0ORD0000000000000000001",
      scanId: "01H0SCAN000000000000000001",
      startedAt,
      scanStatus: "completed",
      orderStatus: "completed",
    },
    NOW,
  );

  const watcher = createScanTimeoutWatcher({
    db,
    refundFreeQuickQuota: (uid) => refundFreeQuickQuota(db, uid),
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await watcher.tick();
  expect(res.processed).toBe(0);

  const audits = db.select().from(auditLog).all();
  expect(audits).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 7 — IDEMPOTENCY (second tick is a no-op)
// ───────────────────────────────────────────────────────────────────────────
test("idempotency: running tick() twice processes once, then yields 0; no duplicate audits or jobs", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const startedAt = NOW - NINETY_MIN_MS - 10 * 60 * 1000; // 100 min ago
  seedRunningScan(
    db,
    {
      userId: "01H0USER000000000000000001",
      orderId: "01H0ORD0000000000000000001",
      scanId: "01H0SCAN000000000000000001",
      startedAt,
    },
    NOW,
  );

  const watcher = createScanTimeoutWatcher({
    db,
    refundFreeQuickQuota: (uid) => refundFreeQuickQuota(db, uid),
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res1 = await watcher.tick();
  expect(res1.processed).toBe(1);

  const res2 = await watcher.tick();
  expect(res2.processed).toBe(0);

  // Exactly 1 scan_failed audit (not 2).
  const scanFailedAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(scanFailedAudits).toHaveLength(1);

  // Exactly 1 free_quota_refunded audit (not 2).
  const refundAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "free_quota_refunded"))
    .all();
  expect(refundAudits).toHaveLength(1);

  // Exactly 1 teardown job (not 2).
  const teardownJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "teardown_scan_vm"))
    .all();
  expect(teardownJobs).toHaveLength(1);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 8 — MIXED population (expired + within-window + completed)
// ───────────────────────────────────────────────────────────────────────────
test("mixed population: only running+expired rows are processed", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  // 1 expired+running → should process.
  seedRunningScan(
    db,
    {
      userId: "01H0USER000000000000000001",
      orderId: "01H0ORD0000000000000000001",
      scanId: "01H0SCAN000000000000000001",
      startedAt: NOW - NINETY_MIN_MS - 5 * 60 * 1000,
    },
    NOW,
  );

  // 1 within-window+running → should NOT process.
  seedRunningScan(
    db,
    {
      userId: "01H0USER000000000000000002",
      orderId: "01H0ORD0000000000000000002",
      scanId: "01H0SCAN000000000000000002",
      startedAt: NOW - 10 * 60 * 1000, // 10 min ago
    },
    NOW,
  );

  // 1 expired+completed → should NOT process (wrong status).
  seedRunningScan(
    db,
    {
      userId: "01H0USER000000000000000003",
      orderId: "01H0ORD0000000000000000003",
      scanId: "01H0SCAN000000000000000003",
      startedAt: NOW - NINETY_MIN_MS - 60 * 60 * 1000, // 150 min ago
      scanStatus: "completed",
      orderStatus: "completed",
      consumeQuota: false,
    },
    NOW,
  );

  const watcher = createScanTimeoutWatcher({
    db,
    refundFreeQuickQuota: (uid) => refundFreeQuickQuota(db, uid),
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await watcher.tick();
  expect(res.processed).toBe(1);

  // Only scan 1 is failed; 2 stays running; 3 stays completed.
  const s1 = db.select().from(scans).where(eq(scans.id, "01H0SCAN000000000000000001")).get();
  expect(s1!.status).toBe("failed");
  const s2 = db.select().from(scans).where(eq(scans.id, "01H0SCAN000000000000000002")).get();
  expect(s2!.status).toBe("running");
  const s3 = db.select().from(scans).where(eq(scans.id, "01H0SCAN000000000000000003")).get();
  expect(s3!.status).toBe("completed");

  // Exactly 1 teardown job.
  const teardownJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "teardown_scan_vm"))
    .all();
  expect(teardownJobs).toHaveLength(1);
});
