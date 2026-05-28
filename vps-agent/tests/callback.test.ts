import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { sendCallback, type CallbackPayload } from "../src/callback.ts";

/**
 * Build a minimal valid payload that satisfies the webhook contract shape.
 */
function makePayload(overrides: Partial<CallbackPayload> = {}): CallbackPayload {
  return {
    scan_id: "01JBVPSCAN0000000000000001",
    status: "done",
    failure_reason: null,
    usage: { tokens: 1234, usd_cents: 56 },
    findings: [],
    ...overrides,
  };
}

/**
 * Mock fetch factory. Each call to the returned `fetchImpl` either returns the
 * next queued response (status code) or throws the next queued error. The
 * `calls` array records every invocation for assertion.
 */
type FetchCall = { url: string; init: RequestInit };

function makeFetch(
  responses: Array<{ status: number } | { throws: Error }>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (r === undefined) {
      throw new Error("mock fetch: no responses queued");
    }
    if ("throws" in r) {
      throw r.throws;
    }
    return new Response(null, { status: r.status });
  };
  return { fetchImpl, calls };
}

const NOOP_SLEEP = async (_ms: number) => {};

describe("sendCallback", () => {
  test("happy path: 200 → ok=true, attempts=1, sig header set", async () => {
    const payload = makePayload();
    const signKey = "Jefe";
    const { fetchImpl, calls } = makeFetch([{ status: 200 }]);

    const result = await sendCallback({
      webhookUrl: "https://backend.example.com/webhooks/scan-progress",
      signKey,
      payload,
      fetchImpl,
      sleep: NOOP_SLEEP,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.attempts).toBe(1);
    expect(result.status).toBe(200);
    expect(calls.length).toBe(1);

    const sentBody = calls[0]!.init.body as string;
    const expectedSig = createHmac("sha256", signKey)
      .update(sentBody)
      .digest("hex");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Tensol-Signature"]).toBe(expectedSig);
  });

  test("raw-body sig matches HMAC over exact serialized body", async () => {
    const payload = makePayload({ scan_id: "01ABCDEF" });
    const signKey = "test-sign-key-1234567890";
    const { fetchImpl, calls } = makeFetch([{ status: 200 }]);

    await sendCallback({
      webhookUrl: "https://backend/webhook",
      signKey,
      payload,
      fetchImpl,
      sleep: NOOP_SLEEP,
    });

    const rawBody = calls[0]!.init.body as string;
    // The raw body must be valid JSON and round-trip to the payload.
    expect(JSON.parse(rawBody)).toEqual(payload);
    // Signature is HMAC over the exact bytes sent on the wire.
    const sig = createHmac("sha256", signKey).update(rawBody).digest("hex");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Tensol-Signature"]).toBe(sig);
  });

  test("5xx retried with exponential backoff (1s/5s) then 200", async () => {
    const payload = makePayload();
    const { fetchImpl, calls } = makeFetch([
      { status: 500 },
      { status: 503 },
      { status: 200 },
    ]);
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };

    const result = await sendCallback({
      webhookUrl: "https://backend/webhook",
      signKey: "k",
      payload,
      fetchImpl,
      sleep,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.attempts).toBe(3);
    expect(calls.length).toBe(3);
    // Two backoffs between three attempts: 1000ms, 5000ms.
    expect(slept).toEqual([1000, 5000]);
  });

  test("4xx is not retried (auth/signature errors don't self-heal)", async () => {
    const payload = makePayload();
    const { fetchImpl, calls } = makeFetch([{ status: 401 }]);

    const result = await sendCallback({
      webhookUrl: "https://backend/webhook",
      signKey: "k",
      payload,
      fetchImpl,
      sleep: NOOP_SLEEP,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.attempts).toBe(1);
    expect(result.lastStatus).toBe(401);
    expect(calls.length).toBe(1);
  });

  test("max retries exhausted: all 500 → ok=false, attempts=maxAttempts", async () => {
    const payload = makePayload();
    const { fetchImpl, calls } = makeFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);

    const result = await sendCallback({
      webhookUrl: "https://backend/webhook",
      signKey: "k",
      payload,
      fetchImpl,
      sleep: NOOP_SLEEP,
      maxAttempts: 5,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.attempts).toBe(5);
    expect(result.lastStatus).toBe(500);
    expect(calls.length).toBe(5);
  });

  test("network errors are retried; final error captured in lastError", async () => {
    const payload = makePayload();
    const netErr = new Error("ECONNRESET");
    const { fetchImpl, calls } = makeFetch([
      { throws: netErr },
      { throws: netErr },
      { throws: netErr },
    ]);

    const result = await sendCallback({
      webhookUrl: "https://backend/webhook",
      signKey: "k",
      payload,
      fetchImpl,
      sleep: NOOP_SLEEP,
      maxAttempts: 3,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.attempts).toBe(3);
    expect(result.lastError).toContain("ECONNRESET");
    expect(calls.length).toBe(3);
  });

  test("HMAC matches RFC 4231 test case 2 (Jefe / 'what do ya want for nothing?')", async () => {
    // Direct check: hmac of a known string with key "Jefe" → expected hex digest.
    // We invoke sendCallback by crafting a payload whose JSON.stringify equals
    // the RFC 4231 message — easier: just verify hmac by parallel computation
    // here and compare against the same routine sendCallback uses.
    const key = "Jefe";
    const data = "what do ya want for nothing?";
    const expected =
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
    const actual = createHmac("sha256", key).update(data).digest("hex");
    expect(actual).toBe(expected);

    // And: a payload sent through sendCallback gets signed with the same routine.
    const payload = makePayload();
    const { fetchImpl, calls } = makeFetch([{ status: 200 }]);
    await sendCallback({
      webhookUrl: "https://backend/webhook",
      signKey: key,
      payload,
      fetchImpl,
      sleep: NOOP_SLEEP,
    });
    const body = calls[0]!.init.body as string;
    const expectedSig = createHmac("sha256", key).update(body).digest("hex");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Tensol-Signature"]).toBe(expectedSig);
  });

  test("headers shape: Content-Type + X-Tensol-Scan-Id + X-Tensol-Signature", async () => {
    const payload = makePayload({ scan_id: "01HEADERSHAPE000000000000" });
    const { fetchImpl, calls } = makeFetch([{ status: 200 }]);

    await sendCallback({
      webhookUrl: "https://backend/webhook",
      signKey: "k",
      payload,
      fetchImpl,
      sleep: NOOP_SLEEP,
    });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Tensol-Scan-Id"]).toBe("01HEADERSHAPE000000000000");
    expect(typeof headers["X-Tensol-Signature"]).toBe("string");
    expect(headers["X-Tensol-Signature"]!.length).toBe(64); // 32 bytes hex
    expect(calls[0]!.init.method).toBe("POST");
  });

  test("exponential backoff schedule 1s/5s/25s/125s", async () => {
    const payload = makePayload();
    const { fetchImpl } = makeFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };

    const result = await sendCallback({
      webhookUrl: "https://backend/webhook",
      signKey: "k",
      payload,
      fetchImpl,
      sleep,
      maxAttempts: 5,
      initialDelayMs: 1000,
    });

    expect(result.ok).toBe(false);
    // 4 sleeps between 5 attempts: 1s, 5s, 25s, 125s
    expect(slept).toEqual([1000, 5000, 25000, 125000]);
  });
});
