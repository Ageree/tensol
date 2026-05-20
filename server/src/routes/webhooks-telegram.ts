/**
 * `POST /v1/webhooks/telegram-update` — Telegram bot webhook receiver.
 *
 * Pivot context (`docs/pivot-2026-05-19-telegram-auth.md`):
 *   The new auth flow funnels through `@tensol_leadsbot`. When a user opens
 *   the deep-link `https://t.me/tensol_leadsbot?start=<token>` and taps
 *   "Start", Telegram delivers an Update object to this endpoint. We treat
 *   `/start <token>` as the auth-completion signal: consume the
 *   `pending_signups` row, mint a session, reply to the user via the bot.
 *
 * Validation order (TIGHT and ORDERED):
 *   1. `X-Telegram-Bot-Api-Secret-Token` header matches the env-configured
 *      secret. Telegram itself attaches this header — set it on the
 *      `setWebhook` call. Mismatch → return 200 (per Telegram retry policy)
 *      but do not parse the body.
 *   2. JSON-parse the body.
 *   3. Zod-validate against TelegramUpdateSchema.
 *   4. Extract `message.text` matching `^/start (.{26})$`; anything else is
 *      a no-op (return 200 immediately).
 *   5. Invoke `consumeLink({ token, telegramUserId, telegramUsername })`.
 *   6. Reply via `bot.sendMessage` — success / expired / replay all get a
 *      Russian-language confirmation.
 *
 * Why ALWAYS 200:
 *   Telegram retries non-200 responses aggressively (up to 24h). We return
 *   200 even on signature mismatch or invalid body so a misconfigured webhook
 *   doesn't pile up indefinitely on Telegram's side; the real diagnostics
 *   live in the audit chain + stderr.
 *
 * Constitution invariants:
 *   - II (NON-NEGOTIABLE): the secret-token header is verified BEFORE any
 *     JSON.parse + BEFORE any DB read.
 *   - VII (≤800 LOC): ~200 LOC.
 *   - IX (Zod at boundary): TelegramUpdateSchema validates the full Update.
 *   - X (audit emit after commit): handled inside `consumeLink`.
 */
import { Hono } from "hono";
import { z } from "zod";

import { consumeLink } from "../auth/magic-link.ts";
import type { DB } from "../db/client.ts";
import { now as defaultNow } from "../lib/time.ts";

// ---------------------------------------------------------------------------
// Zod — Telegram Update subset.
//   https://core.telegram.org/bots/api#update
//
// We only care about `message.text` + `message.from.{id,username}`; the rest
// is preserved as `passthrough` so future bot commands don't need a schema
// migration. Updates without a `message` (callback_query, inline_query, etc.)
// are accepted with an empty body and ignored.
// ---------------------------------------------------------------------------

export const TelegramFromSchema = z
  .object({
    id: z.number().int().positive(),
    username: z.string().min(1).max(64).optional(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
  })
  .passthrough();

export const TelegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    from: TelegramFromSchema.optional(),
    text: z.string().optional(),
    chat: z.object({ id: z.number().int() }).passthrough().optional(),
  })
  .passthrough();

export const TelegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: TelegramMessageSchema.optional(),
  })
  .passthrough();

export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

// ---------------------------------------------------------------------------
// Notifier shape — narrow subset of `notify/telegram.ts::sendMessage`. Only
// the bits this handler uses are listed so tests can pass a minimal mock.
// ---------------------------------------------------------------------------

