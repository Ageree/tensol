/**
 * T062 — `send_scan_complete_telegram` job handler. (PIVOT applied.)
 *
 * Pivot context (docs/pivot-2026-05-19-telegram-auth.md): the original
 * `send-scan-complete-email` job is renamed to `send-scan-complete-telegram`
 * because Resend (and other email providers) are unavailable to the operator.
 * The notification channel is the operator's Telegram bot
 * (`@tensol_leadsbot`); the PDF report is delivered as a Telegram document.
 *
 * Lifecycle:
 *   1. Idempotency gate — query `audit_log` for a prior `email_sent` row
 *      tagged with this scan_id. If present, no-op return (the runner marks
 *      the job done). This is the cheapest cross-process replay guard
 *      available without adding a `scans.notification_sent_at` column.
 *   2. Load scan + scan_order + user. The user supplies `telegramUserId`
 *      which IS the chat_id for the private DM (Telegram's numeric user id
 *      equals the chat id for 1:1 conversations). If `telegramUserId` is
 *      null → permanent failure with `reason='missing_telegram_user_id'`.
 *   3. If `reportId` is supplied AND `reports.status='ready'` → download
 *      the PDF from S3 to a Buffer. Otherwise pass `reportPdfBuffer: null`
 *      to the notifier (the user still receives a dashboard link in the
 *      message body — the notifier is responsible for that copy).
 *   4. Call the injected `TelegramNotifier.sendScanComplete(...)`.
 *      Retry-on-transient up to MAX_RETRIES (3) with backoff. Transient =
 *      5xx, 429, TIMEOUT, network blips. Permanent (e.g. 400 chat blocked)
 *      breaks out immediately.
 *   5. On success → emit `email_sent` audit row with
 *      `metadata.channel='telegram'` + `message_id` + `has_pdf`.
 *   6. On permanent / retries-exhausted failure → emit `email_send_failed`
 *      audit row with `metadata.channel='telegram'` + `error` + `attempts`.
 *      DO NOT enqueue a retry-telegram-notification operator alert: per
 *      Constitution V we don't double-alert (the user is the only recipient
 *      of this channel; their own failed notification is informational, not
 *      a pageable). Operator alerting on systemic telegram outages is the
 *      monitoring layer's job.
 *
 * Why `email_sent` / `email_send_failed` (not `inquiry_telegram_*`):
 *   BLACKBOX_AUDIT_EVENTS (audit/emit.ts:102-109) has BOTH
 *   `email_sent`/`email_send_failed` (3 events) AND `inquiry_telegram_sent`/
 *   `inquiry_telegram_failed` (2 events). The `inquiry_telegram_*` literals
 *   are scoped to deep_inquiries (operator-facing prospect notifications,
 *   data-model.md §E8). The `email_*` literals are the canonical
 *   "user-facing notification dispatched" events. Reusing `email_*` keeps
 *   the audit semantic stable across the email→telegram transport swap;
 *   the swap itself is recorded in `metadata.channel='telegram'`.
 *
 * Why notify/telegram.ts is NOT created here:
 *   The concrete `TelegramNotifier` implementation is T096 scope (notify/
 *   telegram.ts is expanded by the pivot to cover deep-inquiry + magic-link
 *   + scan-complete). This handler depends only on the interface, so the
 *   tests can inject a fake and the production wiring lands in T096
 *   alongside the rest of the bot module. Same DI pattern T054/T055 (now
 *   merged into T096 by the pivot) would have used.
 *
 * Constitution X: audit emit is OUTSIDE the report-row-load tx (there is
 * no controlling tx for this handler — it's a pure read + external IO).
 * `emitSignedAudit` opens its own `BEGIN IMMEDIATE`.
 */
import { eq, and } from "drizzle-orm";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import type { DB } from "../../db/client.ts";
import {
  auditLog,
  reports as reportsTable,
  scanOrders,
  scans as scansTable,
  users as usersTable,
} from "../../db/schema.ts";
import { ulid } from "../../lib/ids.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { emitSignedAudit } from "../../audit/emit.ts";

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export interface SendScanCompleteTelegramJobPayload {
  readonly scanId: string;
  readonly scanOrderId: string;
  readonly reportId?: string;
  readonly userId: string;
}

/**
 * Abstract Telegram notification surface. The concrete implementation
 * lands in `server/src/notify/telegram.ts` (T096). The handler is fully
 * DI'd against this interface so the test suite can inject a fake.
 */
