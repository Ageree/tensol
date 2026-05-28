/**
 * T096 — Real Telegram Bot API notifier.
 *
 * Pivot context (`docs/pivot-2026-05-19-telegram-auth.md`): the operator
 * channel for end-user notifications is Telegram (`@tensol_leadsbot`), not
 * email — Resend and other email providers are unavailable to us. This
 * module owns the HTTPS client for Telegram's Bot API, plus the concrete
 * `TelegramNotifier` implementation that the dispatch handler
 * (`jobs/handlers/send-scan-complete-telegram.ts`) depends on.
 *
 * Public surface:
 *
 *   - `sendMessage(text, opts)` — POST to `/bot<TOKEN>/sendMessage`.
 *     Returns `{ messageId }`. Honors 429 `retry_after`; retries 5xx with
 *     exponential backoff; ≤ MAX_ATTEMPTS (5) attempts total.
 *
 *   - `sendDocument(buffer, filename, caption?, opts)` — multipart POST to
 *     `/bot<TOKEN>/sendDocument` to deliver the PDF report. Same retry
 *     semantics as `sendMessage`.
 *
 *   - `escapeMarkdownV2(s)` — escape the 18 MarkdownV2 reserved characters
 *     per https://core.telegram.org/bots/api#markdownv2-style. Used so
 *     user-supplied strings (domain names, IDs) don't corrupt the message
 *     body. The escape set is: `_*[]()~` `` ` `` `>#+-=|{}.!`.
 *
 *   - `createTelegramNotifier({ botToken, fetcher, sleep })` — factory
 *     returning a `TelegramNotifier` (interface declared in
 *     `jobs/handlers/send-scan-complete-telegram.ts`) wired to the
 *     low-level primitives above. The handler treats both 5xx and 429 as
 *     transient at its own layer too, so a thrown `TelegramSendError`
 *     bubbles up and the handler's loop chooses retry-vs-give-up via
 *     `isTransient`.
 *
 * Retry rules (per research §R8):
 *   - Attempts: MAX_ATTEMPTS = 5
 *   - Transient triggers: HTTP 429, 5xx
 *   - Backoff: if Telegram returns `parameters.retry_after`, sleep that
 *     many seconds. Otherwise, sleep `2^(attempt-1)` seconds (1s, 2s, 4s,
 *     8s before attempts 2..5).
 *   - Permanent (4xx other than 429) throws on first attempt.
 *
 * DI hooks:
 *   `fetcher`, `sleep`, and `botToken` are all injectable so unit tests
 *   can drive the retry state machine deterministically without real HTTP
 *   or real time. Defaults read from `process.env.TENSOL_TELEGRAM_*` and
 *   the global `fetch` / `setTimeout`.
 *
 * Why we keep `notify/telegram-placeholder.ts`:
 *   The legacy `LoggingTelegramNotifier` (T066) is left in place as a
 *   no-op fallback for development boots where no bot token is configured
 *   (`TENSOL_TELEGRAM_BOT_TOKEN` absent). `server.ts` wiring will swap to
 *   `createTelegramNotifier(...)` when a token is present; that wiring
 *   change is the final-polish task, not T096.
 */

// ───────────────────────────────────────────────────────────────────────────
// Constants + types
// ───────────────────────────────────────────────────────────────────────────

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_ATTEMPTS = 5;

/**
 * MarkdownV2 reserved characters per the Bot API doc.
 * Source: https://core.telegram.org/bots/api#markdownv2-style
 */
