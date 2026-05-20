/**
 * T102 — `send_deep_inquiry_telegram` job handler.
 *
 * Source of truth:
 *   - `docs/superpowers/specs/2026-05-19-blackbox-mvp-design.md` §3.2 —
 *     operator-channel Telegram template
 *   - `server/src/deep-inquiries/service.ts` (T100) — enqueues the job with
 *     payload `{ type: 'send_deep_inquiry_telegram', inquiry_id }` from
 *     `createInquiry(...)`
 *   - `server/src/notify/telegram.ts` (T096) — exports low-level
 *     `sendMessage(text, opts)` + `escapeMarkdownV2(s)` + `TelegramSendError`
 *
 * Why we DI a `sendText` function rather than the full `TelegramNotifier`:
 *   The existing `TelegramNotifier` interface (T062) only exposes
 *   `sendScanComplete(...)` — the scan-completed template. The inquiry
 *   alert is operator-facing free-form text. Rather than bloat the notifier
 *   surface with a second method, we DI the lowest-useful primitive
 *   (`(text, opts) => Promise<{messageId}>`) and let production wire it to
 *   `notify/telegram.ts::sendMessage`. Tests inject a fake.
 *
 * Retry policy (operator channel, NOT user channel):
 *   - Permanent failure (4xx other than 429) → emit `inquiry_telegram_failed`
 *     audit, mark job done. No re-enqueue (re-trying would be pointless).
 *   - Transient failure (5xx, 429, network) → re-enqueue a fresh
 *     `send_deep_inquiry_telegram` job at `now + 10 min` carrying the
 *     `attemptStartedAt` of the first attempt. The current job is marked
 *     done by the runner (no exception thrown). When the next attempt runs,
 *     if `now() - attemptStartedAt >= 24h` and the call still fails, we
 *     give up and emit `inquiry_telegram_failed`.
 *   - Why no in-process retry loop here: operator-channel Telegram outages
 *     are typically hours-long (DNS / region / abuse), not seconds. Keeping
 *     N attempts inside a single job invocation would burn a worker slot.
 *     The 10-minute cadence over 24h gives ≤ 144 attempts, plenty.
 *   - Constitution V: when the alert channel itself is broken, we do NOT
 *     try to alert about the alert. The signed `inquiry_telegram_failed`
 *     audit row IS the durable failure record; operator dashboards read
 *     `deep_inquiries` for fresh rows even if Telegram never delivered.
 *
 * Idempotency:
 *   - Gate on `deep_inquiries.telegram_sent_at IS NOT NULL`. If already
 *     delivered, no-op return. This guards against:
 *       a) the runner re-firing a job whose prior run crashed AFTER the
 *          UPDATE committed but BEFORE the job row was marked done;
 *       b) operator-initiated manual retries from the admin UI.
 *
 * Constitution invariants:
 *   - VI:  failing test first (test/integration/send-deep-inquiry-telegram.test.ts).
 *   - VII: file ≤ 800 LOC (this file ~ 280 LOC).
 *   - X:   audit emit is OUTSIDE the controlling tx. `emitSignedAudit`
 *          opens its own `BEGIN IMMEDIATE`; bun:sqlite forbids nesting.
 */
import { eq } from "drizzle-orm";

import type { DB } from "../../db/client.ts";
import { withTx } from "../../db/client.ts";
import {
  deepInquiries as deepInquiriesTable,
  type DeepInquiry as DeepInquiryRow,
} from "../../db/schema.ts";
import { ulid } from "../../lib/ids.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { emitSignedAudit } from "../../audit/emit.ts";
import {
  escapeMarkdownV2,
  TelegramSendError,
} from "../../notify/telegram.ts";

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export interface SendDeepInquiryTelegramPayload {
  /** Inquiry row id (`deep_inquiries.id`). */
  readonly inquiryId: string;
  /**
   * Wall-clock ms of the very first attempt. Set by this handler on the
   * first transient re-enqueue and threaded through subsequent retries so
   * the 24h give-up window is anchored to first delivery attempt rather
   * than the current attempt.
   *
   * Absent on the initial job inserted by `deep-inquiries/service.ts`; the
   * handler treats `undefined` as "this is the first attempt, anchor to
   * now()".
   */
  readonly attemptStartedAt?: number;
}

/**
 * Low-level "send a MarkdownV2 message to chat X" surface. Production wires
 * this to `notify/telegram.ts::sendMessage(text, opts)`. Tests inject a fake.
 *
 * The shape mirrors `sendMessage`'s contract: returns `{messageId}` on
 * success; throws `TelegramSendError` (or any `Error`) on failure. The
 * `status` field on `TelegramSendError` drives the transient-vs-permanent
 * classifier.
 */
export type SendTextFn = (
  text: string,
  opts?: {
    readonly chatId?: number | string;
    readonly parseMode?: "MarkdownV2" | "HTML";
    readonly disableWebPagePreview?: boolean;
  },
) => Promise<{ messageId: number }>;