export interface TelegramNotifier {
  sendScanComplete(input: {
    chatId: number;
    scanOrderId: string;
    scanId: string;
    primaryDomain: string;
    findingsCount: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      informational: number;
    };
    reportPdfBuffer?: Buffer | null;
    reportPdfFilename?: string;
  }): Promise<{ messageId: number | null }>;
}

export interface SendScanCompleteTelegramHandlerDeps {
  readonly db: DB;
  readonly s3: S3Client;
  readonly telegramNotifier: TelegramNotifier;
  readonly auditKey: string;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Sleep between retry attempts. Tests override to 1ms. */
  readonly retryBackoffMs?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────────────────────

interface NormalizedPayload {
  readonly scanId: string;
  readonly scanOrderId: string;
  readonly reportId: string | null;
  readonly userId: string;
}

function normalizePayload(raw: unknown): NormalizedPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error(
      "send_scan_complete_telegram: payload is not an object",
    );
  }
  const r = raw as Record<string, unknown>;
  const scanId =
    (typeof r.scanId === "string" && r.scanId) ||
    (typeof r.scan_id === "string" && r.scan_id) ||
    "";
  const scanOrderId =
    (typeof r.scanOrderId === "string" && r.scanOrderId) ||
    (typeof r.scan_order_id === "string" && r.scan_order_id) ||
    "";
  const userId =
    (typeof r.userId === "string" && r.userId) ||
    (typeof r.user_id === "string" && r.user_id) ||
    "";
  const reportIdRaw =
    (typeof r.reportId === "string" && r.reportId) ||
    (typeof r.report_id === "string" && r.report_id) ||
    "";
  if (!scanId || !scanOrderId || !userId) {
    throw new Error(
      `send_scan_complete_telegram: payload missing scanId/scanOrderId/userId (got ${JSON.stringify(raw)})`,
    );
  }
  return {
    scanId,
    scanOrderId,
    userId,
    reportId: reportIdRaw || null,
  };
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /RATE[_ ]?LIMIT/i,
  /TOO[_ ]MANY[_ ]REQUESTS/i,
  /TIMEOUT/i,
  /TIMED[_ ]?OUT/i,
  /UNAVAILABLE/i,
  /TEMPORARILY/i,
  /(^|[^0-9])5\d{2}([^0-9]|$)/,
  /\b429\b/,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
];

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

