/**
 * Development fallback for `TelegramNotifier`.
 *
 * The production HTTPS Bot API client lives in `server/src/notify/telegram.ts`.
 * When `TENSOL_TELEGRAM_BOT_TOKEN` is absent, the server boot path still needs
 * a concrete instance to satisfy
 * `SendScanCompleteTelegramHandlerDeps.telegramNotifier`. This module supplies
 * a no-op-but-observable adapter:
 *
 *   - `sendScanComplete` logs the would-be message envelope (chat id,
 *     scan id, findings summary, PDF presence) to console and returns
 *     `{ messageId: null }` to signal "no real delivery occurred".
 *
 * Why we don't throw:
 *   The handler's retry-on-transient loop treats throws as candidates for
 *   retry. Throwing here would lead to 3 noisy attempts + a permanent failure
 *   on every scan completion in local/dev boots without Telegram credentials.
 *   Returning a benign `{ messageId: null }` lets the success-path audit row
 *   emit and the operator can grep the log for the would-be delivery payload.
 *
 * Why `messageId: null` is permissible:
 *   The `TelegramNotifier` interface (see
 *   `jobs/handlers/send-scan-complete-telegram.ts:90-106`) types
 *   `messageId` as `number | null`. The success-path audit emit reads
 *   `messageId` into `metadata.message_id`; null is a legal value the
 *   audit schema tolerates.
 *
 * Scope:
 *   `server.ts` wires the real `createTelegramNotifier({ botToken })` when a
 *   token is present. Tests that exercise the handler already inject their own
 *   fake `TelegramNotifier`, so this module participates only in tokenless
 *   local/dev boots.
 */
import type { TelegramNotifier } from "../jobs/handlers/send-scan-complete-telegram.ts";

export function createLoggingTelegramNotifier(): TelegramNotifier {
	return {
		async sendScanComplete(input) {
			// eslint-disable-next-line no-console
			console.warn(
				`[telegram-placeholder] sendScanComplete invoked without TENSOL_TELEGRAM_BOT_TOKEN. chatId=${input.chatId} scanId=${input.scanId} scanOrderId=${input.scanOrderId} domain=${input.primaryDomain} hasPdf=${Boolean(input.reportPdfBuffer)} findings=${JSON.stringify(input.findingsCount)}`,
			);
			return { messageId: null };
		},
	};
}
