/**
 * T103 — Integration test for `send_deep_inquiry_telegram` job handler (T102).
 *
 * Source of truth:
 *   - `docs/superpowers/specs/2026-05-19-blackbox-mvp-design.md` §3.2
 *     (Telegram operator-alert template)
 *   - `server/src/deep-inquiries/service.ts` (T100) — enqueues the job with
 *     payload `{ type, inquiry_id }`
 *   - `server/src/notify/telegram.ts` — exports low-level `sendMessage`;
 *     here we DI a `sendText: (text, opts) => Promise<{messageId}>` instead
 *     of the higher-level `TelegramNotifier.sendScanComplete(...)` because
 *     the inquiry message is free-form text, not the scan-complete template.
 *
 * What this pins down:
 *   1. HAPPY PATH — pre-seed inquiry → run handler → `sendText` called once
 *      with a MarkdownV2-escaped operator-channel message → row updated
 *      (telegram_sent_at set, telegram_send_attempts incremented) →
 *      `inquiry_telegram_sent` audit emitted with message_id metadata.
 *   2. TRANSIENT FAILURE → RE-ENQUEUE — `sendText` throws a transient error
 *      (TelegramSendError with status=500-class) → handler enqueues a new
 *      `send_deep_inquiry_telegram` job with `scheduled_at = now + 10min`
 *      carrying the original `attemptStartedAt`. NO success or failure audit
 *      emitted yet (delivery still in-progress).
 *   3. 24h TIMEOUT — payload carries `attemptStartedAt = now - 24h - 1ms`;
 *      transient failure surfaces → handler emits `inquiry_telegram_failed`
 *      audit (channel exhausted) and does NOT re-enqueue. No further alert.
 *   4. PERMANENT FAILURE — `sendText` throws non-transient (status 400, e.g.
 *      "chat not found") → `inquiry_telegram_failed` audit emitted; no
 *      re-enqueue. Single attempt, no retry burn.
 *   5. IDEMPOTENT RE-RUN — inquiry.telegram_sent_at already set → handler
 *      short-circuits (no sendText call, no audit, no re-enqueue).
 *   6. MARKDOWN ESCAPE — `company = "Acme_Corp*Inc."` → handler escapes the
 *      reserved chars before embedding the value into the message body.
 *
 * Why this differs from T063 (send-scan-complete-telegram):
 *   - The user-facing scan-complete handler reads PDF from Object Storage and uses the
 *     higher-level `TelegramNotifier.sendScanComplete(...)`. This operator-
 *     facing inquiry handler sends raw text via `sendText` (low-level).
 *   - Retry policy: scan-complete uses 3 in-process attempts with backoff
 *     and gives up. Inquiry uses re-enqueue with 10-min cadence over a 24h
 *     wall-clock window so we don't burn job slots while operator-channel
 *     Telegram outages last hours.
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
  deepInquiries,
  jobs,
} from "../../src/db/schema.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import {
  createSendDeepInquiryTelegramHandler,
  type SendDeepInquiryTelegramPayload,
  type SendTextFn,
} from "../../src/jobs/handlers/send-deep-inquiry-telegram.ts";
import { TelegramSendError } from "../../src/notify/telegram.ts";

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

const TEST_AUDIT_KEY = "test-audit-signing-key-send-deep-inquiry-telegram";
const TEST_CHAT_ID = 496_866_748; // matches @tensol_leadsbot operator channel
const TEN_MIN_MS = 10 * 60 * 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

const FIXED_INQUIRY_ID = "01H0INQ000000000000000DPI";
const FIXED_JOB_ID = "01H0JOB000000000000000DPI";

interface SeedOpts {
  readonly company?: string;
  readonly telegramSentAt?: number | null;
  readonly telegramSendAttempts?: number;
}

/** Seed a `deep_inquiries` row in `status='new'`. */
function seedInquiry(db: DB, now: number, opts: SeedOpts = {}): void {
  db.insert(deepInquiries)
    .values({
      id: FIXED_INQUIRY_ID,
      userId: null,
      company: opts.company ?? "Acme Robotics LLC",
      contactName: "Jane Doe",
      position: "CTO",
      email: "jane@acme.test",
      phone: "+15555550100",
      domainsText: "acme.test\nstaging.acme.test",
      desiredDate: now + 7 * 24 * 60 * 60 * 1_000,
      budgetBand: "500k_1m",
      scopeText: "All prod web apps. Auth endpoints + admin panel.",
      consentAcceptedAt: now,
      status: "new",
      telegramSentAt: opts.telegramSentAt ?? null,
      telegramSendAttempts: opts.telegramSendAttempts ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

interface SendTextCapture {
  readonly calls: Array<{
    readonly text: string;
    readonly chatId: number | string | undefined;
    readonly parseMode: string | undefined;
  }>;
}

function makeFakeSendText(opts: {
  /** Throw this on every call. */
  failError?: Error;
  /** Throw `failError` for first N calls, then succeed. */
  failTimes?: number;
  /** messageId to return on success. */
  messageId?: number;
}): { sendText: SendTextFn; capture: SendTextCapture } {
  const capture: SendTextCapture = { calls: [] };
  let failsRemaining = opts.failTimes ?? 0;
  const sendText: SendTextFn = async (text, callOpts) => {
    capture.calls.push({
      text,
      chatId: callOpts?.chatId,
      parseMode: callOpts?.parseMode,
    });
    if (opts.failError) {
      // If `failTimes` set → throw N times then succeed.
      if (opts.failTimes !== undefined) {
        if (failsRemaining > 0) {
          failsRemaining -= 1;
          throw opts.failError;
        }
      } else {
        // Always fail.
        throw opts.failError;
      }
    }
    return { messageId: opts.messageId ?? 4242 };
  };
  return { sendText, capture };
}

interface EnqueueCapture {
  readonly calls: Array<{
    readonly kind: string;
    readonly payload: unknown;
    readonly availableAt: number | undefined;
  }>;
}

function makeFakeEnqueue(): {
  enqueueJob: (
    kind: string,
    payload: unknown,
    opts?: { availableAt?: number },
  ) => Promise<string>;
  capture: EnqueueCapture;
} {
  const capture: EnqueueCapture = { calls: [] };
  let counter = 0;
  const enqueueJob = async (
    kind: string,
    payload: unknown,
    opts?: { availableAt?: number },
  ): Promise<string> => {
    capture.calls.push({
      kind,
      payload,
      availableAt: opts?.availableAt,
    });
    counter += 1;
    return `enqueued-${counter}`;
  };
  return { enqueueJob, capture };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-send-deep-inquiry-tg-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1 — HAPPY PATH
// ───────────────────────────────────────────────────────────────────────────
test("happy path: sendText called → row updated → inquiry_telegram_sent audit emitted", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedInquiry(db, ts);

  const { sendText, capture: sendCapture } = makeFakeSendText({
    messageId: 9001,
  });
  const { enqueueJob, capture: enqueueCapture } = makeFakeEnqueue();

  let clock = ts + 1;
  const handler = createSendDeepInquiryTelegramHandler({
    db,
    sendText,
    enqueueJob,
    auditKey: TEST_AUDIT_KEY,
    operatorChatId: TEST_CHAT_ID,
    now: () => clock++,
  });

  const payload: SendDeepInquiryTelegramPayload = {
    inquiryId: FIXED_INQUIRY_ID,
  };

  await handler(FIXED_JOB_ID, payload);

  // sendText called exactly once.
  expect(sendCapture.calls).toHaveLength(1);
  const call = sendCapture.calls[0]!;
  expect(call.chatId).toBe(TEST_CHAT_ID);
  expect(call.parseMode).toBe("MarkdownV2");

  // Message body contains the operator-alert markers from design §3.2.
  expect(call.text).toContain("NEW DEEP INQUIRY");
  expect(call.text).toContain("Acme Robotics LLC");
  expect(call.text).toContain("Jane Doe");
  expect(call.text).toContain("CTO");
  expect(call.text).toContain("jane@acme\\.test");
  expect(call.text).toContain("acme\\.test");
  expect(call.text).toContain(FIXED_INQUIRY_ID);

  // Row updated.
  const row = db
    .select()
    .from(deepInquiries)
    .where(eq(deepInquiries.id, FIXED_INQUIRY_ID))
    .get();
  expect(row).toBeDefined();
  expect(row!.telegramSentAt).not.toBeNull();
  expect(row!.telegramSendAttempts).toBe(1);

  // inquiry_telegram_sent audit emitted with message_id metadata.
  const sentAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "inquiry_telegram_sent"))
    .all();
  expect(sentAudits).toHaveLength(1);
  expect(sentAudits[0]!.outcome).toBe("success");
  const meta = JSON.parse(sentAudits[0]!.metadataJson) as Record<
    string,
    unknown
  >;
  expect(meta.inquiry_id).toBe(FIXED_INQUIRY_ID);
  expect(meta.message_id).toBe(9001);
  expect(meta.chat_id).toBe(TEST_CHAT_ID);

  // No failure audit, no re-enqueue.
  const failAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "inquiry_telegram_failed"))
    .all();
  expect(failAudits).toHaveLength(0);
  expect(enqueueCapture.calls).toHaveLength(0);

  // Chain valid.
  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2 — TRANSIENT FAILURE → RE-ENQUEUE
// ───────────────────────────────────────────────────────────────────────────
test("transient failure: 5xx → handler re-enqueues self at now+10min, no audit yet", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedInquiry(db, ts);

  const transientErr = new TelegramSendError(
    "Telegram sendMessage failed: 503 service unavailable",
    { status: 503 },
  );
  const { sendText, capture: sendCapture } = makeFakeSendText({
    failError: transientErr,
  });
  const { enqueueJob, capture: enqueueCapture } = makeFakeEnqueue();

  // Freeze clock so we can assert availableAt precisely.
  const FROZEN = ts + 1_000;
  const handler = createSendDeepInquiryTelegramHandler({
    db,
    sendText,
    enqueueJob,
    auditKey: TEST_AUDIT_KEY,
    operatorChatId: TEST_CHAT_ID,
    now: () => FROZEN,
  });

  await handler(FIXED_JOB_ID, { inquiryId: FIXED_INQUIRY_ID });

  // sendText was called once (failed).
  expect(sendCapture.calls).toHaveLength(1);

  // Re-enqueue with +10min schedule.
  expect(enqueueCapture.calls).toHaveLength(1);
  const reenqueue = enqueueCapture.calls[0]!;
  expect(reenqueue.kind).toBe("send_deep_inquiry_telegram");
  expect(reenqueue.availableAt).toBe(FROZEN + TEN_MIN_MS);
  // Re-enqueue carries inquiryId AND attemptStartedAt (≤ FROZEN).
  const reqPayload = reenqueue.payload as Record<string, unknown>;
  expect(reqPayload.inquiryId).toBe(FIXED_INQUIRY_ID);
  expect(typeof reqPayload.attemptStartedAt).toBe("number");
  expect(reqPayload.attemptStartedAt).toBeLessThanOrEqual(FROZEN);

  // Row attempts incremented but telegram_sent_at NOT set.
  const row = db
    .select()
    .from(deepInquiries)
    .where(eq(deepInquiries.id, FIXED_INQUIRY_ID))
    .get();
  expect(row!.telegramSentAt).toBeNull();
  expect(row!.telegramSendAttempts).toBe(1);

  // No success or failure audit yet — delivery still in flight.
  const sentAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "inquiry_telegram_sent"))
    .all();
  expect(sentAudits).toHaveLength(0);
  const failAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "inquiry_telegram_failed"))
    .all();
  expect(failAudits).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3 — 24h TIMEOUT
