/**
 * Tests for the fixed-window rate-limit middleware.
 *
 * Strategy
 *   - Drive a controllable clock via `createClock` (lib/time.ts) so window
 *     reset boundaries are deterministic.
 *   - Build a tiny Hono app per test that mounts the middleware in front
 *     of an `OK` handler — request via `app.request(url, {headers})` and
 *     assert on status + body + response headers.
 *   - Use a fake store wrapper to prove DI works for the BucketStore
 *     interface (and so we can inspect mid-test state).
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createClock } from "./time.ts";
import {
  createRateLimit,
  createMemoryStore,
  defaultKeyFn,
  RATE_LIMIT_AUTH,
  RATE_LIMIT_INQUIRY,
  type BucketEntry,
  type BucketStore,
} from "./rate-limit.ts";

function buildApp(
  middlewareOpts: Parameters<typeof createRateLimit>[0],
): Hono {
  const app = new Hono();
  app.use("*", createRateLimit(middlewareOpts));
  app.get("/probe", (c) => c.json({ ok: true }));
  app.post("/probe", (c) => c.json({ ok: true }));
  return app;
}

function makeReq(ip = "1.1.1.1"): RequestInit {
  return { headers: { "x-forwarded-for": ip } };
}

describe("createRateLimit", () => {
  it("rejects invalid opts at construction", () => {
    expect(() =>
      createRateLimit({ windowMs: 0, max: 1 }),
    ).toThrow(/windowMs must be > 0/);
    expect(() =>
      createRateLimit({ windowMs: -5, max: 1 }),
    ).toThrow(/windowMs must be > 0/);
    expect(() =>
      createRateLimit({ windowMs: 1000, max: 0 }),
    ).toThrow(/max must be > 0/);
    expect(() =>
      createRateLimit({ windowMs: 1000, max: -1 }),
    ).toThrow(/max must be > 0/);
  });

  it("allows N requests within the window and 429s the N+1", async () => {
    const clock = createClock(1_700_000_000_000);
    const app = buildApp({
      windowMs: 60_000,
      max: 10,
      now: clock.now,
    });

    // 10 successful
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/probe", makeReq());
      expect(res.status).toBe(200);
    }
    // 11th is rate-limited
    const blocked = await app.request("/probe", makeReq());
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as {
      error: string;
      retry_after: number;
    };
    expect(body.error).toBe("rate_limited");
    expect(body.retry_after).toBeGreaterThan(0);
  });

  it("resets the bucket after windowMs and accepts a new request", async () => {
    const clock = createClock(1_700_000_000_000);
    const app = buildApp({
      windowMs: 60_000,
      max: 2,
      now: clock.now,
    });

    expect((await app.request("/probe", makeReq())).status).toBe(200);
    expect((await app.request("/probe", makeReq())).status).toBe(200);
    expect((await app.request("/probe", makeReq())).status).toBe(429);

    // Advance past the window boundary; next request should succeed.
    clock.advance(60_001);
    const res = await app.request("/probe", makeReq());
    expect(res.status).toBe(200);
  });

  it("uses separate buckets per IP", async () => {
    const clock = createClock(1_700_000_000_000);
    const app = buildApp({
      windowMs: 60_000,
      max: 2,
      now: clock.now,
    });

    // Exhaust IP A
    expect((await app.request("/probe", makeReq("1.1.1.1"))).status).toBe(200);
    expect((await app.request("/probe", makeReq("1.1.1.1"))).status).toBe(200);
    expect((await app.request("/probe", makeReq("1.1.1.1"))).status).toBe(429);

    // IP B has a fresh bucket
    expect((await app.request("/probe", makeReq("2.2.2.2"))).status).toBe(200);
    expect((await app.request("/probe", makeReq("2.2.2.2"))).status).toBe(200);
    expect((await app.request("/probe", makeReq("2.2.2.2"))).status).toBe(429);
  });

  it("populates X-RateLimit-* headers on every response", async () => {
    const clock = createClock(1_700_000_000_000);
    const app = buildApp({
      windowMs: 60_000,
      max: 3,
      now: clock.now,
    });

    const first = await app.request("/probe", makeReq());
    expect(first.headers.get("X-RateLimit-Limit")).toBe("3");
    expect(first.headers.get("X-RateLimit-Remaining")).toBe("2");
    const reset = first.headers.get("X-RateLimit-Reset");
    expect(reset).not.toBeNull();
    // reset is in seconds; expect ~ (clock + 60s) / 1000
    expect(Number(reset)).toBe(Math.ceil((1_700_000_000_000 + 60_000) / 1000));

    const second = await app.request("/probe", makeReq());
    expect(second.headers.get("X-RateLimit-Remaining")).toBe("1");

    const third = await app.request("/probe", makeReq());
    expect(third.headers.get("X-RateLimit-Remaining")).toBe("0");

    const blocked = await app.request("/probe", makeReq());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("accepts a DI'd store and reads/writes through it", async () => {
    const clock = createClock(1_700_000_000_000);
    const inner = new Map<string, BucketEntry>();
    const reads: string[] = [];
    const writes: string[] = [];
    const fakeStore: BucketStore = {
      get: (key) => {
        reads.push(key);
        return inner.get(key);
      },
      set: (key, value) => {
        writes.push(key);
        inner.set(key, value);
      },
    };

    const app = buildApp({
      windowMs: 60_000,
      max: 2,
      now: clock.now,
      store: fakeStore,
    });

    await app.request("/probe", makeReq("9.9.9.9"));
    await app.request("/probe", makeReq("9.9.9.9"));
    expect(reads).toEqual(["9.9.9.9", "9.9.9.9"]);
    expect(writes).toEqual(["9.9.9.9", "9.9.9.9"]);
    // Internal state reflects the second hit
    const stored = inner.get("9.9.9.9");
    expect(stored?.count).toBe(2);
  });

  it("honors a custom keyFn (scope by header)", async () => {
    const clock = createClock(1_700_000_000_000);
    const app = new Hono();
    app.use(
      "*",
      createRateLimit({
        windowMs: 60_000,
        max: 1,
        now: clock.now,
        keyFn: (c) => c.req.header("x-tenant") ?? "anon",
      }),
    );
    app.get("/probe", (c) => c.json({ ok: true }));

    expect(
      (await app.request("/probe", { headers: { "x-tenant": "A" } })).status,
    ).toBe(200);
    expect(
      (await app.request("/probe", { headers: { "x-tenant": "A" } })).status,
    ).toBe(429);
    // Different tenant → separate bucket
    expect(
      (await app.request("/probe", { headers: { "x-tenant": "B" } })).status,
    ).toBe(200);
  });

  it("429 body carries retry_after seconds aligned with window", async () => {
    const clock = createClock(1_700_000_000_000);
    const app = buildApp({
      windowMs: 60_000,
      max: 1,
      now: clock.now,
    });
    await app.request("/probe", makeReq());
    const blocked = await app.request("/probe", makeReq());
    const body = (await blocked.json()) as { retry_after: number };
    // First request opened a 60s window; second hit at t=0 should owe ~60s.
    expect(body.retry_after).toBe(60);
  });
});

describe("defaultKeyFn", () => {
  it("returns first IP from x-forwarded-for chain", async () => {
    const app = new Hono();
    app.get("/k", (c) => c.text(defaultKeyFn(c)));
    const res = await app.request("/k", {
      headers: { "x-forwarded-for": "10.0.0.1, 172.16.0.1, 192.168.1.1" },
    });
    expect(await res.text()).toBe("10.0.0.1");
  });

  it("falls back to x-real-ip when xff missing", async () => {
    const app = new Hono();
    app.get("/k", (c) => c.text(defaultKeyFn(c)));
    const res = await app.request("/k", {
      headers: { "x-real-ip": "5.5.5.5" },
    });
    expect(await res.text()).toBe("5.5.5.5");
  });

  it("returns 'unknown' when no forwarding headers", async () => {
    const app = new Hono();
    app.get("/k", (c) => c.text(defaultKeyFn(c)));
    const res = await app.request("/k");
    expect(await res.text()).toBe("unknown");
  });
});

describe("createMemoryStore", () => {
  it("set/get round-trips", () => {
    const store = createMemoryStore();
    expect(store.get("k")).toBeUndefined();
    store.set("k", { count: 3, resetAt: 1_000 });
    expect(store.get("k")).toEqual({ count: 3, resetAt: 1_000 });
  });
});

describe("preset constants", () => {
  it("RATE_LIMIT_AUTH = 10/min", () => {
    expect(RATE_LIMIT_AUTH.windowMs).toBe(60_000);
    expect(RATE_LIMIT_AUTH.max).toBe(10);
  });
  it("RATE_LIMIT_INQUIRY = 5/min", () => {
    expect(RATE_LIMIT_INQUIRY.windowMs).toBe(60_000);
    expect(RATE_LIMIT_INQUIRY.max).toBe(5);
  });
});
