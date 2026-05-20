/**
 * T097 — Tests for `notify/telegram.ts` (T096).
 *
 * Covers the four exports:
 *   - `escapeMarkdownV2(s)`              — reserved-char escape
 *   - `sendMessage(text, opts)`          — Bot API sendMessage + retries
 *   - `sendDocument(buf, name, ...)`     — Bot API sendDocument + retries
 *   - `createTelegramNotifier(opts)`     — concrete `TelegramNotifier`
 *     impl matching the interface declared in
 *     `jobs/handlers/send-scan-complete-telegram.ts`.
 *
 * Network is fully mocked via the injected `fetcher`. The notifier honors
 * Telegram's 429 `retry_after` and exponentially backs off on 5xx, up to
 * `MAX_ATTEMPTS = 5`. Permanent (4xx other than 429) errors throw on the
 * first attempt.
 *
 * Token format used in tests is synthetic — Telegram bot tokens are shaped
 * `<digits>:AAH...`; we use `123456:AAH-test-fake-token` so secret-scanner
 * regexes do not flag the fixture.
 */
import { describe, expect, test } from "bun:test";

import {
  TelegramSendError,
  createTelegramNotifier,
  escapeMarkdownV2,
  sendDocument,
  sendMessage,
} from "./telegram.ts";

const FAKE_TOKEN = "123456:AAH-test-fake-token";
const FAKE_CHAT_ID = 999_888_777;

// ───────────────────────────────────────────────────────────────────────────
// escapeMarkdownV2
// ───────────────────────────────────────────────────────────────────────────

