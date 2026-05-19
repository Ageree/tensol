/**
 * T042 — Tests for `yandex-operations.ts` (T041).
 *
 * All polling is exercised with injected `sleep`/`now` so the suite runs in
 * milliseconds and does NOT consume real wall-clock time. Constitution VI:
 * fake provider by default; real Yandex Operations API never touched here.
 */

import { describe, expect, test } from "bun:test";

import {
  pollOperation,
  type Operation,
  type PollOperationOpts,
} from "./yandex-operations";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

function makeFetchMock(responses: Operation[] | ((idx: number) => Response)): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else {
        for (const [k, v] of Object.entries(
          h as Record<string, string>,
        ))
          headers[k.toLowerCase()] = String(v);
      }
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const idx = calls.length;
    calls.push({ url, method, headers });
    if (typeof responses === "function") return responses(idx);
    const op = responses[idx] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(op), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const OP_URL_BASE = "https://operation.api.cloud.yandex.net/operations";

describe("pollOperation — happy paths", () => {
  test("returns Operation immediately when done:true on first poll", async () => {
    const op: Operation = {
      id: "op-1",
      done: true,
      response: { instanceId: "vm-1" },
    };
    const { fetchImpl, calls } = makeFetchMock([op]);
    const result = await pollOperation("op-1", {
      fetcher: fetchImpl,
      sleep: async () => {},
      getToken: async () => "fake-token",
      now: () => 0,
    });
    expect(result).toEqual(op);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${OP_URL_BASE}/op-1`);
  });

  test("polls with exponential backoff 1→2→4→8→8 seconds", async () => {
    const ops: Operation[] = [
      { id: "op-1", done: false },
      { id: "op-1", done: false },
      { id: "op-1", done: false },
      { id: "op-1", done: false },
      { id: "op-1", done: false },
      { id: "op-1", done: true, response: { teardownComplete: true } },
    ];
    const { fetchImpl } = makeFetchMock(ops);
    const sleeps: number[] = [];
    let nowMs = 0;
    const opts: PollOperationOpts = {
      fetcher: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      getToken: async () => "fake-token",
      now: () => nowMs,
    };
    const result = await pollOperation("op-1", opts);
    expect(result.done).toBe(true);
    // 6 polls total → 5 sleeps between them.
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  test("returns op with done:true even when error field is set (caller decides)", async () => {
    const op: Operation = {
      id: "op-err",
      done: true,
      error: { code: 13, message: "INTERNAL" },
    };
    const { fetchImpl } = makeFetchMock([op]);
    const result = await pollOperation("op-err", {
      fetcher: fetchImpl,
      sleep: async () => {},
      getToken: async () => "fake-token",
      now: () => 0,
    });
    expect(result.done).toBe(true);
    expect(result.error?.code).toBe(13);
  });
});

describe("pollOperation — auth header", () => {
  test("uses Bearer <iamToken> on each request", async () => {
    const ops: Operation[] = [
      { id: "op-1", done: false },
      { id: "op-1", done: true },
    ];
    const { fetchImpl, calls } = makeFetchMock(ops);
    let nowMs = 0;
    await pollOperation("op-1", {
      fetcher: fetchImpl,
      sleep: async (ms) => {
        nowMs += ms;
      },
      getToken: async () => "iam-token-xyz",
      now: () => nowMs,
    });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.headers.authorization).toBe("Bearer iam-token-xyz");
    }
  });

  test("calls getToken before every request (covers token rotation)", async () => {
    const ops: Operation[] = [
      { id: "op-1", done: false },
      { id: "op-1", done: false },
      { id: "op-1", done: true },
    ];
    const { fetchImpl } = makeFetchMock(ops);
    let tokenCalls = 0;
    let nowMs = 0;
    await pollOperation("op-1", {
      fetcher: fetchImpl,
      sleep: async (ms) => {
        nowMs += ms;
      },
      getToken: async () => {
        tokenCalls++;
        return `iam-${tokenCalls}`;
      },
      now: () => nowMs,
    });
    expect(tokenCalls).toBe(3);
  });
});

describe("pollOperation — timeout", () => {
  test("throws when total elapsed exceeds timeoutMs (default 10 min)", async () => {
    let nowMs = 0;
    const { fetchImpl, calls } = makeFetchMock(() =>
      new Response(JSON.stringify({ id: "op-1", done: false }), {
        status: 200,
      }),
    );
    await expect(
      pollOperation("op-1", {
        fetcher: fetchImpl,
        sleep: async (ms) => {
          nowMs += ms;
        },
        getToken: async () => "tok",
        now: () => nowMs,
        timeoutMs: 10 * 60 * 1000,
      }),
    ).rejects.toThrow(/timeout/);
    // Should have polled many times before bailing.
    expect(calls.length).toBeGreaterThan(10);
  });

  test("respects custom shorter timeoutMs", async () => {
    let nowMs = 0;
    const { fetchImpl } = makeFetchMock(() =>
      new Response(JSON.stringify({ id: "op-1", done: false }), {
        status: 200,
      }),
    );
    await expect(
      pollOperation("op-1", {
        fetcher: fetchImpl,
        sleep: async (ms) => {
          nowMs += ms;
        },
        getToken: async () => "tok",
        now: () => nowMs,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/timeout/);
  });
});

describe("pollOperation — HTTP errors", () => {
  test("throws on non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      pollOperation("op-1", {
        fetcher: fetchImpl,
        sleep: async () => {},
        getToken: async () => "tok",
        now: () => 0,
      }),
    ).rejects.toThrow(/500/);
  });
});