const MARKDOWN_V2_RESERVED = /[_*\[\]()~`>#+\-=|{}.!]/g;

/** Public Telegram parse modes supported by the Bot API. */
export type TelegramParseMode = "MarkdownV2" | "HTML";

export class TelegramSendError extends Error {
  public readonly status: number | undefined;
  public readonly retryAfter: number | undefined;
  public override readonly cause: unknown;

  constructor(
    msg: string,
    opts: {
      status?: number;
      retryAfter?: number;
      cause?: unknown;
    } = {},
  ) {
    super(msg);
    this.name = "TelegramSendError";
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
    this.cause = opts.cause;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Common opts
// ───────────────────────────────────────────────────────────────────────────

export interface SendCommonOpts {
  /** Defaults to `process.env.TENSOL_TELEGRAM_BOT_TOKEN`. */
  readonly botToken?: string;
  /** Numeric chat id. Defaults to `process.env.TENSOL_TELEGRAM_CHAT_ID`. */
  readonly chatId?: number | string;
  readonly parseMode?: TelegramParseMode;
  /** Injectable for tests. Defaults to global `fetch`. */
  readonly fetcher?: typeof fetch;
  /** Injectable for tests. Defaults to `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SendMessageOpts extends SendCommonOpts {
  readonly disableWebPagePreview?: boolean;
}

export type SendDocumentOpts = SendCommonOpts;

// ───────────────────────────────────────────────────────────────────────────
// escapeMarkdownV2
// ───────────────────────────────────────────────────────────────────────────

/**
 * Escape MarkdownV2 reserved characters in `s` so the resulting string can
 * be safely embedded into a MarkdownV2 message body without changing the
 * intended formatting or triggering a Telegram parse error.
 */
export function escapeMarkdownV2(s: string): string {
  return s.replace(MARKDOWN_V2_RESERVED, (m) => `\\${m}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────────

interface TelegramApiResponse {
  readonly ok?: boolean;
  readonly error_code?: number;
  readonly description?: string;
  readonly parameters?: { readonly retry_after?: number };
  readonly result?: { readonly message_id?: number };
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Avoid keeping the event loop alive past test teardown.
    (t as { unref?: () => void }).unref?.();
  });
}

function resolveToken(opts: SendCommonOpts): string {
  const token = opts.botToken ?? process.env.TENSOL_TELEGRAM_BOT_TOKEN ?? "";
  if (!token) {
    throw new TelegramSendError(
      "Telegram bot token not configured (TENSOL_TELEGRAM_BOT_TOKEN)",
    );
  }
  return token;
}

function resolveChatId(opts: SendCommonOpts): string {
  const raw =
    opts.chatId !== undefined && opts.chatId !== ""
      ? opts.chatId
      : process.env.TENSOL_TELEGRAM_CHAT_ID ?? "";
  if (raw === "" || raw === undefined || raw === null) {
    throw new TelegramSendError("Telegram chat_id required");
  }
  return String(raw);
}

function isTransientHttp(errorCode: number): boolean {
  if (errorCode === 429) return true;
  if (errorCode >= 500 && errorCode < 600) return true;
  return false;
}

function backoffMs(retryAfter: number | undefined, attempt: number): number {
  if (typeof retryAfter === "number" && retryAfter > 0) {
    return retryAfter * 1_000;
  }
  // Exponential: 1s, 2s, 4s, 8s before attempts 2..5.
  return Math.pow(2, attempt - 1) * 1_000;
}

interface PostExecuteResult {
  readonly messageId: number;
}

/**
 * Shared retry loop. `buildRequest` is invoked per attempt to produce the
 * `{url, init}` pair. The reason it's a thunk is that multipart
 * `FormData` bodies are single-use streams in some runtimes — rebuilding
 * per attempt keeps the body safely re-sendable.
 */
async function executeWithRetry(
  buildRequest: () => { url: string; init: RequestInit },
  opts: SendCommonOpts,
  operationLabel: string,
): Promise<PostExecuteResult> {
  const fetcher = opts.fetcher ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const { url, init } = buildRequest();
    let resp: Response;
    try {
      resp = await fetcher(url, init);
    } catch (err) {
      // Network errors are treated as transient.
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(undefined, attempt));
        continue;
      }
      throw new TelegramSendError(
        `Telegram ${operationLabel} network error after ${attempt} attempts`,
        { cause: err },
      );
    }

    let data: TelegramApiResponse = {};
    try {
      data = (await resp.json()) as TelegramApiResponse;
    } catch {
      data = {};
    }

    if (resp.ok && data.ok && data.result?.message_id) {
      return { messageId: data.result.message_id };
    }

    const errorCode = data.error_code ?? resp.status;
    const retryAfter = data.parameters?.retry_after;
    if (isTransientHttp(errorCode) && attempt < MAX_ATTEMPTS) {
      await sleep(backoffMs(retryAfter, attempt));
      continue;
    }

    const msg = `Telegram ${operationLabel} failed: ${errorCode} ${data.description ?? ""}`.trim();
    throw new TelegramSendError(msg, {
      status: resp.status,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// sendMessage
// ───────────────────────────────────────────────────────────────────────────

/**
 * Low-level Bot API `sendMessage` wrapper.
 *
 * Retry semantics: 429 + 5xx with exponential backoff (`retry_after`
 * honored), max 5 attempts. Permanent errors throw immediately.
 */
export async function sendMessage(
  text: string,
  opts: SendMessageOpts = {},
): Promise<{ messageId: number }> {
  const token = resolveToken(opts);
  const chatId = resolveChatId(opts);

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const buildRequest = () => {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.disableWebPagePreview !== undefined) {
      body.disable_web_page_preview = opts.disableWebPagePreview;
    }
    return {
      url,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      } satisfies RequestInit,
    };
  };

  return executeWithRetry(buildRequest, opts, "sendMessage");
}

// ───────────────────────────────────────────────────────────────────────────
// sendDocument
// ───────────────────────────────────────────────────────────────────────────

/**
 * Low-level Bot API `sendDocument` wrapper. Uploads `buffer` as the file
 * payload with the given `filename` (must include extension). `caption`,
 * when present, is sent with the same `parse_mode` as the message body
 * would use, so MarkdownV2 escaping rules apply to the caller's caption
 * input.
 */
export async function sendDocument(
  buffer: Buffer | Uint8Array,
  filename: string,
  caption: string | undefined,
  opts: SendDocumentOpts = {},
): Promise<{ messageId: number }> {
  const token = resolveToken(opts);
  const chatId = resolveChatId(opts);

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendDocument`;
  const buildRequest = () => {
    const form = new FormData();
    form.append("chat_id", chatId);
    if (caption !== undefined) form.append("caption", caption);
    if (opts.parseMode) form.append("parse_mode", opts.parseMode);
    // Blob from Buffer; `application/pdf` is reasonable for our use case
    // but Telegram inspects content-type from filename too.
    const blob = new Blob([new Uint8Array(buffer)], {
      type: "application/pdf",
    });
    form.append("document", blob, filename);
    return {
      url,
      init: {
        method: "POST",
        body: form,
        // Note: do NOT set Content-Type — fetch sets the multipart
        // boundary automatically when body is FormData.
      } satisfies RequestInit,
    };
  };

  return executeWithRetry(buildRequest, opts, "sendDocument");
}

// ───────────────────────────────────────────────────────────────────────────
// createTelegramNotifier — concrete TelegramNotifier impl
// ───────────────────────────────────────────────────────────────────────────

/**
 * Inline shape of the `TelegramNotifier` interface declared in
 * `jobs/handlers/send-scan-complete-telegram.ts`. We deliberately do NOT
 * import the type from the handler to avoid a circular-ish dependency
 * (notify is conceptually lower-level than jobs). Structural typing keeps
 * them in lockstep.
 */
export interface NotifierTelegramNotifier {
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

export interface CreateTelegramNotifierOpts {
  /** Defaults to `process.env.TENSOL_TELEGRAM_BOT_TOKEN`. */
  readonly botToken?: string;
  readonly fetcher?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the message body for `sendScanComplete`. Exposed primarily for
 * testability of the formatting rules; the function is pure.
 */
function buildScanCompleteText(input: {
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
}): string {
  const domain = escapeMarkdownV2(input.primaryDomain);
  const orderId = escapeMarkdownV2(input.scanOrderId);
  const scanId = escapeMarkdownV2(input.scanId);
  const f = input.findingsCount;
  // Severity counts are integers — no escaping needed. The `:` separator
  // is not in the MarkdownV2 reserved set.
  const lines = [
    `*Scan complete: ${domain}*`,
    "",
    `Order: \`${orderId}\``,
    `Scan: \`${scanId}\``,
    "",
    "Findings:",
    `• Critical: ${f.critical}`,
    `• High: ${f.high}`,
    `• Medium: ${f.medium}`,
    `• Low: ${f.low}`,
    `• Info: ${f.informational}`,
  ];
  return lines.join("\n");
}

/**
 * Concrete `TelegramNotifier` factory. Returns a value structurally
 * compatible with the handler's `TelegramNotifier` interface.
 *
 * - Without PDF: `sendMessage` with MarkdownV2 parse mode.
 * - With PDF: `sendDocument` (multipart) with the same body as the caption.
 *
 * Both branches surface the resulting `message_id` from Telegram as
 * `{ messageId }`. Errors propagate as `TelegramSendError` so the handler's
 * transient-retry loop can classify them.
 */
export function createTelegramNotifier(
  opts: CreateTelegramNotifierOpts = {},
): NotifierTelegramNotifier {
  return {
    async sendScanComplete(input) {
      const text = buildScanCompleteText(input);
      const baseOpts: SendCommonOpts = {
        chatId: input.chatId,
        parseMode: "MarkdownV2",
        ...(opts.botToken !== undefined ? { botToken: opts.botToken } : {}),
        ...(opts.fetcher !== undefined ? { fetcher: opts.fetcher } : {}),
        ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
      };

      if (input.reportPdfBuffer && input.reportPdfFilename) {
        const result = await sendDocument(
          input.reportPdfBuffer,
          input.reportPdfFilename,
          text,
          baseOpts,
        );
        return { messageId: result.messageId };
      }

      const result = await sendMessage(text, {
        ...baseOpts,
        disableWebPagePreview: true,
      });
      return { messageId: result.messageId };
    },
  };
}