describe("escapeMarkdownV2", () => {
  test("escapes the 18 MarkdownV2 reserved characters", () => {
    const reserved = "_*[]()~`>#+-=|{}.!";
    const escaped = escapeMarkdownV2(reserved);
    // Every reserved char must be preceded by a backslash.
    for (const ch of reserved) {
      expect(escaped).toContain(`\\${ch}`);
    }
    // Length doubles for the reserved-only input.
    expect(escaped.length).toBe(reserved.length * 2);
  });

  test("leaves alphanumeric and whitespace untouched", () => {
    const plain = "Acme Corp 42 produces widgets";
    expect(escapeMarkdownV2(plain)).toBe(plain);
  });

  test("escapes only the reserved chars in mixed text", () => {
    const input = "example.com (test)!";
    const out = escapeMarkdownV2(input);
    // Each of . ( ) ! gets a leading backslash.
    expect(out).toBe("example\\.com \\(test\\)\\!");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// sendMessage — fetch mocks
// ───────────────────────────────────────────────────────────────────────────

function mockJsonResponse(
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSequencedFetcher(
  responses: Array<() => Response>,
): { fetcher: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let idx = 0;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const make = responses[idx];
    idx++;
    if (!make) {
      throw new Error(
        `mock fetcher exhausted at call ${idx} (have ${responses.length} responses)`,
      );
    }
    return make();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("sendMessage", () => {
  test("happy path returns messageId", async () => {
    const { fetcher, calls } = makeSequencedFetcher([
      () =>
        mockJsonResponse(200, { ok: true, result: { message_id: 42 } }),
    ]);
    const result = await sendMessage("hello", {
      botToken: FAKE_TOKEN,
      chatId: FAKE_CHAT_ID,
      fetcher,
      sleep: async () => {},
    });
    expect(result.messageId).toBe(42);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain(`/bot${FAKE_TOKEN}/sendMessage`);
    const body = JSON.parse(String(calls[0]?.init.body ?? "{}"));
    // Telegram accepts chat_id as string or int; we normalize to string for
    // wire stability (the FormData branch must already be string).
    expect(body.chat_id).toBe(String(FAKE_CHAT_ID));
    expect(body.text).toBe("hello");
  });

  test("sends MarkdownV2 parse_mode when requested", async () => {
    const { fetcher, calls } = makeSequencedFetcher([
      () => mockJsonResponse(200, { ok: true, result: { message_id: 1 } }),
    ]);
    await sendMessage("*bold*", {
      botToken: FAKE_TOKEN,
      chatId: FAKE_CHAT_ID,
      parseMode: "MarkdownV2",
      disableWebPagePreview: true,
      fetcher,
      sleep: async () => {},
    });
    const body = JSON.parse(String(calls[0]?.init.body ?? "{}"));
    expect(body.parse_mode).toBe("MarkdownV2");
    expect(body.disable_web_page_preview).toBe(true);
  });

  test("429 with retry_after retries then succeeds", async () => {
    const sleepCalls: number[] = [];
    const { fetcher, calls } = makeSequencedFetcher([
      () =>
        mockJsonResponse(429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 2 },
        }),
      () => mockJsonResponse(200, { ok: true, result: { message_id: 7 } }),
    ]);
    const result = await sendMessage("hi", {
      botToken: FAKE_TOKEN,
      chatId: FAKE_CHAT_ID,
      fetcher,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(result.messageId).toBe(7);
    expect(calls.length).toBe(2);
    expect(sleepCalls.length).toBe(1);
    expect(sleepCalls[0]).toBe(2_000);
  });

  test("5xx retries with exponential backoff and eventually succeeds", async () => {
    const sleepCalls: number[] = [];
    const { fetcher, calls } = makeSequencedFetcher([
      () => mockJsonResponse(500, { ok: false, description: "boom" }),
      () => mockJsonResponse(502, { ok: false, description: "boom" }),
      () => mockJsonResponse(503, { ok: false, description: "boom" }),
      () => mockJsonResponse(200, { ok: true, result: { message_id: 11 } }),
    ]);
    const result = await sendMessage("hi", {
      botToken: FAKE_TOKEN,
      chatId: FAKE_CHAT_ID,
      fetcher,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(result.messageId).toBe(11);
    expect(calls.length).toBe(4);
    // Backoff doubles: 1s, 2s, 4s before the 4th (success) call.
    expect(sleepCalls).toEqual([1_000, 2_000, 4_000]);
  });

  test("5xx persisting exhausts 5 attempts and throws", async () => {
    const sleepCalls: number[] = [];
    const { fetcher, calls } = makeSequencedFetcher([
      () => mockJsonResponse(500, { ok: false, description: "x" }),
      () => mockJsonResponse(500, { ok: false, description: "x" }),
      () => mockJsonResponse(500, { ok: false, description: "x" }),
      () => mockJsonResponse(500, { ok: false, description: "x" }),
      () => mockJsonResponse(500, { ok: false, description: "x" }),
    ]);
    await expect(
      sendMessage("hi", {
        botToken: FAKE_TOKEN,
        chatId: FAKE_CHAT_ID,
        fetcher,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      }),
    ).rejects.toBeInstanceOf(TelegramSendError);
    expect(calls.length).toBe(5);
    // 4 sleeps between 5 attempts (none after the final failed attempt).
    expect(sleepCalls.length).toBe(4);
  });

  test("400 bad request is permanent — no retry, throws immediately", async () => {
    const sleepCalls: number[] = [];
    const { fetcher, calls } = makeSequencedFetcher([
      () =>
        mockJsonResponse(400, {
          ok: false,
          error_code: 400,
          description: "Bad Request: chat not found",
        }),
    ]);
    let thrown: unknown = null;
    try {
      await sendMessage("hi", {
        botToken: FAKE_TOKEN,
        chatId: FAKE_CHAT_ID,
        fetcher,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TelegramSendError);
    expect(calls.length).toBe(1);
    expect(sleepCalls.length).toBe(0);
  });

  test("missing bot token throws TelegramSendError", async () => {
    await expect(
      sendMessage("hi", {
        botToken: "",
        chatId: FAKE_CHAT_ID,
        fetcher: (async () => mockJsonResponse(200, { ok: true })) as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(TelegramSendError);
  });

  test("missing chatId throws TelegramSendError", async () => {
    await expect(
      sendMessage("hi", {
        botToken: FAKE_TOKEN,
        chatId: "",
        fetcher: (async () => mockJsonResponse(200, { ok: true })) as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(TelegramSendError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// sendDocument
// ───────────────────────────────────────────────────────────────────────────

describe("sendDocument", () => {
  test("happy path: multipart POST returns messageId", async () => {
    const { fetcher, calls } = makeSequencedFetcher([
      () =>
        mockJsonResponse(200, {
          ok: true,
          result: { message_id: 101 },
        }),
    ]);
    const buf = Buffer.from("%PDF-1.4 fake content");
    const result = await sendDocument(buf, "report.pdf", "caption", {
      botToken: FAKE_TOKEN,
      chatId: FAKE_CHAT_ID,
      parseMode: "MarkdownV2",
      fetcher,
      sleep: async () => {},
    });
    expect(result.messageId).toBe(101);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain(`/bot${FAKE_TOKEN}/sendDocument`);
    // Multipart bodies are FormData; bun's fetch leaves it as-is.
    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
    const form = calls[0]?.init.body as FormData;
    expect(form.get("chat_id")).toBe(String(FAKE_CHAT_ID));
    expect(form.get("caption")).toBe("caption");
    expect(form.get("parse_mode")).toBe("MarkdownV2");
    expect(form.get("document")).toBeInstanceOf(Blob);
  });

  test("429 retry on sendDocument honors retry_after", async () => {
    const sleepCalls: number[] = [];
    const { fetcher, calls } = makeSequencedFetcher([
      () =>
        mockJsonResponse(429, {
          ok: false,
          error_code: 429,
          parameters: { retry_after: 1 },
        }),
      () =>
        mockJsonResponse(200, { ok: true, result: { message_id: 5 } }),
    ]);
    const buf = Buffer.from("pdf");
    const result = await sendDocument(buf, "r.pdf", undefined, {
      botToken: FAKE_TOKEN,
      chatId: FAKE_CHAT_ID,
      fetcher,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(result.messageId).toBe(5);
    expect(calls.length).toBe(2);
    expect(sleepCalls).toEqual([1_000]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// createTelegramNotifier — TelegramNotifier interface
// ───────────────────────────────────────────────────────────────────────────

describe("createTelegramNotifier.sendScanComplete", () => {
  const findingsCount = {
    critical: 1,
    high: 2,
    medium: 3,
    low: 4,
    informational: 5,
  };

  test("without PDF → calls sendMessage with MarkdownV2-escaped text", async () => {
    const { fetcher, calls } = makeSequencedFetcher([
      () =>
        mockJsonResponse(200, { ok: true, result: { message_id: 77 } }),
    ]);
    const notifier = createTelegramNotifier({
      botToken: FAKE_TOKEN,
      fetcher,
      sleep: async () => {},
    });
    const result = await notifier.sendScanComplete({
      chatId: FAKE_CHAT_ID,
      scanOrderId: "ORDER01",
      scanId: "SCAN01",
      // Contains MarkdownV2-reserved char that MUST be escaped.
      primaryDomain: "example.com",
      findingsCount,
    });
    expect(result.messageId).toBe(77);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain("/sendMessage");
    const body = JSON.parse(String(calls[0]?.init.body ?? "{}"));
    expect(body.parse_mode).toBe("MarkdownV2");
    // Domain has the `.` escaped per MarkdownV2.
    expect(body.text).toContain("example\\.com");
    // Severity counts are rendered.
    expect(body.text).toContain("Critical: 1");
    expect(body.text).toContain("High: 2");
    expect(body.text).toContain("Medium: 3");
    expect(body.text).toContain("Low: 4");
    expect(body.text).toContain("Info: 5");
  });

  test("with PDF → calls sendDocument with the PDF buffer", async () => {
    const { fetcher, calls } = makeSequencedFetcher([
      () =>
        mockJsonResponse(200, { ok: true, result: { message_id: 808 } }),
    ]);
    const notifier = createTelegramNotifier({
      botToken: FAKE_TOKEN,
      fetcher,
      sleep: async () => {},
    });
    const pdf = Buffer.from("%PDF-1.4 fixture content");
    const result = await notifier.sendScanComplete({
      chatId: FAKE_CHAT_ID,
      scanOrderId: "ORDER02",
      scanId: "SCAN02",
      primaryDomain: "acme-test.io",
      findingsCount,
      reportPdfBuffer: pdf,
      reportPdfFilename: "tensol-report-RP01.pdf",
    });
    expect(result.messageId).toBe(808);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain("/sendDocument");
    const form = calls[0]?.init.body as FormData;
    expect(form.get("chat_id")).toBe(String(FAKE_CHAT_ID));
    expect(form.get("parse_mode")).toBe("MarkdownV2");
    // Caption present + has escaped domain.
    const caption = String(form.get("caption") ?? "");
    expect(caption).toContain("acme\\-test\\.io");
    expect(caption).toContain("Critical: 1");
    // Document attached as a Blob with the right filename.
    const doc = form.get("document") as Blob & { name?: string };
    expect(doc).toBeInstanceOf(Blob);
    // FormData filename access is via the file name in append; bun's Blob
    // doesn't expose .name on the retrieved object reliably, so just assert
    // a non-empty document part.
    expect(doc.size).toBe(pdf.byteLength);
  });

  test("escapes special chars in primaryDomain (e.g. underscore) for MarkdownV2", async () => {
    const { fetcher, calls } = makeSequencedFetcher([
      () => mockJsonResponse(200, { ok: true, result: { message_id: 9 } }),
    ]);
    const notifier = createTelegramNotifier({
      botToken: FAKE_TOKEN,
      fetcher,
      sleep: async () => {},
    });
    await notifier.sendScanComplete({
      chatId: FAKE_CHAT_ID,
      scanOrderId: "ORDER03",
      scanId: "SCAN03",
      primaryDomain: "foo_bar.example.com",
      findingsCount,
    });
    const body = JSON.parse(String(calls[0]?.init.body ?? "{}"));
    expect(body.text).toContain("foo\\_bar\\.example\\.com");
  });
});
