import { describe, expect, test } from "bun:test";

import { parseJsonRpcMessage } from "./protocol.ts";
import {
  createHttpSthripAgentClient,
  createSthripMcpServer,
  runMcpMain,
  runMcpStdioServer,
  type SthripAgentClient,
} from "./server.ts";

function makeFakeClient(): SthripAgentClient {
  return {
    health: async () => ({ ok: true, service: "sthrip" }),
    listReviews: async () => ({ reviews: [{ review_id: "rev_1", status: "queued" }] }),
    getReview: async (reviewId) => ({ id: reviewId, status: "queued" }),
    listFindings: async (reviewId) => ({ review_id: reviewId, findings: [] }),
    startWhitebox: async (args) => ({ review_id: "rev_new", job_id: "job_new", args }),
    getJob: async (jobId) => ({ job_id: jobId, status: "pending" }),
  };
}

async function collectResponses(
  client: SthripAgentClient,
  ...lines: string[]
) {
  const writes: string[] = [];
  const out: Array<unknown> = [];

  async function* input() {
    for (const line of lines) {
      yield `${line}\n`;
    }
  }

  await runMcpStdioServer({
    client,
    input: input(),
    write: (chunk) => {
      writes.push(chunk);
    },
    log: () => {},
  });

  for (const response of writes) {
    out.push(parseJsonRpcMessage(response.trim()));
  }

  return out;
}

function responseById(responses: unknown[], id: number) {
  const response = responses.find((message: any) => message.id === id);
  expect(response).toBeDefined();
  return response as any;
}

function responsesByErrorCode(responses: unknown[], code: number) {
  return responses.filter((message: any) => message.error?.code === code);
}

describe("createHttpSthripAgentClient", () => {
  test("targets /v1/agent with bearer auth and forwards JSON bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = createHttpSthripAgentClient({
      apiUrl: "https://api.sthrip.local",
      apiToken: "secret-token",
      fetchImpl: fakeFetch,
    });

    await client.startWhitebox({ repo: "acme/api", mode: "fast" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.sthrip.local/v1/agent/whitebox");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer secret-token",
    );
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      repo: "acme/api",
      mode: "fast",
    });
  });
});

describe("createSthripMcpServer", () => {
  test("implements initialize, tools/list, ping, and tool calls", async () => {
    const client = makeFakeClient();
    const server = createSthripMcpServer({ client });
    expect(server.constructor.name).toBe("McpServer");

    const responses = await collectResponses(
      client,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "sthrip_health" },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "sthrip_get_review",
          arguments: { review_id: "rev_123" },
        },
      }),
    );
    const init = responseById(responses, 1);
    const listed = responseById(responses, 2);
    const ping = responseById(responses, 3);
    const healthCall = responseById(responses, 4);
    const reviewCall = responseById(responses, 5);

    expect(init).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sthrip-agent-api" },
      },
    });

    const listResult = (listed as { result: { tools: Array<{ name: string }> } }).result;
    expect(listResult.tools.map((tool) => tool.name)).toEqual([
      "sthrip_health",
      "sthrip_list_reviews",
      "sthrip_get_review",
      "sthrip_list_findings",
      "sthrip_start_whitebox",
      "sthrip_get_job",
    ]);
    const whiteboxTool = listResult.tools.find(
      (tool) => tool.name === "sthrip_start_whitebox",
    ) as { inputSchema?: unknown } | undefined;
    expect(whiteboxTool?.inputSchema).toMatchObject({
      anyOf: [{ required: ["repo_id"] }, { required: ["repo"] }],
    });

    expect(ping).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    expect((healthCall as any).result.structuredContent).toEqual({
      ok: true,
      service: "sthrip",
    });
    expect((reviewCall as any).result.structuredContent).toEqual({
      id: "rev_123",
      status: "queued",
    });
    expect((reviewCall as any).result.content[0].text).toContain('"id":"rev_123"');
  });

  test("routes every Sthrip tool through the Skybridge MCP handler", async () => {
    const client = makeFakeClient();

    const responses = await collectResponses(
      client,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sthrip_health" },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "sthrip_list_reviews" },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "sthrip_get_review",
          arguments: { review_id: "rev_123" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "sthrip_list_findings",
          arguments: { review_id: "rev_123" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "sthrip_start_whitebox",
          arguments: { repo: "acme/api", ref: "main", mode: "deep" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "sthrip_get_job",
          arguments: { job_id: "job_123" },
        },
      }),
    );
    const healthCall = responseById(responses, 2);
    const listReviewsCall = responseById(responses, 3);
    const reviewCall = responseById(responses, 4);
    const findingsCall = responseById(responses, 5);
    const whiteboxCall = responseById(responses, 6);
    const jobCall = responseById(responses, 7);

    expect((healthCall as any).result.structuredContent).toEqual({
      ok: true,
      service: "sthrip",
    });
    expect((listReviewsCall as any).result.structuredContent).toEqual({
      reviews: [{ review_id: "rev_1", status: "queued" }],
    });
    expect((reviewCall as any).result.structuredContent).toEqual({
      id: "rev_123",
      status: "queued",
    });
    expect((findingsCall as any).result.structuredContent).toEqual({
      review_id: "rev_123",
      findings: [],
    });
    expect((whiteboxCall as any).result.structuredContent).toEqual({
      review_id: "rev_new",
      job_id: "job_new",
      args: { repo: "acme/api", ref: "main", mode: "deep" },
    });
    expect((jobCall as any).result.structuredContent).toEqual({
      job_id: "job_123",
      status: "pending",
    });
  });

  test("returns protocol errors for invalid JSON-RPC and invalid tool arguments", async () => {
    const client = makeFakeClient();

    const responses = await collectResponses(
      client,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "{bad json",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "sthrip_get_job", arguments: {} },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 11, method: "nope" }),
      JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: { bad: true }, method: "ping" }),
    );
    const parseError = responsesByErrorCode(responses, -32700)[0];
    const argError = responseById(responses, 10);
    const methodError = responseById(responses, 11);
    const invalidRequestErrors = responsesByErrorCode(responses, -32600);

    expect(parseError).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
    expect(argError).toMatchObject({
      jsonrpc: "2.0",
      id: 10,
      error: { code: -32602 },
    });
    expect(methodError).toMatchObject({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32601 },
    });
    expect(invalidRequestErrors).toHaveLength(2);
    expect(invalidRequestErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jsonrpc: "2.0", id: null }),
        expect.objectContaining({ jsonrpc: "2.0", id: null }),
      ]),
    );
  });

  test("enforces initialize lifecycle before tools are available", async () => {
    const client = makeFakeClient();

    const responses = await collectResponses(
      client,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
    );
    const preInitList = responseById(responses, 1);
    const ping = responseById(responses, 2);
    const init = responseById(responses, 3);
    const preInitializedList = responseById(responses, 4);
    const postInitializedList = responseById(responses, 5);

    expect(preInitList).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32002 },
    });
    expect(ping).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(init).toMatchObject({ jsonrpc: "2.0", id: 3, result: {} });
    expect(preInitializedList).toMatchObject({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32002 },
    });
    expect((postInitializedList as any).result.tools).toHaveLength(6);
  });

  test("returns tool execution failures inside a CallToolResult", async () => {
    const client = {
      ...makeFakeClient(),
      getJob: async () => {
        throw new Error("upstream failed");
      },
    };

    const responses = await collectResponses(
      client,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "sthrip_get_job",
          arguments: { job_id: "job_1" },
        },
      }),
    );
    const response = responseById(responses, 20);

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 20,
      result: {
        isError: true,
        structuredContent: { message: "upstream failed" },
      },
    });
  });
});

