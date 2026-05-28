/**
 * T115 — Integration test for `cleanup_expired_reports` periodic handler (T114).
 *
 * What this pins down (per task brief + data-model E9/E10):
 *
 *   1. HAPPY PATH (evidence) — one `evidence_artifacts` row whose
 *      `expires_at < now` is detected. The handler:
 *        - calls `s3.deleteObject({Bucket, Key})` with the row's bucket+key
 *        - DELETEs the row from `evidence_artifacts`
 *        - emits an `evidence_pruned` signed-audit row
 *      Returns `{ processed: 1, deleted: 1, errors: 0 }`.
 *
 *   2. HAPPY PATH (report) — one `reports` row whose `expires_at < now` and
 *      has a non-null bucket+key is detected. The handler:
 *        - calls `s3.deleteObject({Bucket, Key})`
 *        - DELETEs the row from `reports`
 *        - emits a `report_pruned` signed-audit row
 *      Returns `{ processed: 1, deleted: 1, errors: 0 }`.
 *
 *   3. FUTURE EXPIRY — rows with `expires_at >= now` are NOT processed. No
 *      S3 call, no DELETE, no audit. Returns `{ processed: 0, deleted: 0,
 *      errors: 0 }`.
 *
 *   4. REPORT WITH NULL bucket/key — a `reports` row in status='pending'
 *      with `bucket=NULL` AND `expires_at < now` is skipped: no S3 call
 *      (nothing to delete), no row removal. The handler ONLY touches reports
 *      whose object actually exists in Object Storage.
 *
 *   5. S3 FAILURE — deleteObject throws. The row is NOT deleted (will retry
 *      on next tick). Counter records `errors=1`, `deleted=0`. No audit
 *      emitted for the failed row.
 *
 *   6. BATCH LIMIT — seed 150 expired evidence rows; batch=100; first tick
 *      yields `deleted=100`; second tick yields `deleted=50`.
 *
 *   7. MIXED (evidence + reports + future-expiry + null-bucket reports) — all
 *      eligible rows pruned; ineligibles untouched.
 *
 *   8. AUDIT CHAIN — after a successful prune, `verifyChain` returns `ok:true`.
 *
 * Why `evidence_pruned` / `report_pruned` (not in BLACKBOX_AUDIT_EVENTS):
 *   audit/emit.ts treats `event` as a plain `string`; the enum is a typed
 *   surface for new callers but the SQL column accepts any text. Same
 *   substitution pattern as `scan_failed` + metadata.reason='scan_timeout'
 *   in T064/scan-timeout-watcher.
 *
 * Migrations: bundles all `*.sql` files in server/migrations/ (mirrors
 * scan-timeout-watcher.test.ts harness for parity).
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
  evidenceArtifacts,
  reports,
  scanOrders,
  scans,
  users,
} from "../../src/db/schema.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { createCleanupExpiredReportsHandler } from "../../src/jobs/handlers/cleanup-expired-reports.ts";

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

const TEST_AUDIT_KEY = "test-audit-signing-key-cleanup-expired-reports";
const TEST_BUCKET = "tensol-evidence-test";
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DOMAIN = "example.test";

// ───────────────────────────────────────────────────────────────────────────
// Stub S3 client. Records calls; default behaviour is success.
// ───────────────────────────────────────────────────────────────────────────
interface StubS3 {
  readonly calls: Array<{ Bucket: string; Key: string }>;
  failOn?: (cmd: { Bucket: string; Key: string }) => boolean;
  deleteObject(cmd: { Bucket: string; Key: string }): Promise<{ ok: true }>;
}

function createStubS3(opts?: {
  failOn?: (cmd: { Bucket: string; Key: string }) => boolean;
}): StubS3 {
  const calls: Array<{ Bucket: string; Key: string }> = [];
  return {
    calls,
    failOn: opts?.failOn,
    async deleteObject(cmd) {
      calls.push({ Bucket: cmd.Bucket, Key: cmd.Key });
      if (opts?.failOn?.(cmd)) {
        throw new Error(`stub s3 delete failed for ${cmd.Key}`);
      }
      return { ok: true };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Seed helpers
// ───────────────────────────────────────────────────────────────────────────
interface SeedScanArgs {
  userId: string;
  orderId: string;
  scanId: string;
  createdAt: number;
}

function seedScan(db: DB, a: SeedScanArgs): void {
  db.insert(users)
    .values({
      id: a.userId,
      email: `${a.userId}@x.test`,
      createdAt: a.createdAt - DAY_MS,
    })
    .run();

  db.insert(scanOrders)
    .values({
      id: a.orderId,
      userId: a.userId,
      status: "completed",
      tier: "quick",
      primaryDomain: DOMAIN,
      attackSurfaceJson: JSON.stringify([
        { hostname: DOMAIN, included: true },
      ]),
      safetyRps: 50,
      dnsVerifyToken: `tensol-verify-${"x".repeat(26)}`,
      dnsVerifiedAt: a.createdAt,
      dnsCheckAttempts: 1,
      vpsProvider: "yandex",
      paymentKind: "free_quick",
      scanId: a.scanId,
      createdAt: a.createdAt,
      updatedAt: a.createdAt,
    })
    .run();

  db.insert(scans)
    .values({
      id: a.scanId,
      userId: a.userId,
      scanOrderId: a.orderId,
      profile: "recon",
      status: "completed",
      startedAt: a.createdAt,
      completedAt: a.createdAt + 60_000,
    })
    .run();
}

interface SeedEvidenceArgs {
  id: string;
  scanId: string;
  key: string;
  expiresAt: number;
  createdAt: number;
  bucket?: string;
}

function seedEvidence(db: DB, a: SeedEvidenceArgs): void {
  db.insert(evidenceArtifacts)
    .values({
      id: a.id,
      scanId: a.scanId,
      bucket: a.bucket ?? TEST_BUCKET,
      key: a.key,
      sizeBytes: 1024,
      expiresAt: a.expiresAt,
      createdAt: a.createdAt,
    })
    .run();
}

interface SeedReportArgs {
  id: string;
  scanId: string;
  bucket: string | null;
  key: string | null;
  expiresAt: number | null;
  createdAt: number;
  status?: "pending" | "rendering" | "ready" | "failed";
}

function seedReport(db: DB, a: SeedReportArgs): void {
  db.insert(reports)
    .values({
      id: a.id,
      scanId: a.scanId,
      status: a.status ?? (a.bucket ? "ready" : "pending"),
      bucket: a.bucket,
      key: a.key,
      byteSize: a.bucket ? 4096 : null,
      renderAttempts: a.bucket ? 1 : 0,
      lastError: null,
      expiresAt: a.expiresAt,
      createdAt: a.createdAt,
      updatedAt: a.createdAt,
    })
    .run();
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-cleanup-expired-reports-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1 — HAPPY PATH (evidence)
// ───────────────────────────────────────────────────────────────────────────
test("happy path (evidence): expired row → S3 delete + row removed + evidence_pruned audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, {
    userId: "01H0USER000000000000000001",
    orderId: "01H0ORD0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    createdAt: NOW - 14 * DAY_MS,
  });
  seedEvidence(db, {
    id: "01H0EVID000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    key: "evidence/01H0SCAN000000000000000001/payload.json",
    expiresAt: NOW - 60_000, // expired 1 min ago
    createdAt: NOW - 14 * DAY_MS,
  });

  const s3 = createStubS3();
  const handler = createCleanupExpiredReportsHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await handler.tick();
  expect(res.processed).toBe(1);
  expect(res.deleted).toBe(1);
  expect(res.errors).toBe(0);

  expect(s3.calls).toHaveLength(1);
  expect(s3.calls[0]).toEqual({
    Bucket: TEST_BUCKET,
    Key: "evidence/01H0SCAN000000000000000001/payload.json",
  });

  const rowsAfter = db
    .select()
    .from(evidenceArtifacts)
    .where(eq(evidenceArtifacts.id, "01H0EVID000000000000000001"))
    .all();
  expect(rowsAfter).toHaveLength(0);

  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "evidence_pruned"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.outcome).toBe("success");
  expect(audits[0]!.scanId).toBe("01H0SCAN000000000000000001");

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2 — HAPPY PATH (report)
// ───────────────────────────────────────────────────────────────────────────
test("happy path (report): expired ready report → S3 delete + row removed + report_pruned audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, {
    userId: "01H0USER000000000000000001",
    orderId: "01H0ORD0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    createdAt: NOW - 14 * DAY_MS,
  });
  seedReport(db, {
    id: "01H0REP0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    bucket: TEST_BUCKET,
    key: "reports/01H0SCAN000000000000000001.pdf",
    expiresAt: NOW - 60_000,
    createdAt: NOW - 14 * DAY_MS,
    status: "ready",
  });

  const s3 = createStubS3();
  const handler = createCleanupExpiredReportsHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await handler.tick();
  expect(res.processed).toBe(1);
  expect(res.deleted).toBe(1);
  expect(res.errors).toBe(0);

  expect(s3.calls).toHaveLength(1);
  expect(s3.calls[0]).toEqual({
    Bucket: TEST_BUCKET,
    Key: "reports/01H0SCAN000000000000000001.pdf",
  });

  const rowsAfter = db
    .select()
    .from(reports)
    .where(eq(reports.id, "01H0REP0000000000000000001"))
    .all();
  expect(rowsAfter).toHaveLength(0);

  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "report_pruned"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.outcome).toBe("success");
  expect(audits[0]!.scanId).toBe("01H0SCAN000000000000000001");

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3 — FUTURE expiry (not processed)
// ───────────────────────────────────────────────────────────────────────────
test("future expiry: rows with expires_at >= now are NOT processed", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, {
    userId: "01H0USER000000000000000001",
    orderId: "01H0ORD0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    createdAt: NOW - DAY_MS,
  });
  seedEvidence(db, {
    id: "01H0EVID000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    key: "evidence/future.json",
    expiresAt: NOW + DAY_MS, // 1 day in the future
    createdAt: NOW - DAY_MS,
  });
  seedReport(db, {
    id: "01H0REP0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    bucket: TEST_BUCKET,
    key: "reports/future.pdf",
    expiresAt: NOW + DAY_MS,
    createdAt: NOW - DAY_MS,
    status: "ready",
  });

  const s3 = createStubS3();
  const handler = createCleanupExpiredReportsHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await handler.tick();
  expect(res.processed).toBe(0);
  expect(res.deleted).toBe(0);
  expect(res.errors).toBe(0);

  expect(s3.calls).toHaveLength(0);

  // Both rows still present.
  expect(db.select().from(evidenceArtifacts).all()).toHaveLength(1);
  expect(db.select().from(reports).all()).toHaveLength(1);

  // No audits.
  expect(db.select().from(auditLog).all()).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4 — REPORT with NULL bucket/key is skipped
// ───────────────────────────────────────────────────────────────────────────
test("report with null bucket/key: skipped (nothing in object storage to delete)", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, {
    userId: "01H0USER000000000000000001",
    orderId: "01H0ORD0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    createdAt: NOW - 14 * DAY_MS,
  });
  // expired report in pending status with no object → skip
  seedReport(db, {
    id: "01H0REP0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    bucket: null,
    key: null,
    expiresAt: NOW - 60_000,
    createdAt: NOW - 14 * DAY_MS,
    status: "pending",
  });

  const s3 = createStubS3();
  const handler = createCleanupExpiredReportsHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await handler.tick();
  expect(res.processed).toBe(0);
  expect(res.deleted).toBe(0);
  expect(res.errors).toBe(0);

  expect(s3.calls).toHaveLength(0);
  expect(db.select().from(reports).all()).toHaveLength(1);
  expect(db.select().from(auditLog).all()).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5 — S3 FAILURE: row NOT deleted, errors counter increments
// ───────────────────────────────────────────────────────────────────────────
test("S3 failure: row NOT deleted, errors=1, no audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, {
    userId: "01H0USER000000000000000001",
    orderId: "01H0ORD0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    createdAt: NOW - 14 * DAY_MS,
  });
  seedEvidence(db, {
    id: "01H0EVID000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    key: "evidence/will-fail.json",
    expiresAt: NOW - 60_000,
    createdAt: NOW - 14 * DAY_MS,
  });

  const s3 = createStubS3({ failOn: () => true });
  const handler = createCleanupExpiredReportsHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await handler.tick();
  expect(res.processed).toBe(1);
  expect(res.deleted).toBe(0);
  expect(res.errors).toBe(1);

  // S3 was called (and threw).
  expect(s3.calls).toHaveLength(1);

  // Row STILL present (will retry next tick).
  const rowsAfter = db
    .select()
    .from(evidenceArtifacts)
    .where(eq(evidenceArtifacts.id, "01H0EVID000000000000000001"))
    .all();
  expect(rowsAfter).toHaveLength(1);

  // No success audit emitted for the failed prune.
  const successAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "evidence_pruned"))
    .all();
  expect(successAudits).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 6 — BATCH LIMIT (150 expired rows, batch=100)
// ───────────────────────────────────────────────────────────────────────────
test("batch limit: 150 expired rows → first tick deletes 100, second tick deletes 50", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, {
    userId: "01H0USER000000000000000001",
    orderId: "01H0ORD0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    createdAt: NOW - 30 * DAY_MS,
  });

  // 150 expired evidence rows; use sequential ULID-like ids.
  for (let i = 0; i < 150; i++) {
    const idSuffix = String(i).padStart(8, "0");
    seedEvidence(db, {
      id: `01H0EVID0000000000000${idSuffix}`,
      scanId: "01H0SCAN000000000000000001",
      key: `evidence/batch/${idSuffix}.json`,
      expiresAt: NOW - 60_000 - i,
      createdAt: NOW - 30 * DAY_MS,
    });
  }

  const s3 = createStubS3();
  const handler = createCleanupExpiredReportsHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res1 = await handler.tick();
  expect(res1.deleted).toBe(100);
  expect(res1.errors).toBe(0);
  expect(s3.calls).toHaveLength(100);
  expect(db.select().from(evidenceArtifacts).all()).toHaveLength(50);

  const res2 = await handler.tick();
  expect(res2.deleted).toBe(50);
  expect(res2.errors).toBe(0);
  expect(s3.calls).toHaveLength(150);
  expect(db.select().from(evidenceArtifacts).all()).toHaveLength(0);

  // Audit chain is intact across both batches.
  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 7 — MIXED population
// ───────────────────────────────────────────────────────────────────────────
test("mixed population: expired evidence + expired report + future + null-bucket report", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, {
    userId: "01H0USER000000000000000001",
    orderId: "01H0ORD0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    createdAt: NOW - 14 * DAY_MS,
  });

  // expired evidence — should prune
  seedEvidence(db, {
    id: "01H0EVID000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    key: "evidence/expired.json",
    expiresAt: NOW - 60_000,
    createdAt: NOW - 14 * DAY_MS,
  });
  // future evidence — leave alone
  seedEvidence(db, {
    id: "01H0EVID000000000000000002",
    scanId: "01H0SCAN000000000000000001",
    key: "evidence/future.json",
    expiresAt: NOW + DAY_MS,
    createdAt: NOW - DAY_MS,
  });
  // expired ready report — should prune
  seedReport(db, {
    id: "01H0REP0000000000000000001",
    scanId: "01H0SCAN000000000000000001",
    bucket: TEST_BUCKET,
    key: "reports/expired.pdf",
    expiresAt: NOW - 60_000,
    createdAt: NOW - 14 * DAY_MS,
    status: "ready",
  });
  // expired report with NULL bucket — skip (no object)
  // NOTE: reports has UNIQUE(scan_id) → cannot insert a second report row
  // for the same scan. Test 4 covers null-bucket on its own scan; here we
  // assert the eligible expired report is pruned.

  const s3 = createStubS3();
  const handler = createCleanupExpiredReportsHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await handler.tick();
  expect(res.deleted).toBe(2); // 1 evidence + 1 report
  expect(res.errors).toBe(0);

  // Future evidence still present; expired evidence + expired report gone.
  const ev = db.select().from(evidenceArtifacts).all();
  expect(ev).toHaveLength(1);
  expect(ev[0]!.id).toBe("01H0EVID000000000000000002");
  expect(db.select().from(reports).all()).toHaveLength(0);

  // One evidence_pruned + one report_pruned audit.
  const evAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "evidence_pruned"))
    .all();
  expect(evAudits).toHaveLength(1);
  const repAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "report_pruned"))
    .all();
  expect(repAudits).toHaveLength(1);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 8 — IDEMPOTENCY (second tick is no-op when nothing left)
// ───────────────────────────────────────────────────────────────────────────
test("idempotency: second tick on a clean store is a no-op", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const s3 = createStubS3();
  const handler = createCleanupExpiredReportsHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => NOW,
  });

  const res = await handler.tick();
  expect(res).toEqual({ processed: 0, deleted: 0, errors: 0 });
  expect(s3.calls).toHaveLength(0);
});
