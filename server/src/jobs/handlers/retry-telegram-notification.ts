import type { RetryTelegramNotificationJob } from "../types.ts";

export type SendOperatorAlertTextFn = (
	text: string,
	opts?: {
		readonly chatId?: number | string;
		readonly parseMode?: "MarkdownV2" | "HTML";
		readonly disableWebPagePreview?: boolean;
	},
) => Promise<{ messageId: number }>;

export interface RetryTelegramNotificationHandlerDeps {
	readonly sendText: SendOperatorAlertTextFn;
	readonly operatorChatId?: number | string;
	/** Per-field display cap. Long error messages are clipped before send. */
	readonly valueMaxLength?: number;
	/** Whole Telegram message cap; defaults below Telegram's 4096-char limit. */
	readonly messageMaxLength?: number;
}

const DEFAULT_VALUE_MAX_LENGTH = 500;
const DEFAULT_MESSAGE_MAX_LENGTH = 3500;

function asRecord(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("retry_telegram_notification: payload is not an object");
	}
	return raw as Record<string, unknown>;
}

function clip(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}...`;
}

function formatValue(value: unknown, max: number): string {
	if (typeof value === "string") return clip(value, max);
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	) {
		return String(value);
	}
	try {
		return clip(JSON.stringify(value), max);
	} catch {
		return "[unserializable]";
	}
}

function detailEntries(raw: Record<string, unknown>): Array<[string, unknown]> {
	const entries: Array<[string, unknown]> = [];
	const seen = new Set<string>(["type", "kind"]);

	for (const [key, value] of Object.entries(raw)) {
		if (seen.has(key)) continue;
		if (key === "payload" && value && typeof value === "object") continue;
		seen.add(key);
		entries.push([key, value]);
	}

	const nested = raw.payload;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		for (const [key, value] of Object.entries(nested)) {
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push([key, value]);
		}
	}

	return entries;
}

function resolveChatId(
	operatorChatId: number | string | undefined,
): number | string {
	const chatId = operatorChatId ?? process.env.TENSOL_TELEGRAM_CHAT_ID ?? "";
	if (chatId === "" || chatId === null || chatId === undefined) {
		throw new Error(
			"retry_telegram_notification: operatorChatId not configured (set TENSOL_TELEGRAM_CHAT_ID)",
		);
	}
	return chatId;
}

function buildMessage(
	jobId: string,
	raw: Record<string, unknown>,
	valueMaxLength: number,
	messageMaxLength: number,
): string {
	const kind =
		typeof raw.kind === "string" && raw.kind.trim()
			? raw.kind.trim()
			: "operator_alert_unknown";
	const lines = ["Sthrip operator alert", `Job: ${jobId}`, `Kind: ${kind}`];

	for (const [key, value] of detailEntries(raw)) {
		lines.push(`${key}: ${formatValue(value, valueMaxLength)}`);
	}

	return clip(lines.join("\n"), messageMaxLength);
}

export function createRetryTelegramNotificationHandler(
	deps: RetryTelegramNotificationHandlerDeps,
) {
	const {
		sendText,
		operatorChatId,
		valueMaxLength = DEFAULT_VALUE_MAX_LENGTH,
		messageMaxLength = DEFAULT_MESSAGE_MAX_LENGTH,
	} = deps;

	return async function handleRetryTelegramNotification(
		jobId: string,
		rawPayload: RetryTelegramNotificationJob | unknown,
	): Promise<void> {
		const raw = asRecord(rawPayload);
		const chatId = resolveChatId(operatorChatId);
		const text = buildMessage(jobId, raw, valueMaxLength, messageMaxLength);
		await sendText(text, {
			chatId,
			disableWebPagePreview: true,
		});
	};
}
