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
      model: "z-ai/glm-5.2",
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
    expect(body.model).toBe("z-ai/glm-5.2");
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

  test("jsonMode defaults to true -> response_format present", async () => {
    let body: any;
    const fakeFetch = (async (_url: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(okBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/api/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });
    await client.complete({ system: "s", user: "u" });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  test("jsonMode:false -> response_format omitted", async () => {
    let body: any;
    const fakeFetch = (async (_url: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(okBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/api/v1",
      model: "m",
      jsonMode: false,
      fetchImpl: fakeFetch,
    });
    await client.complete({ system: "s", user: "u" });
    expect(body.response_format).toBeUndefined();
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

describe("createOpenRouterClient.chat (tool calling)", () => {
  const toolCallBody = {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1234, completion_tokens: 56 },
  };

  const finalBody = {
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content: "done" } },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };

  test("serializes tools (type:function) + tool_choice, omits response_format", async () => {
    let body: any;
    const fakeFetch = (async (_u: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(toolCallBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "z-ai/glm-5.2",
      fetchImpl: fakeFetch,
    });

    await client.chat!({
      messages: [{ role: "user", content: "review a.ts" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      toolChoice: "auto",
    });

    expect(body.model).toBe("z-ai/glm-5.2");
    expect(body.response_format).toBeUndefined(); // tools ⇒ never json_object
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);
    expect(body.messages).toEqual([{ role: "user", content: "review a.ts" }]);
  });

  test("parses tool_calls + exact usage from the response", async () => {
    const fakeFetch = (async () => jsonResponse(toolCallBody)) as unknown as typeof fetch;
    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });

    const res = await client.chat!({ messages: [{ role: "user", content: "go" }] });
    expect(res.content).toBeNull();
    expect(res.toolCalls).toEqual([
      { id: "call_abc", name: "read_file", argumentsJson: '{"path":"a.ts"}' },
    ]);
    expect(res.usage).toEqual({ inputTokens: 1234, outputTokens: 56 });
  });

  test("returns final content with empty toolCalls when the model answers", async () => {
    const fakeFetch = (async () => jsonResponse(finalBody)) as unknown as typeof fetch;
    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });

    const res = await client.chat!({ messages: [{ role: "user", content: "go" }] });
    expect(res.content).toBe("done");
    expect(res.toolCalls).toEqual([]);
  });

  test("serializes assistant tool_calls + tool results back onto the wire", async () => {
    let body: any;
    const fakeFetch = (async (_u: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(finalBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });

    await client.chat!({
      messages: [
        { role: "system", content: "you review code" },
        { role: "user", content: "review a.ts" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call_abc", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
        },
        { role: "tool", toolCallId: "call_abc", content: "file body" },
      ],
    });

    expect(body.messages).toEqual([
      { role: "system", content: "you review code" },
      { role: "user", content: "review a.ts" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: "file body" },
    ]);
  });

  test("omits tools/tool_choice from the body when none are given", async () => {
    let body: any;
    const fakeFetch = (async (_u: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(finalBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });

    await client.chat!({ messages: [{ role: "user", content: "hi" }] });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test("serializes a forced tool_choice by name", async () => {
    let body: any;
    const fakeFetch = (async (_u: any, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(finalBody);
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });

    await client.chat!({
      messages: [{ role: "user", content: "hi" }],
      toolChoice: { name: "submit_findings" },
    });
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "submit_findings" },
    });
  });

  test("throws when a chat response has neither content nor tool_calls", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: null } }] })) as unknown as typeof fetch;
    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });
    await expect(
      client.chat!({ messages: [{ role: "user", content: "go" }] }),
    ).rejects.toThrow(/neither content nor tool_calls/i);
  });

  test("throws a clear error on a non-2xx chat response", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: "rate limited" }, 429)) as unknown as typeof fetch;
    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      fetchImpl: fakeFetch,
    });
    await expect(
      client.chat!({ messages: [{ role: "user", content: "go" }] }),
    ).rejects.toThrow(/openrouter.*429/i);
  });
});
