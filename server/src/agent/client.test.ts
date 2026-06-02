import { describe, expect, test } from "bun:test";

import {
  AgentApiError,
  createHttpSthripAgentClient,
  createHttpSthripAgentClientFromEnv,
} from "./client.ts";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createHttpSthripAgentClient", () => {
  test("normalizes API URL, sends bearer auth, and posts whitebox body", async () => {
    const calls: FetchCall[] = [];
    const client = createHttpSthripAgentClient({
      apiUrl: "https://api.sthrip.dev",
      apiToken: "sthrip_token",
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Promise.resolve(
          jsonResponse(202, {
            review_id: "01REV",
            job_id: "01JOB",
            status: "queued",
          }),
        );
      }) as typeof fetch,
    });

    const result = await client.startWhitebox({
      repo: "acme/api",
      ref: "main",
      mode: "deep",
    });

    expect(result).toEqual({ review_id: "01REV", job_id: "01JOB", status: "queued" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.sthrip.dev/v1/agent/whitebox");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer sthrip_token",
    );
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(calls[0]!.init.body).toBe(
      JSON.stringify({ repo: "acme/api", ref: "main", mode: "deep" }),
    );
  });

  test("does not duplicate /v1/agent when base URL already includes it", async () => {
    const calls: FetchCall[] = [];
    const client = createHttpSthripAgentClient({
      apiUrl: "https://api.sthrip.dev/v1/agent/",
      apiToken: "sthrip_token",
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }) as typeof fetch,
    });

    await client.health();

    expect(calls[0]!.url).toBe("https://api.sthrip.dev/v1/agent/health");
  });

  test("throws AgentApiError with status and parsed body on non-2xx", async () => {
    const client = createHttpSthripAgentClient({
      apiUrl: "https://api.sthrip.dev",
      apiToken: "sthrip_token",
      fetchImpl: (() =>
        Promise.resolve(
          jsonResponse(404, { error: "not_found", message: "missing review" }),
        )) as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.getReview("missing");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentApiError);
    expect((caught as AgentApiError).status).toBe(404);
    expect((caught as AgentApiError).body).toEqual({
      error: "not_found",
      message: "missing review",
    });
  });

  test("createHttpSthripAgentClientFromEnv requires URL and token", () => {
    const oldUrl = process.env.STHRIP_API_URL;
    const oldToken = process.env.STHRIP_API_TOKEN;
    delete process.env.STHRIP_API_URL;
    delete process.env.STHRIP_API_TOKEN;
    try {
      expect(() => createHttpSthripAgentClientFromEnv()).toThrow("STHRIP_API_URL");
      process.env.STHRIP_API_URL = "https://api.sthrip.dev";
      expect(() => createHttpSthripAgentClientFromEnv()).toThrow("STHRIP_API_TOKEN");
    } finally {
      if (oldUrl !== undefined) process.env.STHRIP_API_URL = oldUrl;
      else delete process.env.STHRIP_API_URL;
      if (oldToken !== undefined) process.env.STHRIP_API_TOKEN = oldToken;
      else delete process.env.STHRIP_API_TOKEN;
    }
  });
});