/** Job-enqueue surface — mirrors `EnqueueJobFn` in deep-inquiries/service.ts
 *  but with an additional `availableAt` option so the retry can defer.
 *
 *  Default impl writes to the `jobs` table; tests DI a stub. */
export type EnqueueJobFn = (
  kind: string,
  payload: unknown,
  opts?: { availableAt?: number },
) => Promise<string>;

export interface SendDeepInquiryTelegramHandlerDeps {
  readonly db: DB;
  /** Low-level Telegram "send raw text" surface. */
  readonly sendText: SendTextFn;
  /** Enqueue another job (used for the 10-min transient retry). */
  readonly enqueueJob: EnqueueJobFn;
  /** Audit-log signing key. */
  readonly auditKey: string;
  /** Operator channel chat_id (TENSOL_TELEGRAM_CHAT_ID env in prod). */
  readonly operatorChatId?: number | string;
  readonly now?: () => number;
  readonly newId?: () => string;
}

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

const RETRY_INTERVAL_MS = 10 * 60 * 1_000; // 10 min
const MAX_TOTAL_DURATION_MS = 24 * 60 * 60 * 1_000; // 24h

/** Display caps for free-text fields so the Telegram message stays small.
 *  Telegram's hard limit is 4096 chars per message; we want headroom. */
const DOMAINS_DISPLAY_MAX = 200;
const SCOPE_DISPLAY_MAX = 500;

// ───────────────────────────────────────────────────────────────────────────
// Payload normalization
// ───────────────────────────────────────────────────────────────────────────

interface NormalizedPayload {
  readonly inquiryId: string;
  readonly attemptStartedAt: number | null;
}

