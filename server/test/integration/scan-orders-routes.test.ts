/**
 * T068 — Integration tests for `/v1/scan-orders/*` HTTP routes (T067).
 *
 * Contract surface (matches openapi.yaml verbatim):
 *
 *   GET    /v1/scan-orders                         → list user orders
 *   POST   /v1/scan-orders                         → createDraft
 *   GET    /v1/scan-orders/:id                     → getOrder
 *   DELETE /v1/scan-orders/:id                     → cancelOrder
 *   PUT    /v1/scan-orders/:id/attack-surface      → updateAttackSurface
 *   PUT    /v1/scan-orders/:id/safety              → updateSafety
 *   POST   /v1/scan-orders/:id/dns-verify/request  → requestDnsVerify
 *   GET    /v1/scan-orders/:id/dns-verify/check    → checkDnsAndUnlock
 *   POST   /v1/scan-orders/:id/launch              → launchScan
 *
 * Coverage axes (per task brief):
 *   - Happy path for every endpoint
 *   - Foreign-user → 404 (Constitution II — no existence leak)
 *   - Validation failure → 422 (Zod-driven)
 *   - Illegal transition → 409 (CONFLICT)
 *   - Free-tier quota exhausted on launch → 429 (per openapi)
 *   - Auth required: missing cookie → 401
 *
 * Service is constructed in-test (deterministic clock + DNS resolver stub +
 * subdomain probe stub), so happy-path tests for DNS verify can pass without
 * the 30-min real-DNS poll loop.
 *
 * The test app mounts:
 *   - `createAuthRoutes` at `/api/auth` (for magic-link signup → cookie)
 *   - `createScanOrdersRouter(service, requireAuth)` at `/v1/scan-orders`
 * so we drive the full middleware chain (cookie → user lookup → handler).
 */
import { test, expect, describe } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  users as usersTable,
  sessions as sessionsTable,
} from "../../src/db/schema.ts";
import { createScanOrdersService } from "../../src/scan-orders/service.ts";
import { createScanOrdersRouter } from "../../src/routes/scan-orders.ts";
import {
  createRequireAuth,
  type AuthVariables,
} from "../../src/auth/middleware.ts";
import { SESSION_COOKIE_NAME } from "../../src/auth/session.ts";
import { ulid } from "../../src/lib/ids.ts";

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY = "test-scan-orders-routes-signing-key";

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  return db;
}

/** Insert a user row + active session row. Returns {userId, sessionId}. */
function seedUserAndSession(
  db: DB,
  opts?: { email?: string; nowMs?: number },
): { userId: string; sessionId: string; cookie: string } {
  const now = opts?.nowMs ?? 1_700_000_000_000;
  const userId = ulid(now);
  const sessionId = ulid(now + 1);
  db.insert(usersTable)
    .values({
      id: userId,
      email: opts?.email ?? `${userId}@test.local`,
      createdAt: now,
    })
    .run();
  db.insert(sessionsTable)
    .values({
      id: sessionId,
      userId,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000, // +24h
    })
    .run();
  return {
    userId,
    sessionId,
    cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
  };
}

interface BuildAppOpts {
  readonly db: DB;
  /** Deterministic clock for the service. Defaults to a monotonic counter. */
  readonly now?: () => number;
  /** Optional DNS resolver stub — controls dns-verify happy / fail paths. */
  readonly dnsResolver?: (
    domain: string,
    opts?: unknown,
  ) => Promise<string[] | null>;
}

/**
 * Build the test app: auth middleware (so cookies map to users) + the
 * scan-orders subrouter under /v1/scan-orders.
 */
function buildApp(opts: BuildAppOpts): Hono<{ Variables: AuthVariables }> {
  let counter = 1_700_000_000_000;
  const nowFn = opts.now ?? (() => ++counter);
  const probe = async (primary: string) => [
    `www.${primary}`,
    `api.${primary}`,
  ];

  const service = createScanOrdersService({
    db: opts.db,
    auditKey: SIGNING_KEY,
    now: nowFn,
    discoverSubdomains: probe,
    ...(opts.dnsResolver !== undefined
      ? { dnsResolver: opts.dnsResolver }
      : {}),
  });

  const requireAuth = createRequireAuth({ db: opts.db, now: nowFn });
  const app = new Hono<{ Variables: AuthVariables }>();
  app.route(
    "/v1/scan-orders",
    createScanOrdersRouter({ service, requireAuth }),
  );
  return app;
}

