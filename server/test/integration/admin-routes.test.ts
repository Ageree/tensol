/**
 * T122 — Integration tests for `/v1/admin/deep-inquiries` operator-only routes
 * implemented in T121 (`server/src/routes/admin/deep-inquiries.ts`).
 *
 * Contract surface (matches `specs/002-blackbox-mvp/contracts/openapi.yaml`
 * paths./v1/admin/deep-inquiries.get + .{id}/status.put):
 *
 *   GET  /v1/admin/deep-inquiries           → list (optional ?status=)
 *   PUT  /v1/admin/deep-inquiries/:id/status → transition status
 *
 * Authorization model (T121):
 *   1. `requireAuth` short-circuits with 401 when no/expired session cookie.
 *   2. After auth, operator gate: `user.email` (lowercased) MUST appear in
 *      the env-derived `operatorEmails: string[]` list. Otherwise 403.
 *
 * Coverage axes:
 *   - GET anonymous (no cookie) → 401
 *   - GET non-operator (valid session, email not in list) → 403
 *   - GET operator → 200 with `{inquiries:[…]}`
 *   - GET operator with ?status=new → filtered list
 *   - PUT operator legal transition (new → contacted) → 200 + DB row updated
 *   - PUT operator illegal transition (converted → contacted) → 409
 *   - PUT operator unknown id → 404
 *   - PUT operator invalid body (status="bogus") → 422
 *   - PUT operator invalid JSON body → 400
 *
 * Operator-email handling under test:
 *   The route layer is given a pre-normalized list (lowercase, trimmed) — env
 *   parsing lives in `config.ts`. Tests pin the contract by constructing
 *   `operatorEmails: ['op@tensol.com']` directly. We seed the user with the
 *   SAME-CASE email (`op@tensol.com`) for the operator path and a different
 *   email (`bystander@tensol.com`) for the 403 path.
 *
 * Why we also test lowercase normalization explicitly:
 *   A user could in theory register `OP@Tensol.com` (the users table doesn't
 *   force lowercase). The route MUST compare case-insensitively (the env list
 *   is already lowercase). The "operator with mixed-case email" test pins
 *   this so future refactors can't silently break the contract.
 *
 * Test infra mirrors `deep-inquiries-routes.test.ts` — in-memory bun:sqlite,
 * all migrations applied, deterministic monotonic clock, stubbed enqueue.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  users as usersTable,
  sessions as sessionsTable,
  deepInquiries as deepInquiriesTable,
} from "../../src/db/schema.ts";
import { createDeepInquiriesService } from "../../src/deep-inquiries/service.ts";
import { createAdminDeepInquiriesRouter } from "../../src/routes/admin/deep-inquiries.ts";
import { createRequireAuth } from "../../src/auth/middleware.ts";
import { SESSION_COOKIE_NAME } from "../../src/auth/session.ts";
import { ulid } from "../../src/lib/ids.ts";

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY = "test-admin-deep-inquiries-routes-signing-key";

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

function seedUser(
  db: DB,
  email: string,
  opts?: { nowMs?: number },
): { userId: string; sessionId: string; cookie: string } {
  const now = opts?.nowMs ?? 1_700_000_000_000;
  const userId = ulid(now);
  const sessionId = ulid(now + 1);
  db.insert(usersTable)
    .values({ id: userId, email, createdAt: now })
    .run();
  db.insert(sessionsTable)
    .values({
      id: sessionId,
      userId,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    })
    .run();
  return {
    userId,
    sessionId,
    cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
  };
}

/**
 * Seed a deep_inquiries row with a known status.
 *
 * The service's own `createInquiry` always writes status='new' — but we need
 * to test transitions out of `converted` (terminal) and a fresh `new` to
 * `contacted`. So we INSERT directly bypassing the service.
 */