function normalizePayload(raw: unknown): NormalizedPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("send_deep_inquiry_telegram: payload is not an object");
  }
  const r = raw as Record<string, unknown>;
  const inquiryId =
    (typeof r.inquiryId === "string" && r.inquiryId) ||
    (typeof r.inquiry_id === "string" && r.inquiry_id) ||
    "";
  if (!inquiryId) {
    throw new Error(
      `send_deep_inquiry_telegram: payload missing inquiryId (got ${JSON.stringify(raw)})`,
    );
  }
  const attemptStartedAtRaw =
    (typeof r.attemptStartedAt === "number" && r.attemptStartedAt) ||
    (typeof r.attempt_started_at === "number" && r.attempt_started_at) ||
    null;
  return {
    inquiryId,
    attemptStartedAt:
      typeof attemptStartedAtRaw === "number" ? attemptStartedAtRaw : null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Transient vs permanent classifier
// ───────────────────────────────────────────────────────────────────────────

/**
 * Treat as transient: HTTP 429, 5xx, network-level errors (no status), and
 * fetch-style messages without a status code. Anything 4xx-other-than-429
 * is permanent — re-trying chat-not-found won't help.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof TelegramSendError) {
    const status = err.status;
    if (status === undefined) return true; // network-level / unclassified
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // Non-TelegramSendError: assume transient (network or runtime hiccup).
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Message formatting — design §3.2
// ───────────────────────────────────────────────────────────────────────────

/**
 * Truncate a string to `max` chars, appending `…` if shortened. The trailing
 * ellipsis itself is not a MarkdownV2 reserved char, so callers can escape
 * the result whole.
 */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Build the operator-channel message body. All user-supplied substrings are
 * `escapeMarkdownV2`-ed before assembly to avoid corrupting the bold-marker
 * or breaking the parse mode.
 *
 * Layout (per design §3.2, with minor cleanup for clarity):
 *
 *   *NEW DEEP INQUIRY*
 *   Company: <company>
 *   Contact: <name>, <position>
 *   Email: <email>
 *   Phone: <phone>
 *   Domains: <first 200 chars>
 *   Desired: <date|—>
 *   Budget: <budget|—>
 *   Scope: <first 500 chars>
 *   ID: <id>
 *   User: <user_id|anonymous>
 */
function buildMessage(row: DeepInquiryRow): string {
  const e = escapeMarkdownV2;
  const company = e(row.company);
  const contact = e(
    row.position ? `${row.contactName}, ${row.position}` : row.contactName,
  );
  const email = row.email ? e(row.email) : e("—");
  const phone = e(row.phone);
  const domains = e(clip(row.domainsText, DOMAINS_DISPLAY_MAX));
  const scope = e(clip(row.scopeText, SCOPE_DISPLAY_MAX));
  const desired = row.desiredDate
    ? e(new Date(row.desiredDate).toISOString())
    : e("—");
  const budget = row.budgetBand ? e(row.budgetBand) : e("—");
  const id = e(row.id);
  const user = row.userId ? e(row.userId) : e("anonymous");

  const lines = [
    `*NEW DEEP INQUIRY*`,
    `Company: ${company}`,
    `Contact: ${contact}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Domains: ${domains}`,
    `Desired: ${desired}`,
    `Budget: ${budget}`,
    `Scope: ${scope}`,
    `ID: ${id}`,
    `User: ${user}`,
  ];
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Handler factory
// ───────────────────────────────────────────────────────────────────────────

export function createSendDeepInquiryTelegramHandler(
  deps: SendDeepInquiryTelegramHandlerDeps,
) {
  const {
    db,
    sendText,
    enqueueJob,
    auditKey,
    operatorChatId,
    now = defaultNow,
    newId = () => ulid(now()),
  } = deps;

  void newId; // reserved for future correlation-id metadata.

  return async function handle(
    jobId: string,
    rawPayload: unknown,
  ): Promise<void> {
    void jobId;
    const { inquiryId, attemptStartedAt } = normalizePayload(rawPayload);

    // 1. Load inquiry + idempotency gate.
    const row = db
      .select()
      .from(deepInquiriesTable)
      .where(eq(deepInquiriesTable.id, inquiryId))
      .get();
    if (!row) {
      throw new Error(
        `send_deep_inquiry_telegram: deep_inquiries row not found (id=${inquiryId})`,
      );
    }
    if (row.telegramSentAt != null) {
      // Already delivered — re-fire of a stale job. No-op.
      return;
    }

    // 2. Resolve operator chat id. Allow env-var fallback at the deps layer;
    //    if neither is set, fall back to env (`TENSOL_TELEGRAM_CHAT_ID`),
    //    matching `notify/telegram.ts::resolveChatId`. A truly missing
    //    chat_id is a configuration bug → throw so the runner records it.
    const chatId =
      operatorChatId ?? process.env.TENSOL_TELEGRAM_CHAT_ID ?? "";
    if (chatId === "" || chatId === null || chatId === undefined) {
      throw new Error(
        "send_deep_inquiry_telegram: operatorChatId not configured (set TENSOL_TELEGRAM_CHAT_ID)",
      );
    }

    // 3. Anchor for the 24h give-up window. First attempt sets it to now();
    //    subsequent re-enqueues thread it through.
    const ts = now();
    const anchor = attemptStartedAt ?? ts;

    // 4. Format + send.
    const text = buildMessage(row);
    let result: { messageId: number } | null = null;
    let lastErr: Error | null = null;
    try {
      result = await sendText(text, {
        chatId,
        parseMode: "MarkdownV2",
        disableWebPagePreview: true,
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }

    // 5. Bump attempts counter regardless of outcome (gives operators
    //    visibility into the retry history in the admin UI).
    await withTx(db, async (tx) => {
      tx.update(deepInquiriesTable)
        .set({
          telegramSendAttempts: row.telegramSendAttempts + 1,
          updatedAt: ts,
          ...(result ? { telegramSentAt: ts } : {}),
        })
        .where(eq(deepInquiriesTable.id, inquiryId))
        .run();
    });

    // 6. Success path → audit + return.
    if (result) {
      await emitSignedAudit(
        db,
        {
          event: "inquiry_telegram_sent",
          outcome: "success",
          ts,
          user_id: row.userId ?? null,
          metadata: {
            inquiry_id: inquiryId,
            message_id: result.messageId,
            chat_id: chatId,
            attempts: row.telegramSendAttempts + 1,
          },
        },
        { key: auditKey },
      );
      return;
    }

    // 7. Failure path. Decide: transient + still inside 24h → re-enqueue;
    //    otherwise emit `inquiry_telegram_failed` audit (permanent OR window
    //    exhausted) and let the runner mark this job done.
    const err = lastErr ?? new Error("send_deep_inquiry_telegram: unknown failure");
    const elapsed = ts - anchor;
    const transient = isTransient(err);
    const windowOpen = elapsed < MAX_TOTAL_DURATION_MS;

    if (transient && windowOpen) {
      // Re-enqueue self at now+10min, carrying the original anchor so the
      // 24h window stays anchored to the first attempt.
      await enqueueJob(
        "send_deep_inquiry_telegram",
        {
          type: "send_deep_inquiry_telegram",
          inquiryId,
          attemptStartedAt: anchor,
        },
        { availableAt: ts + RETRY_INTERVAL_MS },
      );
      return;
    }

    // Permanent OR window exhausted — give up, record the failure.
    const reason = transient ? "retry_window_exhausted" : "permanent";
    await emitSignedAudit(
      db,
      {
        event: "inquiry_telegram_failed",
        outcome: "failure",
        ts,
        user_id: row.userId ?? null,
        metadata: {
          inquiry_id: inquiryId,
          chat_id: chatId,
          attempts: row.telegramSendAttempts + 1,
          reason,
          error: err.message,
        },
      },
      { key: auditKey },
    );
  };
}
