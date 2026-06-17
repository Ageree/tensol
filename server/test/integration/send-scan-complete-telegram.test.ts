/**
 * T063 — Integration test for `send_scan_complete_telegram` job handler
 * (T062). PIVOT applied (docs/pivot-2026-05-19-telegram-auth.md):
 * email/Resend is dropped, Telegram bot is the user-facing notification
 * channel; PDF is delivered as a Telegram document attachment.
 *
 * What this pins down:
 *   1. HAPPY WITH PDF — `reports.status='ready'` → handler downloads PDF
 *      from Object Storage → calls `TelegramNotifier.sendScanComplete` with the buffer
 *      + filename → audit `email_sent` (channel='telegram') emitted →
 *      handler returns cleanly.
 *   2. HAPPY WITHOUT PDF — report row missing or status!='ready' → notifier
 *      called with `reportPdfBuffer: null` → still succeeds → same success
 *      audit emitted.
 *   3. TRANSIENT RETRY — notifier throws TIMEOUT once → 2nd attempt
 *      succeeds → ends with `email_sent` audit, exactly one success row.
 *   4. PERMANENT FAILURE — notifier throws permanent on every attempt → 3
 *      retries exhausted → audit `email_send_failed` (channel='telegram')
 *      → handler does NOT throw (failure captured internally; user is NOT
 *      re-notified about their own failed notification — Constitution V).
 *   5. IDEMPOTENT RE-RUN — `scans.notification_sent_at` is not in the
 *      schema yet; idempotency is enforced via the jobs.status check at the
 *      runner level. Here we test the audit-replay guard: if an audit row
 *      with `event='email_sent'` already exists for this scan_id, the
 *      handler short-circuits (no second notifier call, no duplicate audit).
 *   6. MISSING TELEGRAM_USER_ID — user has no telegramUserId → permanent
 *      failure path (BAD_REQUEST-style), audit `email_send_failed` w/
 *      metadata.reason='missing_telegram_user_id'. No notifier call made.
 *
 * Schema notes:
 *   - `users.telegramUserId` is the chat_id for the bot's DM (Telegram's
 *     numeric user id == private-chat id). No separate `telegram_chat_id`
 *     column needed.
 *   - Audit event literals chosen: `email_sent` / `email_send_failed`
 *     (per BLACKBOX_AUDIT_EVENTS lines 102-104). Pivot tagged via
 *     `metadata.channel='telegram'`. Rationale: `inquiry_telegram_*`
 *     events are scoped to deep_inquiries (data-model.md §E8), not
 *     scan-complete user notifications. Reusing `email_*` keeps the
 *     "notification dispatched" semantic stable while the transport swap
 *     is recorded in metadata.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  auditLog,
  jobs,
  reports,
  scanOrders,
  scans,
  users,
} from "../../src/db/schema.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import {
  createSendScanCompleteTelegramHandler,
  type SendScanCompleteTelegramJobPayload,
  type TelegramNotifier,
} from "../../src/jobs/handlers/send-scan-complete-telegram.ts";
import type { ObjectStorageClient } from "../../src/storage/gcs.ts";

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

const TEST_AUDIT_KEY = "test-audit-signing-key-send-scan-complete-telegram";
const TEST_BUCKET = "tensol-reports-test";

const FIXED_USER_ID = "01H0USER000000000000000TG2";
const FIXED_ORDER_ID = "01H0ORD0000000000000000TG2";
const FIXED_SCAN_ID = "01H0SCAN000000000000000TG2";
const FIXED_REPORT_ID = "01H0REP0000000000000000TG2";
const FIXED_JOB_ID = "01H0JOB0000000000000000TG2";
const FIXED_TELEGRAM_USER_ID = 123_456_789;

const DOMAIN = "example.test";

interface SeedOpts {
  readonly reportStatus?: "ready" | "pending" | "failed" | null;
  readonly telegramUserId?: number | null;
}

/**
 * Seed a completed scan + (optionally) a reports row.
 * `reportStatus=null` → no reports row at all.
 */