export interface WebhookTelegramNotifier {
  /** Send a plain-text reply to the user via the bot. */
  sendMessage(args: { chatId: number; text: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Reply copy. Russian per the operator-facing UX docs.
// ---------------------------------------------------------------------------

const REPLY_SUCCESS = (username: string) =>
  `✓ Готово! Откройте https://app.tensol.ru — вы вошли как @${username}.`;
const REPLY_EXPIRED =
  "Ссылка устарела или уже использована. Запросите новую на https://app.tensol.ru.";
const REPLY_USERNAME_MISMATCH =
  "Telegram-аккаунт не совпадает с тем, что вы указали на сайте. " +
  "Войдите в аккаунт, указанный при регистрации, и попробуйте снова.";
const REPLY_INVALID =
  "Неизвестная команда. Запросите новую ссылку на https://app.tensol.ru.";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateWebhookTelegramRouterDeps {
  readonly db: DB;
  /** HMAC key used for audit signing — same one threaded through scan-orders. */
  readonly signingKey: string;
  /** Telegram-side webhook secret token (set via setWebhook). */
  readonly webhookSecret: string;
  /** Bot client able to send replies. Best-effort: failures are swallowed
   *  + logged so a transient Telegram outage doesn't pin the runner. */
  readonly notifier: WebhookTelegramNotifier;
  readonly now?: () => number;
}

/** Pattern matching `/start <ULID>`. We accept any 26 visible chars to keep
 *  the regex stable against future token-format tweaks; the lookup in
 *  `consumeLink` is the authoritative check. */
const START_TOKEN_RE = /^\/start\s+(\S{1,128})$/;

export function createWebhookTelegramRouter(
  deps: CreateWebhookTelegramRouterDeps,
): Hono {
  const { db, signingKey, webhookSecret, notifier } = deps;
  const clock = deps.now ?? defaultNow;

  const app = new Hono();

  app.post("/telegram-update", async (c) => {
    // 1. Verify secret token header (Constitution II). When the operator has
    //    NOT configured a secret, refuse every inbound — Telegram will retry,
    //    but at least we don't accept anonymous Update payloads in prod.
    const headerSecret = c.req.header("x-telegram-bot-api-secret-token");
    if (!webhookSecret || headerSecret !== webhookSecret) {
      // eslint-disable-next-line no-console
      console.warn(
        "[tensol] webhooks-telegram: secret-token mismatch — dropping update",
      );
      return c.body(null, 200);
    }

    // 2. Parse the body.
    let bodyJson: unknown;
    try {
      bodyJson = await c.req.json();
    } catch {
      return c.body(null, 200);
    }

    // 3. Zod validation.
    const parsed = TelegramUpdateSchema.safeParse(bodyJson);
    if (!parsed.success) {
      // eslint-disable-next-line no-console
      console.warn(
        "[tensol] webhooks-telegram: malformed Update body",
        parsed.error.issues[0]?.message ?? "unknown",
      );
      return c.body(null, 200);
    }
    const update = parsed.data;
    const message = update.message;
    if (!message || !message.text || !message.from) {
      // Non-text update (sticker / location / etc.) → silently accept.
      return c.body(null, 200);
    }

    // 4. Extract `/start <token>`.
    const match = message.text.match(START_TOKEN_RE);
    if (!match) {
      // Other commands (`/help`, `/status`) are deferred to a follow-up
      // task; for MVP we just acknowledge.
      return c.body(null, 200);
    }
    const token = match[1]!;
    const from = message.from;
    const chatId = message.chat?.id ?? from.id;

    // 5. Resolve the token.
    const result = await consumeLink(
      {
        token,
        telegramUserId: from.id,
        ...(from.username !== undefined && { telegramUsername: from.username }),
      },
      { db, signingKey, now: clock },
    );

    // 6. Reply via the bot. Telegram retries 5xx; sendMessage's own retry
    //    loop covers transient failures. If everything fails we still need to
    //    return 200 to stop Telegram from retrying us — the reply UX is
    //    secondary to consuming the token.
    try {
      if (result.ok) {
        await notifier.sendMessage({
          chatId,
          text: REPLY_SUCCESS(result.telegramUsername),
        });
      } else if (result.reason === "username_mismatch") {
        await notifier.sendMessage({ chatId, text: REPLY_USERNAME_MISMATCH });
      } else if (result.reason === "expired" || result.reason === "used") {
        await notifier.sendMessage({ chatId, text: REPLY_EXPIRED });
      } else {
        // invalid token: never issued.
        await notifier.sendMessage({ chatId, text: REPLY_INVALID });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[tensol] webhooks-telegram: sendMessage failed", err);
    }

    return c.body(null, 200);
  });

  return app;
}