// ───────────────────────────────────────────────────────────────────────────
test("24h timeout: transient fail past attemptStartedAt+24h → failure audit, no re-enqueue", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedInquiry(db, ts);

  const transientErr = new TelegramSendError(
    "Telegram sendMessage failed: 502 bad gateway",
    { status: 502 },
  );
  const { sendText } = makeFakeSendText({ failError: transientErr });
  const { enqueueJob, capture: enqueueCapture } = makeFakeEnqueue();

  const FROZEN = ts + 1_000;
  const handler = createSendDeepInquiryTelegramHandler({
    db,
    sendText,
    enqueueJob,
    auditKey: TEST_AUDIT_KEY,
    operatorChatId: TEST_CHAT_ID,
    now: () => FROZEN,
  });

  // attemptStartedAt = FROZEN - 24h - 1ms → already past the deadline.
  await handler(FIXED_JOB_ID, {
    inquiryId: FIXED_INQUIRY_ID,
    attemptStartedAt: FROZEN - TWENTY_FOUR_HOURS_MS - 1,
  });

  // No re-enqueue: 24h window is closed.
  expect(enqueueCapture.calls).toHaveLength(0);

  // inquiry_telegram_failed audit emitted.
  const failAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "inquiry_telegram_failed"))
    .all();
  expect(failAudits).toHaveLength(1);
  expect(failAudits[0]!.outcome).toBe("failure");
  const meta = JSON.parse(failAudits[0]!.metadataJson) as Record<
    string,
    unknown
  >;
  expect(meta.inquiry_id).toBe(FIXED_INQUIRY_ID);
  expect(meta.reason).toBe("retry_window_exhausted");

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4 — PERMANENT FAILURE
// ───────────────────────────────────────────────────────────────────────────
test("permanent failure: 400 chat not found → failure audit, no re-enqueue, single attempt", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedInquiry(db, ts);

  const permanentErr = new TelegramSendError(
    "Telegram sendMessage failed: 400 Bad Request: chat not found",
    { status: 400 },
  );
  const { sendText, capture: sendCapture } = makeFakeSendText({
    failError: permanentErr,
  });
  const { enqueueJob, capture: enqueueCapture } = makeFakeEnqueue();

  let clock = ts + 1;
  const handler = createSendDeepInquiryTelegramHandler({
    db,
    sendText,
    enqueueJob,
    auditKey: TEST_AUDIT_KEY,
    operatorChatId: TEST_CHAT_ID,
    now: () => clock++,
  });

  await handler(FIXED_JOB_ID, { inquiryId: FIXED_INQUIRY_ID });

  // Single attempt, no retry.
  expect(sendCapture.calls).toHaveLength(1);
  expect(enqueueCapture.calls).toHaveLength(0);

  // Failure audit.
  const failAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "inquiry_telegram_failed"))
    .all();
  expect(failAudits).toHaveLength(1);
  const meta = JSON.parse(failAudits[0]!.metadataJson) as Record<
    string,
    unknown
  >;
  expect(meta.inquiry_id).toBe(FIXED_INQUIRY_ID);
  expect(meta.reason).toBe("permanent");
  expect(String(meta.error)).toContain("400");

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5 — IDEMPOTENT RE-RUN
// ───────────────────────────────────────────────────────────────────────────
test("idempotent re-run: telegram_sent_at already set → no-op, no sendText, no audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedInquiry(db, ts, {
    telegramSentAt: ts - 5_000,
    telegramSendAttempts: 1,
  });

  const { sendText, capture: sendCapture } = makeFakeSendText({
    failError: new Error("BUG: must not be called on idempotent re-run"),
  });
  const { enqueueJob, capture: enqueueCapture } = makeFakeEnqueue();

  let clock = ts + 1;
  const handler = createSendDeepInquiryTelegramHandler({
    db,
    sendText,
    enqueueJob,
    auditKey: TEST_AUDIT_KEY,
    operatorChatId: TEST_CHAT_ID,
    now: () => clock++,
  });

  await handler(FIXED_JOB_ID, { inquiryId: FIXED_INQUIRY_ID });

  // Nothing happened.
  expect(sendCapture.calls).toHaveLength(0);
  expect(enqueueCapture.calls).toHaveLength(0);

  const sentAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "inquiry_telegram_sent"))
    .all();
  expect(sentAudits).toHaveLength(0);

  const failAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "inquiry_telegram_failed"))
    .all();
  expect(failAudits).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 6 — MARKDOWN ESCAPE
// ───────────────────────────────────────────────────────────────────────────
test("markdown escape: reserved chars in company are escaped before send", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedInquiry(db, ts, { company: "Acme_Corp*Inc." });

  const { sendText, capture: sendCapture } = makeFakeSendText({
    messageId: 7,
  });
  const { enqueueJob } = makeFakeEnqueue();

  let clock = ts + 1;
  const handler = createSendDeepInquiryTelegramHandler({
    db,
    sendText,
    enqueueJob,
    auditKey: TEST_AUDIT_KEY,
    operatorChatId: TEST_CHAT_ID,
    now: () => clock++,
  });

  await handler(FIXED_JOB_ID, { inquiryId: FIXED_INQUIRY_ID });

  expect(sendCapture.calls).toHaveLength(1);
  const text = sendCapture.calls[0]!.text;
  // Escaped per MarkdownV2 — `_`, `*`, `.` all become `\_`, `\*`, `\.`.
  expect(text).toContain("Acme\\_Corp\\*Inc\\.");
  // Raw, unescaped sequence MUST NOT appear (would break the bold marker).
  expect(text).not.toContain("Acme_Corp*Inc.");
});