function seedCompletedScan(db: DB, now: number, opts: SeedOpts = {}): void {
  const reportStatus = opts.reportStatus === undefined ? "ready" : opts.reportStatus;
  const telegramUserId =
    opts.telegramUserId === undefined
      ? FIXED_TELEGRAM_USER_ID
      : opts.telegramUserId;

  db.insert(users)
    .values({
      id: FIXED_USER_ID,
      email: "u@x.test",
      createdAt: now,
      telegramUserId,
      telegramUsername: "u_x_test",
    })
    .run();

  db.insert(scanOrders)
    .values({
      id: FIXED_ORDER_ID,
      userId: FIXED_USER_ID,
      status: "completed",
      tier: "quick",
      primaryDomain: DOMAIN,
      attackSurfaceJson: JSON.stringify([{ hostname: DOMAIN, included: true }]),
      safetyRps: 50,
      dnsVerifyToken: `tensol-verify-${"x".repeat(26)}`,
      dnsVerifiedAt: now,
      dnsCheckAttempts: 1,
      vpsProvider: "gcp",
      paymentKind: "free_quick",
      scanId: FIXED_SCAN_ID,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(scans)
    .values({
      id: FIXED_SCAN_ID,
      userId: FIXED_USER_ID,
      scanOrderId: FIXED_ORDER_ID,
      profile: "recon",
      status: "completed",
      startedAt: now - 60_000,
      completedAt: now,
    })
    .run();

  if (reportStatus !== null) {
    db.insert(reports)
      .values({
        id: FIXED_REPORT_ID,
        scanId: FIXED_SCAN_ID,
        status: reportStatus,
        bucket: reportStatus === "ready" ? TEST_BUCKET : null,
        key: reportStatus === "ready" ? `reports/${FIXED_REPORT_ID}.pdf` : null,
        byteSize: reportStatus === "ready" ? 4096 : null,
        renderAttempts: reportStatus === "ready" ? 1 : 0,
        expiresAt:
          reportStatus === "ready" ? now + 30 * 24 * 60 * 60 * 1000 : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  db.insert(jobs)
    .values({
      id: FIXED_JOB_ID,
      type: "send_scan_complete_telegram",
      payloadJson: JSON.stringify({
        scan_id: FIXED_SCAN_ID,
        scan_order_id: FIXED_ORDER_ID,
        report_id: FIXED_REPORT_ID,
        user_id: FIXED_USER_ID,
      }),
      status: "running",
      scheduledAt: now,
      attempts: 1,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const BASE_PAYLOAD: SendScanCompleteTelegramJobPayload = {
  scanId: FIXED_SCAN_ID,
  scanOrderId: FIXED_ORDER_ID,
  reportId: FIXED_REPORT_ID,
  userId: FIXED_USER_ID,
};

// ───────────────────────────────────────────────────────────────────────────
// Storage fake — supports getObject; records gets, throws if asked.
// ───────────────────────────────────────────────────────────────────────────
interface StorageCapture {
  readonly gets: Array<{ readonly bucket: string; readonly key: string }>;
}

function makeFakeStorage(opts: {
  pdfBytes?: Buffer;
  failGet?: boolean;
  failError?: Error;
}): { client: ObjectStorageClient; capture: StorageCapture } {
  const capture: StorageCapture = { gets: [] };
  const client = {
    async putObject() {},
    async getObject(input) {
      capture.gets.push(input);
      if (opts.failGet) {
        throw opts.failError ?? new Error("storage: HTTP 500 internal server error");
      }
      return opts.pdfBytes ?? Buffer.from("%PDF-1.4 fake");
    },
    async deleteObject() {},
  } satisfies ObjectStorageClient;
  return { client, capture };
}

// ───────────────────────────────────────────────────────────────────────────
// TelegramNotifier fake — capture all calls, support fail-N-then-succeed.
// ───────────────────────────────────────────────────────────────────────────
interface NotifierCapture {
  readonly calls: Array<{
    readonly chatId: number;
    readonly scanOrderId: string;
    readonly scanId: string;
    readonly primaryDomain: string;
    readonly hasPdf: boolean;
    readonly pdfBytes: number;
    readonly pdfFilename: string | null;
  }>;
}

function makeFakeNotifier(opts: {
  failTimes?: number;
  failError?: Error;
  alwaysFail?: boolean;
}): { notifier: TelegramNotifier; capture: NotifierCapture } {
  const capture: NotifierCapture = { calls: [] };
  let failsRemaining = opts.failTimes ?? 0;
  const notifier: TelegramNotifier = {
    async sendScanComplete(input) {
      capture.calls.push({
        chatId: input.chatId,
        scanOrderId: input.scanOrderId,
        scanId: input.scanId,
        primaryDomain: input.primaryDomain,
        hasPdf: !!input.reportPdfBuffer,
        pdfBytes: input.reportPdfBuffer ? input.reportPdfBuffer.byteLength : 0,
        pdfFilename: input.reportPdfFilename ?? null,
      });
      if (opts.alwaysFail) {
        throw opts.failError ?? new Error("telegram: 400 bad chat id");
      }
      if (failsRemaining > 0) {
        failsRemaining -= 1;
        throw opts.failError ?? new Error("telegram: TIMEOUT");
      }
      return { messageId: 555 };
    },
  };
  return { notifier, capture };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-send-scan-tg-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1 — HAPPY WITH PDF
// ───────────────────────────────────────────────────────────────────────────
test("happy with PDF: storage get called → notifier called w/ buffer → email_sent (channel=telegram) audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScan(db, ts, { reportStatus: "ready" });

  const pdfBytes = Buffer.from("%PDF-1.4 real-report-content");
  const { client: storage, capture: storageCapture } = makeFakeStorage({ pdfBytes });
  const { notifier, capture: nCapture } = makeFakeNotifier({});

  let clock = ts + 1;
  const handler = createSendScanCompleteTelegramHandler({
    db,
    storage,
    telegramNotifier: notifier,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // Storage get called once with the correct key.
  expect(storageCapture.gets).toHaveLength(1);
  expect(storageCapture.gets[0]!.bucket).toBe(TEST_BUCKET);
  expect(storageCapture.gets[0]!.key).toBe(`reports/${FIXED_REPORT_ID}.pdf`);

  // Notifier called once with buffer + filename.
  expect(nCapture.calls).toHaveLength(1);
  const call = nCapture.calls[0]!;
  expect(call.chatId).toBe(FIXED_TELEGRAM_USER_ID);
  expect(call.scanId).toBe(FIXED_SCAN_ID);
  expect(call.scanOrderId).toBe(FIXED_ORDER_ID);
  expect(call.primaryDomain).toBe(DOMAIN);
  expect(call.hasPdf).toBe(true);
  expect(call.pdfBytes).toBe(pdfBytes.byteLength);
  expect(call.pdfFilename).toContain(FIXED_REPORT_ID);
  expect(call.pdfFilename!.endsWith(".pdf")).toBe(true);

  // email_sent audit emitted with channel=telegram.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_sent"))
    .all();
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0]!.outcome).toBe("success");
  expect(auditRows[0]!.scanId).toBe(FIXED_SCAN_ID);
  const meta = JSON.parse(auditRows[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.channel).toBe("telegram");
  expect(meta.message_id).toBe(555);
  expect(meta.has_pdf).toBe(true);

  // No failure audit.
  const fails = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_send_failed"))
    .all();
  expect(fails).toHaveLength(0);

  // Chain still valid.
  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2 — HAPPY WITHOUT PDF (report not ready / missing)
// ───────────────────────────────────────────────────────────────────────────
test("happy without PDF: report status=failed → notifier called with null buffer → email_sent audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScan(db, ts, { reportStatus: "failed" });

  const { client: storage, capture: storageCapture } = makeFakeStorage({});
  const { notifier, capture: nCapture } = makeFakeNotifier({});

  let clock = ts + 1;
  const handler = createSendScanCompleteTelegramHandler({
    db,
    storage,
    telegramNotifier: notifier,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // No storage download attempted (report not ready).
  expect(storageCapture.gets).toHaveLength(0);

  // Notifier still called, with null buffer.
  expect(nCapture.calls).toHaveLength(1);
  expect(nCapture.calls[0]!.hasPdf).toBe(false);
  expect(nCapture.calls[0]!.pdfFilename).toBeNull();

  // email_sent audit with has_pdf=false.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_sent"))
    .all();
  expect(auditRows).toHaveLength(1);
  const meta = JSON.parse(auditRows[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.channel).toBe("telegram");
  expect(meta.has_pdf).toBe(false);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3 — TRANSIENT RETRY
// ───────────────────────────────────────────────────────────────────────────
test("transient retry: notifier throws TIMEOUT once then succeeds → email_sent audit once", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScan(db, ts, { reportStatus: "ready" });

  const { client: storage } = makeFakeStorage({ pdfBytes: Buffer.from("%PDF-1.4 ok") });
  const { notifier, capture: nCapture } = makeFakeNotifier({ failTimes: 1 });

  let clock = ts + 1;
  const handler = createSendScanCompleteTelegramHandler({
    db,
    storage,
    telegramNotifier: notifier,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // Notifier called twice (1 fail + 1 success).
  expect(nCapture.calls).toHaveLength(2);

  // Exactly one success audit.
  const successAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_sent"))
    .all();
  expect(successAudits).toHaveLength(1);

  // No failure audit on the success-after-retry path.
  const failAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_send_failed"))
    .all();
  expect(failAudits).toHaveLength(0);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4 — PERMANENT FAILURE
// ───────────────────────────────────────────────────────────────────────────
test("permanent failure: notifier always throws → 3 attempts → email_send_failed audit, handler does not throw", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScan(db, ts, { reportStatus: "ready" });

  const { client: storage } = makeFakeStorage({ pdfBytes: Buffer.from("%PDF-1.4 ok") });
  const { notifier, capture: nCapture } = makeFakeNotifier({
    alwaysFail: true,
    failError: new Error("telegram: 400 bad request (chat blocked)"),
  });

  let clock = ts + 1;
  const handler = createSendScanCompleteTelegramHandler({
    db,
    storage,
    telegramNotifier: notifier,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    retryBackoffMs: 1,
  });

  // Handler MUST NOT throw.
  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // Permanent (non-transient) error → no retries, single attempt.
  // Transient (TIMEOUT/5xx) error → 3 attempts.
  // 400-class is permanent → exactly 1.
  expect(nCapture.calls).toHaveLength(1);

  // email_send_failed audit emitted.
  const failAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_send_failed"))
    .all();
  expect(failAudits).toHaveLength(1);
  expect(failAudits[0]!.outcome).toBe("failure");
  const meta = JSON.parse(failAudits[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.channel).toBe("telegram");
  expect(String(meta.error)).toContain("400");

  // No double-alert: no second telegram job enqueued from this handler
  // (operator alert is the operator's pager; user is not re-notified about
  // a failed delivery to themselves).
  const newJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "retry_telegram_notification"))
    .all();
  expect(newJobs).toHaveLength(0);

  // No success audit.
  const successAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_sent"))
    .all();
  expect(successAudits).toHaveLength(0);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4b — PERMANENT FAILURE w/ transient pattern → exhausts 3 retries
// ───────────────────────────────────────────────────────────────────────────
test("transient-but-persistent failure: 5xx every time → 3 attempts → email_send_failed audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScan(db, ts, { reportStatus: "ready" });

  const { client: storage } = makeFakeStorage({ pdfBytes: Buffer.from("%PDF-1.4 ok") });
  const { notifier, capture: nCapture } = makeFakeNotifier({
    alwaysFail: true,
    failError: new Error("telegram: 503 service unavailable"),
  });

  let clock = ts + 1;
  const handler = createSendScanCompleteTelegramHandler({
    db,
    storage,
    telegramNotifier: notifier,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // 5xx is transient → 3 attempts.
  expect(nCapture.calls).toHaveLength(3);

  const failAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_send_failed"))
    .all();
  expect(failAudits).toHaveLength(1);
  const meta = JSON.parse(failAudits[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.attempts).toBe(3);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5 — IDEMPOTENT RE-RUN
// ───────────────────────────────────────────────────────────────────────────
test("idempotent re-run: prior email_sent audit for this scan → no notifier call, no duplicate audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScan(db, ts, { reportStatus: "ready" });

  // Pre-seed a prior success audit row by invoking the handler once.
  const { client: storage } = makeFakeStorage({ pdfBytes: Buffer.from("%PDF-1.4 ok") });
  const { notifier: firstNotifier } = makeFakeNotifier({});
  let clock = ts + 1;
  const handler = createSendScanCompleteTelegramHandler({
    db,
    storage,
    telegramNotifier: firstNotifier,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    retryBackoffMs: 1,
  });
  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // Sanity: one success audit exists.
  const beforeAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_sent"))
    .all();
  expect(beforeAudits).toHaveLength(1);

  // Now re-run with a new notifier that fails loud if called.
  const { notifier: secondNotifier, capture: secondCapture } = makeFakeNotifier({
    alwaysFail: true,
    failError: new Error("BUG: must not be called on idempotent re-run"),
  });
  const handler2 = createSendScanCompleteTelegramHandler({
    db,
    storage,
    telegramNotifier: secondNotifier,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    retryBackoffMs: 1,
  });
  await handler2(FIXED_JOB_ID, BASE_PAYLOAD);

  // Second run is a no-op.
  expect(secondCapture.calls).toHaveLength(0);

  const afterAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_sent"))
    .all();
  expect(afterAudits).toHaveLength(1); // still one, no duplicate.

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 6 — MISSING TELEGRAM_USER_ID (BAD_REQUEST permanent failure)
// ───────────────────────────────────────────────────────────────────────────
test("missing telegram_user_id: user has no telegramUserId → permanent failure, no notifier call", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScan(db, ts, { reportStatus: "ready", telegramUserId: null });

  const { client: storage } = makeFakeStorage({ pdfBytes: Buffer.from("%PDF-1.4 ok") });
  const { notifier, capture: nCapture } = makeFakeNotifier({});

  let clock = ts + 1;
  const handler = createSendScanCompleteTelegramHandler({
    db,
    storage,
    telegramNotifier: notifier,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // Notifier never called.
  expect(nCapture.calls).toHaveLength(0);

  // email_send_failed audit with reason=missing_telegram_user_id.
  const failAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "email_send_failed"))
    .all();
  expect(failAudits).toHaveLength(1);
  const meta = JSON.parse(failAudits[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.channel).toBe("telegram");
  expect(meta.reason).toBe("missing_telegram_user_id");

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});