const VALID_ATTACK_SURFACE = [
  { domain: "example.com", primary: true, headers: [] },
  {
    domain: "api.example.com",
    primary: false,
    headers: [{ k: "X-Test", v: "1" }],
  },
];

/** POST/PUT JSON helper — bundles content-type + Cookie + body for brevity. */
async function jsonReq(
  app: Hono<{ Variables: AuthVariables }>,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json", Cookie: cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Create a quick draft order; returns the new ULID id. */
async function createDraft(
  app: Hono<{ Variables: AuthVariables }>,
  cookie: string,
  primaryDomain = "example.com",
): Promise<string> {
  const res = await jsonReq(app, "POST", "/v1/scan-orders", cookie, {
    tier: "quick",
    primary_domain: primaryDomain,
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

// ---------------------------------------------------------------------------
// AUTH GATE
// ---------------------------------------------------------------------------

describe("scan-orders routes — auth gate", () => {
  test("GET /v1/scan-orders without cookie → 401", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const res = await app.request("/v1/scan-orders");
    expect(res.status).toBe(401);
  });

  test("POST /v1/scan-orders without cookie → 401", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const res = await app.request("/v1/scan-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "quick", primary_domain: "example.com" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET / — list
// ---------------------------------------------------------------------------

describe("GET /v1/scan-orders (list)", () => {
  test("empty list for new user → 200 []", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const res = await app.request("/v1/scan-orders", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  test("returns only caller's orders (foreign user not leaked)", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, {
      email: "them@test.local",
      nowMs: 1_700_000_100_000,
    });
    await createDraft(app, me.cookie, "mine.example");
    await createDraft(app, them.cookie, "theirs.example");

    const res = await app.request("/v1/scan-orders", {
      headers: { Cookie: me.cookie },
    });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ primary_domain: string }>;
    expect(list.length).toBe(1);
    expect(list[0]?.primary_domain).toBe("mine.example");
  });
});

// ---------------------------------------------------------------------------
// POST / — createDraft
// ---------------------------------------------------------------------------

describe("POST /v1/scan-orders (createDraft)", () => {
  test("happy path → 201 + ScanOrder shape", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const res = await jsonReq(app, "POST", "/v1/scan-orders", cookie, {
      tier: "quick",
      primary_domain: "example.com",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      user_id: string;
      status: string;
      tier: string;
      primary_domain: string;
      attack_surface: unknown[];
      payment_kind: string;
    };
    expect(body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.user_id).toBe(userId);
    expect(body.status).toBe("draft");
    expect(body.tier).toBe("quick");
    expect(body.primary_domain).toBe("example.com");
    expect(body.attack_surface).toEqual([]);
    expect(body.payment_kind).toBe("free_quick");
  });

  test("invalid body (missing primary_domain) → 422", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const res = await jsonReq(app, "POST", "/v1/scan-orders", cookie, {
      tier: "quick",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  test.each(["EXAMPLE.com", "localhost", "127.0.0.1", "example.123"])(
    "invalid hostname %s → 422",
    async (primaryDomain) => {
      const db = freshMemDb();
      const app = buildApp({ db });
      const { cookie } = seedUserAndSession(db);
      const res = await jsonReq(app, "POST", "/v1/scan-orders", cookie, {
        tier: "quick",
        primary_domain: primaryDomain,
      });
      expect(res.status).toBe(422);
    },
  );

  test("invalid tier (deep not allowed on create) → 422", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const res = await jsonReq(app, "POST", "/v1/scan-orders", cookie, {
      tier: "deep",
      primary_domain: "example.com",
    });
    expect(res.status).toBe(422);
  });

  test("malformed JSON → 400", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const res = await app.request("/v1/scan-orders", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /:id — getOrder
// ---------------------------------------------------------------------------

describe("GET /v1/scan-orders/:id (getOrder)", () => {
  test("happy path → 200 + ScanOrder", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    const getRes = await app.request(`/v1/scan-orders/${id}`, {
      headers: { Cookie: cookie },
    });
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { id: string };
    expect(body.id).toBe(id);
  });

  test("foreign user order → 404 (no existence leak)", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, {
      email: "them@test.local",
      nowMs: 1_700_000_100_000,
    });
    const id = await createDraft(app, them.cookie, "theirs.example");

    const getRes = await app.request(`/v1/scan-orders/${id}`, {
      headers: { Cookie: me.cookie },
    });
    expect(getRes.status).toBe(404);
    const body = (await getRes.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("nonexistent id → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const res = await app.request(
      "/v1/scan-orders/01ARZ3NDEKTSV4RRFFQ69G5FAV",
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /:id/attack-surface
// ---------------------------------------------------------------------------

describe("PUT /v1/scan-orders/:id/attack-surface (updateAttackSurface)", () => {
  test("happy path → 200 with updated list", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    const putRes = await jsonReq(
      app,
      "PUT",
      `/v1/scan-orders/${id}/attack-surface`,
      cookie,
      { attack_surface: VALID_ATTACK_SURFACE },
    );
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as {
      attack_surface: Array<{ domain: string }>;
    };
    expect(body.attack_surface.length).toBe(2);
    expect(body.attack_surface[0]?.domain).toBe("example.com");
  });

  test("empty attack_surface array → 422", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    const putRes = await jsonReq(
      app,
      "PUT",
      `/v1/scan-orders/${id}/attack-surface`,
      cookie,
      { attack_surface: [] },
    );
    expect(putRes.status).toBe(422);
  });

  test("foreign user order → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, {
      email: "them@test.local",
      nowMs: 1_700_000_100_000,
    });
    const id = await createDraft(app, them.cookie, "theirs.example");
    const res = await jsonReq(
      app,
      "PUT",
      `/v1/scan-orders/${id}/attack-surface`,
      me.cookie,
      { attack_surface: VALID_ATTACK_SURFACE },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /:id/safety
// ---------------------------------------------------------------------------

describe("PUT /v1/scan-orders/:id/safety (updateSafety)", () => {
  test("happy path → 200 with safety_rps set", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    const res = await jsonReq(
      app,
      "PUT",
      `/v1/scan-orders/${id}/safety`,
      cookie,
      { safety_rps: 25 },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { safety_rps: number };
    expect(body.safety_rps).toBe(25);
  });

  test("out-of-range rps → 422", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    const res = await jsonReq(
      app,
      "PUT",
      `/v1/scan-orders/${id}/safety`,
      cookie,
      { safety_rps: 0 },
    );
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// DNS verify request/check
// ---------------------------------------------------------------------------

describe("dns-verify request + check", () => {
  test("POST /dns-verify/request → 200 + token + instructions", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    const res = await jsonReq(
      app,
      "POST",
      `/v1/scan-orders/${id}/dns-verify/request`,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      instructions: {
        record_type: string;
        record_name: string;
        record_value: string;
      };
    };
    expect(body.token).toMatch(/^tensol-verify-/);
    expect(body.instructions.record_type).toBe("TXT");
    expect(body.instructions.record_name).toBe("@");
    expect(body.instructions.record_value).toBe(body.token);
  });

  test("GET /dns-verify/check returns verified:false while no DNS match", async () => {
    const db = freshMemDb();
    // Resolver returns empty list → not yet verified.
    const app = buildApp({ db, dnsResolver: async () => [] });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    await jsonReq(app, "POST", `/v1/scan-orders/${id}/dns-verify/request`, cookie);

    const res = await app.request(
      `/v1/scan-orders/${id}/dns-verify/check`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verified: boolean;
      attempts: number;
      remaining_window_seconds: number;
    };
    expect(body.verified).toBe(false);
    expect(typeof body.attempts).toBe("number");
    expect(typeof body.remaining_window_seconds).toBe("number");
  });

  test("GET /dns-verify/check returns verified:true on resolver match", async () => {
    const db = freshMemDb();
    // Closure-injected resolver: returns the issued token once we've captured it.
    let issuedToken = "";
    const app = buildApp({
      db,
      dnsResolver: async () => (issuedToken ? [issuedToken] : []),
    });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    const reqRes = await jsonReq(
      app,
      "POST",
      `/v1/scan-orders/${id}/dns-verify/request`,
      cookie,
    );
    issuedToken = ((await reqRes.json()) as { token: string }).token;

    const checkRes = await app.request(
      `/v1/scan-orders/${id}/dns-verify/check`,
      { headers: { Cookie: cookie } },
    );
    expect(checkRes.status).toBe(200);
    const body = (await checkRes.json()) as { verified: boolean };
    expect(body.verified).toBe(true);
  });

  test("foreign user → 404 on dns-verify endpoints", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, {
      email: "them@test.local",
      nowMs: 1_700_000_100_000,
    });
    const id = await createDraft(app, them.cookie, "theirs.example");

    const reqRes = await jsonReq(
      app,
      "POST",
      `/v1/scan-orders/${id}/dns-verify/request`,
      me.cookie,
    );
    expect(reqRes.status).toBe(404);

    const checkRes = await app.request(
      `/v1/scan-orders/${id}/dns-verify/check`,
      { headers: { Cookie: me.cookie } },
    );
    expect(checkRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/launch
// ---------------------------------------------------------------------------

describe("POST /v1/scan-orders/:id/launch (launchScan)", () => {
  /** Drive an order from draft → dns_verified. Sets `tokenRef.value` so the
   *  resolver closure returns a match. */
  async function makeVerifiedOrder(
    app: Hono<{ Variables: AuthVariables }>,
    cookie: string,
    tokenRef: { value: string },
    primary = "example.com",
  ): Promise<string> {
    const id = await createDraft(app, cookie, primary);
    const reqRes = await jsonReq(
      app,
      "POST",
      `/v1/scan-orders/${id}/dns-verify/request`,
      cookie,
    );
    tokenRef.value = ((await reqRes.json()) as { token: string }).token;
    await app.request(`/v1/scan-orders/${id}/dns-verify/check`, {
      headers: { Cookie: cookie },
    });
    return id;
  }

  test("happy path: dns_verified → 202 + scan_id", async () => {
    const db = freshMemDb();
    const tokenRef = { value: "" };
    const app = buildApp({
      db,
      dnsResolver: async () => (tokenRef.value ? [tokenRef.value] : []),
    });
    const { cookie } = seedUserAndSession(db);
    const id = await makeVerifiedOrder(app, cookie, tokenRef);

    const res = await jsonReq(app, "POST", `/v1/scan-orders/${id}/launch`, cookie);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { scan_id: string };
    expect(body.scan_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("launch from draft (not verified) → 409", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    const res = await jsonReq(app, "POST", `/v1/scan-orders/${id}/launch`, cookie);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("conflict");
  });

  test("free quota exhausted → 429", async () => {
    const db = freshMemDb();
    const tokenRef = { value: "" };
    const app = buildApp({
      db,
      dnsResolver: async () => (tokenRef.value ? [tokenRef.value] : []),
    });
    const { cookie } = seedUserAndSession(db);

    const firstId = await makeVerifiedOrder(app, cookie, tokenRef);
    const first = await jsonReq(app, "POST", `/v1/scan-orders/${firstId}/launch`, cookie);
    expect(first.status).toBe(202);

    const secondId = await makeVerifiedOrder(app, cookie, tokenRef, "second.example");
    const second = await jsonReq(app, "POST", `/v1/scan-orders/${secondId}/launch`, cookie);
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("free_quota_exhausted");
  });

  test("foreign user → 404 on launch", async () => {
    const db = freshMemDb();
    const tokenRef = { value: "" };
    const app = buildApp({
      db,
      dnsResolver: async () => (tokenRef.value ? [tokenRef.value] : []),
    });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, {
      email: "them@test.local",
      nowMs: 1_700_000_100_000,
    });
    const id = await makeVerifiedOrder(app, them.cookie, tokenRef);

    const res = await jsonReq(app, "POST", `/v1/scan-orders/${id}/launch`, me.cookie);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — cancelOrder
// ---------------------------------------------------------------------------

describe("DELETE /v1/scan-orders/:id (cancelOrder)", () => {
  test("happy path: cancel draft → 200 + status=cancelled", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    const res = await jsonReq(app, "DELETE", `/v1/scan-orders/${id}`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("cancelled");
  });

  test("double-cancel (terminal) → 409", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const id = await createDraft(app, cookie);
    await jsonReq(app, "DELETE", `/v1/scan-orders/${id}`, cookie);
    const second = await jsonReq(app, "DELETE", `/v1/scan-orders/${id}`, cookie);
    expect(second.status).toBe(409);
  });

  test("foreign user cancel → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, {
      email: "them@test.local",
      nowMs: 1_700_000_100_000,
    });
    const id = await createDraft(app, them.cookie, "theirs.example");
    const res = await jsonReq(app, "DELETE", `/v1/scan-orders/${id}`, me.cookie);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: invalid order id format → 404 (no path leak)
// ---------------------------------------------------------------------------

describe("invalid order id formats", () => {
  test("non-ULID id on GET → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const res = await app.request("/v1/scan-orders/not-a-ulid-at-all", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });
});
