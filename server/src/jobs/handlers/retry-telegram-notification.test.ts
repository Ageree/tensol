import { describe, expect, test } from "bun:test";

import { TelegramSendError } from "../../notify/telegram.ts";
import { createRetryTelegramNotificationHandler } from "./retry-telegram-notification.ts";

describe("createRetryTelegramNotificationHandler", () => {
	test("sends a plain-text operator alert with the failure payload details", async () => {
		const calls: Array<{
			text: string;
			opts:
				| {
						readonly chatId?: number | string;
						readonly parseMode?: "MarkdownV2" | "HTML";
						readonly disableWebPagePreview?: boolean;
				  }
				| undefined;
		}> = [];
		const handler = createRetryTelegramNotificationHandler({
			operatorChatId: "12345",
			sendText: async (text, opts) => {
				calls.push({ text, opts });
				return { messageId: 42 };
			},
		});

		await handler("job-1", {
			type: "retry_telegram_notification",
			kind: "operator_alert_pdf_render_failed",
			scan_id: "scan-1",
			report_id: "report-1",
			attempts: 3,
			error: "puppeteer launch crashed",
		});

		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (!call) throw new Error("expected one sendText call");
		expect(call.opts).toEqual({
			chatId: "12345",
			disableWebPagePreview: true,
		});
		expect(call.text).toContain("Sthrip operator alert");
		expect(call.text).toContain("Job: job-1");
		expect(call.text).toContain("Kind: operator_alert_pdf_render_failed");
		expect(call.text).toContain("scan_id: scan-1");
		expect(call.text).toContain("report_id: report-1");
		expect(call.text).toContain("attempts: 3");
		expect(call.text).toContain("error: puppeteer launch crashed");
	});

	test("includes nested payload fields and truncates very long values", async () => {
		let sentText = "";
		const handler = createRetryTelegramNotificationHandler({
			operatorChatId: 777,
			valueMaxLength: 16,
			sendText: async (text) => {
				sentText = text;
				return { messageId: 7 };
			},
		});

		await handler("job-2", {
			type: "retry_telegram_notification",
			kind: "operator_alert_vm_spawn_failed",
			payload: {
				scan_order_id: "order-1",
				error: "x".repeat(80),
			},
		});

		expect(sentText).toContain("scan_order_id: order-1");
		expect(sentText).toContain("error: xxxxxxxxxxxxxxx...");
	});

	test("throws when operator chat id is not configured", async () => {
		const oldChatId = process.env.TENSOL_TELEGRAM_CHAT_ID;
		process.env.TENSOL_TELEGRAM_CHAT_ID = undefined;
		try {
			const handler = createRetryTelegramNotificationHandler({
				sendText: async () => ({ messageId: 1 }),
			});
			await expect(
				handler("job-3", {
					type: "retry_telegram_notification",
					kind: "operator_alert_pdf_render_failed",
				}),
			).rejects.toThrow("operatorChatId not configured");
		} finally {
			if (oldChatId === undefined) {
				process.env.TENSOL_TELEGRAM_CHAT_ID = undefined;
			} else {
				process.env.TENSOL_TELEGRAM_CHAT_ID = oldChatId;
			}
		}
	});

	test("propagates Telegram errors so the runner can retry and eventually fail", async () => {
		const handler = createRetryTelegramNotificationHandler({
			operatorChatId: "12345",
			sendText: async () => {
				throw new TelegramSendError("telegram 503", { status: 503 });
			},
		});

		await expect(
			handler("job-4", {
				type: "retry_telegram_notification",
				kind: "operator_alert_pdf_render_failed",
			}),
		).rejects.toThrow("telegram 503");
	});
});