describe("runMcpStdioServer", () => {
  test("reads chunked stdin and writes newline-delimited JSON-RPC to stdout only", async () => {
    const writes: string[] = [];
    const logs: string[] = [];

    async function* input() {
      yield '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n';
      yield '{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.';
      yield '0","id":3,"method":"tools/list"}\n';
    }

    await runMcpStdioServer({
      client: makeFakeClient(),
      input: input(),
      write: async (chunk) => {
        writes.push(chunk);
      },
      log: (line) => {
        logs.push(line);
      },
    });

    expect(logs).toEqual([]);
    expect(writes).toHaveLength(3);
    expect(writes[0]!.endsWith("\n")).toBe(true);
    expect(writes[1]!.endsWith("\n")).toBe(true);
    expect(writes[2]!.endsWith("\n")).toBe(true);

    const parsed = writes.map((line) => parseJsonRpcMessage(line.trim()));
    expect(responseById(parsed, 1)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    expect(responseById(parsed, 2)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(responseById(parsed, 3).result.tools).toHaveLength(6);
  });

  test("continues reading stdin while a tool call is still in flight", async () => {
    const writes: string[] = [];
    let releaseHealth!: () => void;
    const healthCanFinish = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });

    async function* input() {
      yield [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "sthrip_health" },
        }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
      ].join("\n") + "\n";
    }

    const client = {
      ...makeFakeClient(),
      health: async () => {
        await healthCanFinish;
        return { ok: true, service: "sthrip" };
      },
    };

    const run = runMcpStdioServer({
      client,
      input: input(),
      write: async (chunk) => {
        writes.push(chunk);
        const message = parseJsonRpcMessage(chunk.trim());
        if ((message as any).id === 3) {
          releaseHealth();
        }
      },
      log: () => {},
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("stdio transport deadlocked")),
            1000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const parsed = writes.map((line) => parseJsonRpcMessage(line.trim()));
    expect(responseById(parsed, 3).result).toEqual({});
    expect(responseById(parsed, 2).result.structuredContent).toEqual({
      ok: true,
      service: "sthrip",
    });
  });

  test("main entrypoint reports env creation failures without throwing", async () => {
    const logs: string[] = [];
    const code = await runMcpMain({
      input: (async function* empty() {})(),
      write: () => {},
      log: (line) => logs.push(line),
      clientFactory: () => {
        throw new Error("STHRIP_API_URL is required");
      },
    });

    expect(code).toBe(1);
    expect(logs).toEqual(["mcp fatal: STHRIP_API_URL is required"]);
  });
});