function seedInquiry(
  db: DB,
  opts: { status?: string; nowMs?: number; id?: string } = {},
): string {
  const now = opts.nowMs ?? 1_700_000_000_000;
  const id = opts.id ?? ulid(now + 2);
  db.insert(deepInquiriesTable)
    .values({
      id,
      userId: null,
      company: "SeedCo",
      contactName: "Seed Operator",
      position: null,
      email: "",
      phone: "+79990001122",
      domainsText: "seed.example.com",
      desiredDate: null,
      budgetBand: null,
      scopeText: "seed scope",
      consentAcceptedAt: now,
      status: opts.status ?? "new",
      telegramSentAt: null,
      telegramSendAttempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

interface BuildAppOpts {
  readonly operatorEmails: string[];
}

function buildApp(db: DB, opts: BuildAppOpts): Hono {
  let counter = 1_700_000_000_500;
  const nowFn = () => ++counter;

  const service = createDeepInquiriesService({
    db,
    auditKey: SIGNING_KEY,
    now: nowFn,
    enqueueJob: async () => "stub-job-id",
  });

  const requireAuth = createRequireAuth({ db, now: nowFn });

  const app = new Hono();
  app.route(
    "/v1/admin/deep-inquiries",
    createAdminDeepInquiriesRouter({
      service,
      operatorEmails: opts.operatorEmails,
      requireAuth,
    }),
  );
  return app;
}

function req(
  app: Hono,
  method: "GET" | "PUT",
  path: string,
  opts: { body?: unknown; cookie?: string; rawBody?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined || opts.rawBody !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (opts.cookie) headers.Cookie = opts.cookie;

  const init: RequestInit = { method, headers };
  if (opts.rawBody !== undefined) {
    init.body = opts.rawBody;
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  return app.request(path, init);
}

// ---------------------------------------------------------------------------
// GET /v1/admin/deep-inquiries
// ---------------------------------------------------------------------------

describe("GET /v1/admin/deep-inquiries — auth + operator gate", () => {
  test("anonymous (no cookie) → 401", async () => {
    const db = freshMemDb();
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "GET", "/v1/admin/deep-inquiries");
    expect(res.status).toBe(401);
  });

  test("non-operator (valid session, email not in list) → 403", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "bystander@tensol.com");
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "GET", "/v1/admin/deep-inquiries", { cookie });
    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("operator → 200 + {inquiries:[…]}", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "op@tensol.com");
    seedInquiry(db, { status: "new" });
    seedInquiry(db, { status: "contacted" });
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "GET", "/v1/admin/deep-inquiries", { cookie });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      inquiries: Array<{ id: string; status: string }>;
    };
    expect(Array.isArray(body.inquiries)).toBe(true);
    expect(body.inquiries.length).toBe(2);
  });

  test("operator with ?status=new → filtered list", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "op@tensol.com");
    seedInquiry(db, { status: "new", id: ulid(1_700_000_010_000) });
    seedInquiry(db, { status: "contacted", id: ulid(1_700_000_010_001) });
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "GET", "/v1/admin/deep-inquiries?status=new", {
      cookie,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      inquiries: Array<{ id: string; status: string }>;
    };
    expect(body.inquiries.length).toBe(1);
    expect(body.inquiries[0]?.status).toBe("new");
  });

  test("operator with mixed-case email → 200 (case-insensitive match)", async () => {
    const db = freshMemDb();
    // User row carries mixed case; env list is normalized to lowercase.
    const { cookie } = seedUser(db, "OP@Tensol.com");
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "GET", "/v1/admin/deep-inquiries", { cookie });
    expect(res.status).toBe(200);
  });

  test("operator with invalid ?status= value → 422", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "op@tensol.com");
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(
      app,
      "GET",
      "/v1/admin/deep-inquiries?status=bogus",
      { cookie },
    );
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/admin/deep-inquiries/:id/status
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/deep-inquiries/:id/status", () => {
  test("anonymous → 401", async () => {
    const db = freshMemDb();
    const id = seedInquiry(db, { status: "new" });
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "PUT", `/v1/admin/deep-inquiries/${id}/status`, {
      body: { status: "contacted" },
    });
    expect(res.status).toBe(401);
  });

  test("non-operator → 403", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "bystander@tensol.com");
    const id = seedInquiry(db, { status: "new" });
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "PUT", `/v1/admin/deep-inquiries/${id}/status`, {
      cookie,
      body: { status: "contacted" },
    });
    expect(res.status).toBe(403);
  });

  test("legal transition (new → contacted) → 200 + row updated", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "op@tensol.com");
    const id = seedInquiry(db, { status: "new" });
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "PUT", `/v1/admin/deep-inquiries/${id}/status`, {
      cookie,
      body: { status: "contacted" },
    });
    expect(res.status).toBe(200);

    const row = db
      .select()
      .from(deepInquiriesTable)
      .where(eq(deepInquiriesTable.id, id))
      .get();
    expect(row?.status).toBe("contacted");
  });

  test("illegal transition (converted → contacted) → 409", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "op@tensol.com");
    const id = seedInquiry(db, { status: "converted" });
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "PUT", `/v1/admin/deep-inquiries/${id}/status`, {
      cookie,
      body: { status: "contacted" },
    });
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("conflict");
  });

  test("unknown inquiry id → 404", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "op@tensol.com");
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(
      app,
      "PUT",
      "/v1/admin/deep-inquiries/01ARZ3NDEKTSV4RRFFQ69G5FAV/status",
      {
        cookie,
        body: { status: "contacted" },
      },
    );
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("invalid status enum → 422", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "op@tensol.com");
    const id = seedInquiry(db, { status: "new" });
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "PUT", `/v1/admin/deep-inquiries/${id}/status`, {
      cookie,
      body: { status: "bogus" },
    });
    expect(res.status).toBe(422);

    const body = (await res.json()) as {
      error: string;
      details?: unknown;
    };
    expect(body.error).toBe("validation_error");
  });

  test("invalid JSON body → 400", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "op@tensol.com");
    const id = seedInquiry(db, { status: "new" });
    const app = buildApp(db, { operatorEmails: ["op@tensol.com"] });

    const res = await req(app, "PUT", `/v1/admin/deep-inquiries/${id}/status`, {
      cookie,
      rawBody: "{ not json",
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/json/i);
  });

  test("empty operatorEmails list → every authenticated user gets 403", async () => {
    const db = freshMemDb();
    const { cookie } = seedUser(db, "op@tensol.com");
    const app = buildApp(db, { operatorEmails: [] });

    const res = await req(app, "GET", "/v1/admin/deep-inquiries", { cookie });
    expect(res.status).toBe(403);
  });
});
