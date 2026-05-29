/**
 * Tests for the OpenRouter LLM client adapter.
 *
 * A fake fetch is injected to assert the outgoing request shape (URL, auth
 * header, JSON body with model/messages/temperature/response_format) and to
 * verify the client returns choices[0].message.content and throws a clear
 * error on non-2xx responses. No real network.
 */
import { test, expect, describe } from "bun:test";
import { createOpenRouterClient } from "./openrouter.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const okBody = {
  choices: [{ message: { role: "assistant", content: '{"summary":"ok","verdicts":[]}' } }],
};

describe("createOpenRouterClient", () => {
  test("posts the correct request shape and returns the content", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse(okBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "sk-test-123",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "qwen/qwen3.7-max",
      fetchImpl: fakeFetch,
    });

    const content = await client.complete({ system: "SYS", user: "USR" });
    expect(content).toBe('{"summary":"ok","verdicts":[]}');

    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe("qwen/qwen3.7-max");
    expect(body.temperature).toBe(0.1);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USR" },
    ]);
  });

  test("honors a custom temperature", async () => {
    let body: any;
    const fakeFetch = (async (_url: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(okBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
      temperature: 0.7,
    });
    await client.complete({ system: "a", user: "b" });
    expect(body.temperature).toBe(0.7);
  });

  test("trims a trailing slash on baseUrl", async () => {
    let url = "";
    const fakeFetch = (async (u: any) => {
      url = String(u);
      return jsonResponse(okBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1/",
      model: "m",
      fetchImpl: fakeFetch,
    });
    await client.complete({ system: "a", user: "b" });
    expect(url).toBe("https://x/v1/chat/completions");
  });

  test("throws a clear error on 401", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: "invalid key" }, 401)) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "bad",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });
    await expect(client.complete({ system: "a", user: "b" })).rejects.toThrow(
      /openrouter.*401/i,
    );
  });

  test("throws when response has no choices", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ choices: [] })) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });
    await expect(client.complete({ system: "a", user: "b" })).rejects.toThrow(
      /no completion|choices/i,
    );
  });

  test("aborts and throws a timeout error when the upstream never responds", async () => {
    // Fake an upstream that hangs forever but honors the AbortSignal (as the
    // real `fetch` does) — rejecting once aborted.
    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }
      })) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: hangingFetch,
      timeoutMs: 20,
    });
    await expect(client.complete({ system: "a", user: "b" })).rejects.toThrow(
      /timed out after 20ms/,
    );
  });

  test("passes an AbortSignal to fetch", async () => {
    let sawSignal = false;
    const fakeFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return jsonResponse(okBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });
    await client.complete({ system: "a", user: "b" });
    expect(sawSignal).toBe(true);
  });
});
