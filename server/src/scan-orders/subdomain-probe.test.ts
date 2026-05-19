import { describe, test, expect } from "bun:test";
import { discoverSubdomains } from "./subdomain-probe";

/**
 * T038 — tests for subdomain discovery via Certificate Transparency
 * (crt.sh). Mocks `fetch` via DI so the test suite stays offline and
 * deterministic. Cases are organised into:
 *
 *   - happy path: dedup, sort, normalize
 *   - www fallback: always present, no duplicate when crt.sh already
 *     emits it
 *   - filtering: primary excluded, wildcards skipped, cross-domain
 *     leak rejected (e.g. `evil.com` must not slip into a lookup of
 *     `example.com`)
 *   - cap: capN trims the result set
 *   - degradation: timeout / non-200 / fetch throw / empty array all
 *     return just the www fallback
 *
 * The fakeFetch helper returns a minimal `Response`-shaped object —
 * only `ok` and `json` are read by the implementation.
 */

type FakeFetcherArgs = Parameters<typeof fetch>;
type FakeFetcher = (...args: FakeFetcherArgs) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

const makeFetcher = (entries: Array<{ name_value: string }>, ok = true): FakeFetcher => {
  return async () => ({
    ok,
    json: async () => entries,
  });
};

describe("discoverSubdomains", () => {
  test("returns deduped, sorted subdomains from crt.sh", async () => {
    const fetcher = makeFetcher([
      { name_value: "www.example.com\napi.example.com" },
      { name_value: "api.example.com" }, // duplicate
      { name_value: "admin.example.com" },
    ]);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs).toEqual(["admin.example.com", "api.example.com", "www.example.com"]);
  });

  test("adds www.<primary> fallback when missing from crt.sh", async () => {
    const fetcher = makeFetcher([{ name_value: "api.example.com" }]);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs).toContain("www.example.com");
    expect(subs).toContain("api.example.com");
  });

  test("does NOT duplicate www if already in crt.sh result", async () => {
    const fetcher = makeFetcher([
      { name_value: "www.example.com" },
      { name_value: "www.example.com" },
    ]);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs.filter((s) => s === "www.example.com").length).toBe(1);
  });

  test("excludes the primary itself from results", async () => {
    const fetcher = makeFetcher([
      { name_value: "example.com\nwww.example.com" },
    ]);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs).not.toContain("example.com");
  });

  test("excludes wildcards (*.example.com)", async () => {
    const fetcher = makeFetcher([
      { name_value: "*.example.com\napi.example.com" },
    ]);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs.some((s) => s.includes("*"))).toBe(false);
    expect(subs).toContain("api.example.com");
  });

  test("excludes entries not ending in .<primary> (cross-domain leak)", async () => {
    // crt.sh's "%.example.com" query is well-behaved but defense-in-depth:
    // if the upstream ever returns rows for unrelated apexes (e.g. via a
    // shared SAN cert), the probe must reject them.
    const fetcher = makeFetcher([
      { name_value: "api.example.com\nevil.com\nexample.com.attacker.io" },
    ]);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs).toContain("api.example.com");
    expect(subs).not.toContain("evil.com");
    expect(subs).not.toContain("example.com.attacker.io");
  });

  test("lowercase normalization", async () => {
    const fetcher = makeFetcher([
      { name_value: "API.Example.COM\nAdmin.example.com" },
    ]);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs).toContain("api.example.com");
    expect(subs).toContain("admin.example.com");
    expect(subs.every((s) => s === s.toLowerCase())).toBe(true);
  });

  test("trims whitespace and skips empty lines", async () => {
    const fetcher = makeFetcher([
      { name_value: "  api.example.com  \n\n  admin.example.com\n" },
    ]);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs).toContain("api.example.com");
    expect(subs).toContain("admin.example.com");
  });

  test("caps at capN", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name_value: `sub${i}.example.com`,
    }));
    const fetcher = makeFetcher(many);
    const subs = await discoverSubdomains("example.com", {
      fetcher: fetcher as unknown as typeof fetch,
      capN: 10,
    });
    expect(subs.length).toBe(10);
  });

  test("default capN is 50", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name_value: `sub${i}.example.com`,
    }));
    const fetcher = makeFetcher(many);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs.length).toBe(50);
  });

  test("non-200 response: returns just www fallback", async () => {
    const fetcher = makeFetcher([], false);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs).toEqual(["www.example.com"]);
  });

  test("fetcher throws: returns just www fallback", async () => {
    const throwingFetcher: FakeFetcher = async () => {
      throw new Error("network down");
    };
    const subs = await discoverSubdomains("example.com", {
      fetcher: throwingFetcher as unknown as typeof fetch,
    });
    expect(subs).toEqual(["www.example.com"]);
  });

  test("empty crt.sh array: returns just www fallback", async () => {
    const fetcher = makeFetcher([]);
    const subs = await discoverSubdomains("example.com", { fetcher: fetcher as unknown as typeof fetch });
    expect(subs).toEqual(["www.example.com"]);
  });

  test("timeout: returns just www fallback when fetch exceeds timeoutMs", async () => {
    // A fetcher that respects AbortSignal: when the controller fires,
    // the promise rejects with an AbortError, which the implementation
    // catches and degrades to the www fallback.
    const slowFetcher: FakeFetcher = async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return await new Promise((_resolve, reject) => {
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        // Never resolve — we rely on the abort.
      });
    };
    const subs = await discoverSubdomains("example.com", {
      fetcher: slowFetcher as unknown as typeof fetch,
      timeoutMs: 50,
    });
    expect(subs).toEqual(["www.example.com"]);
  });

  test("malformed JSON: returns just www fallback", async () => {
    const fetcher: FakeFetcher = async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });
    const subs = await discoverSubdomains("example.com", {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(subs).toEqual(["www.example.com"]);
  });
});