/** Collect a Node Readable / WebStream / Uint8Array body into a Buffer. */
async function collectBody(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  // Buffer / Uint8Array
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  // Node Readable (async-iterable)
  const maybeAsyncIter = body as AsyncIterable<unknown>;
  if (typeof maybeAsyncIter[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of maybeAsyncIter) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else chunks.push(Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks);
  }
  // Web ReadableStream
  const maybeWebStream = body as {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    };
  };
  if (typeof maybeWebStream.getReader === "function") {
    const reader = maybeWebStream.getReader();
    const chunks: Buffer[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  // Unknown shape — best-effort string coerce.
  return Buffer.from(String(body));
}

// ───────────────────────────────────────────────────────────────────────────
// Handler factory
// ───────────────────────────────────────────────────────────────────────────

export function createSendScanCompleteTelegramHandler(
  deps: SendScanCompleteTelegramHandlerDeps,
) {
  const {
    db,
    s3,
    telegramNotifier,
    auditKey,
    now = defaultNow,
    newId = () => ulid(now()),
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
  } = deps;

  void newId; // reserved for future correlation id metadata.

  return async function handle(
    jobId: string,
    rawPayload: unknown,
  ): Promise<void> {
    void jobId;
    const { scanId, scanOrderId, reportId, userId } = normalizePayload(rawPayload);

    // 1. Idempotency — already-sent guard via audit replay.
    const priorSuccess = db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(eq(auditLog.event, "email_sent"), eq(auditLog.scanId, scanId)),
      )
      .limit(1)
      .get();
    if (priorSuccess) {
      return;
    }

    // 2. Load scan + order + user.
    const scanRow = db
      .select()
      .from(scansTable)
      .where(eq(scansTable.id, scanId))
      .get();
    if (!scanRow) {
      throw new Error(
        `send_scan_complete_telegram: scans row not found (id=${scanId})`,
      );
    }
    const orderRow = db
      .select()
      .from(scanOrders)
      .where(eq(scanOrders.id, scanOrderId))
      .get();
    if (!orderRow) {
      throw new Error(
        `send_scan_complete_telegram: scan_orders row not found (id=${scanOrderId})`,
      );
    }
    const userRow = db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .get();
    if (!userRow) {
      throw new Error(
        `send_scan_complete_telegram: users row not found (id=${userId})`,
      );
    }

    // 2b. Permanent failure: user has no telegramUserId.
    if (
      userRow.telegramUserId === null ||
      userRow.telegramUserId === undefined
    ) {
      await emitSignedAudit(
        db,
        {
          event: "email_send_failed",
          outcome: "failure",
          ts: now(),
          user_id: userId,
          scan_id: scanId,
          metadata: {
            channel: "telegram",
            reason: "missing_telegram_user_id",
            scan_order_id: scanOrderId,
          },
        },
        { key: auditKey },
      );
      return;
    }

    const chatId = userRow.telegramUserId;

    // 3. Optionally download the PDF.
    let pdfBuffer: Buffer | null = null;
    let pdfFilename: string | undefined;
    if (reportId) {
      const reportRow = db
        .select()
        .from(reportsTable)
        .where(eq(reportsTable.id, reportId))
        .get();
      if (
        reportRow &&
        reportRow.status === "ready" &&
        reportRow.bucket &&
        reportRow.key
      ) {
        try {
          const res = (await s3.send(
            new GetObjectCommand({
              Bucket: reportRow.bucket,
              Key: reportRow.key,
            }),
          )) as { Body?: unknown };
          pdfBuffer = await collectBody(res.Body);
          pdfFilename = `tensol-report-${reportId}.pdf`;
        } catch (err) {
          // If the PDF fetch fails we still try to send the message without
          // attachment — the dashboard link is the durable fallback.
          pdfBuffer = null;
          pdfFilename = undefined;
          // Swallow intentionally; logged in audit metadata below as has_pdf=false.
          void err;
        }
      }
    }

    // 4. Compute findings-by-severity counts for the message preview.
    const findingsCount = await countFindingsBySeverity(db, scanId);

    // 5. Call notifier with transient-retry loop.
    let lastErr: Error | null = null;
    let messageId: number | null = null;
    let attempts = 0;
    let success = false;
    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      attempts = attempt;
      try {
        const result = await telegramNotifier.sendScanComplete({
          chatId,
          scanOrderId,
          scanId,
          primaryDomain: orderRow.primaryDomain,
          findingsCount,
          reportPdfBuffer: pdfBuffer,
          ...(pdfFilename !== undefined ? { reportPdfFilename: pdfFilename } : {}),
        });
        messageId = result.messageId;
        success = true;
        break;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        lastErr = e;
        if (!isTransient(e)) {
          break;
        }
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(retryBackoffMs);
        }
      }
    }

    // 6. Persist outcome via audit (Constitution X — single source of truth
    //    for delivery state; no separate `scans.notification_sent_at` column
    //    in the current schema).
    if (success) {
      await emitSignedAudit(
        db,
        {
          event: "email_sent",
          outcome: "success",
          ts: now(),
          user_id: userId,
          scan_id: scanId,
          metadata: {
            channel: "telegram",
            scan_order_id: scanOrderId,
            chat_id: chatId,
            message_id: messageId,
            has_pdf: pdfBuffer !== null,
            attempts,
          },
        },
        { key: auditKey },
      );
      return;
    }

    // Permanent / exhausted.
    await emitSignedAudit(
      db,
      {
        event: "email_send_failed",
        outcome: "failure",
        ts: now(),
        user_id: userId,
        scan_id: scanId,
        metadata: {
          channel: "telegram",
          scan_order_id: scanOrderId,
          chat_id: chatId,
          attempts,
          has_pdf: pdfBuffer !== null,
          error: (lastErr ?? new Error("unknown")).message,
        },
      },
      { key: auditKey },
    );
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

async function countFindingsBySeverity(
  db: DB,
  scanId: string,
): Promise<{
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
}> {
  // Lazy import to avoid pulling the findings schema into hot-path closure.
  const { findings: findingsTable } = await import("../../db/schema.ts");
  const rows = db
    .select({ severity: findingsTable.severity })
    .from(findingsTable)
    .where(eq(findingsTable.scanId, scanId))
    .all();
  const acc: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  for (const r of rows) {
    const sev = r.severity;
    if (sev && sev in acc) {
      acc[sev] = (acc[sev] ?? 0) + 1;
    }
  }
  return {
    critical: acc.critical ?? 0,
    high: acc.high ?? 0,
    medium: acc.medium ?? 0,
    low: acc.low ?? 0,
    informational: acc.informational ?? 0,
  };
}
