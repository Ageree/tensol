/**
 * T105 — Integration tests for `/v1/deep-inquiries` HTTP route (T104).
 *
 * Contract surface (matches openapi.yaml verbatim — see lines 607-646 of
 * `specs/002-blackbox-mvp/contracts/openapi.yaml`):
 *
 *   POST /v1/deep-inquiries → createInquiry (201)
 *
 * Coverage axes:
 *   - Anonymous happy path → 201, row.user_id = null
 *   - Authenticated happy path → 201, row.user_id = session user
 *   - 422 on missing required field (Zod validation_error envelope)
 *   - 422 on consent_accepted=false (z.literal(true) rejects)
 *   - 400 on malformed JSON body
 *   - Sanitization round-trip: body.scope_text containing `password:abc123`
 *     persists with `[REDACTED]` in the DB row.
 *
 * Constitution invariants pinned:
 *   - II: Anonymous funnel is supported (no 401 when cookie missing).
 *   - IX (NON-NEGOTIABLE): Zod validates the body at the route boundary
 *     before reaching the service layer.
 *
 * Why no auth gate test:
 *   The route is *deliberately* anonymous-or-authenticated (per the
 *   route brief). A missing cookie is a legal request path, NOT a 401.
 *   The authenticated test asserts the session-resolved userId reaches
 *   the persisted row.
 *
 * Test infra mirrors `server/test/integration/scan-orders-routes.test.ts`
 * and `server/src/deep-inquiries/service.test.ts` — in-memory bun:sqlite,
 * all migrations applied, deterministic monotonic clock.
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
import { createDeepInquiriesRouter } from "../../src/routes/deep-inquiries.ts";
import { SESSION_COOKIE_NAME, readSessionCookie } from "../../src/auth/session.ts";
import { ulid } from "../../src/lib/ids.ts";

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY = "test-deep-inquiries-routes-signing-key";

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

function seedUserAndSession(
  db: DB,
  opts?: { nowMs?: number },
): { userId: string; sessionId: string; cookie: string } {
  const now = opts?.nowMs ?? 1_700_000_000_000;
  const userId = ulid(now);
  const sessionId = ulid(now + 1);
  db.insert(usersTable)
    .values({
      id: userId,
      email: `${userId}@test.local`,
      createdAt: now,
    })
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
 * Build the test app: deep-inquiries subrouter under /v1/deep-inquiries.
 *
 * Soft auth (cookie reader) is wired here to mirror server.ts: when a
 * valid session cookie is present, the userId resolved from the DB row
 * is forwarded to the service; otherwise userId is null (anonymous funnel).
 */
function buildApp(db: DB): Hono {
  let counter = 1_700_000_000_000;
  const nowFn = () => ++counter;

  const service = createDeepInquiriesService({
    db,
    auditKey: SIGNING_KEY,
    now: nowFn,
    // Stub the enqueue path so the jobs table doesn't grow during tests
    // — the route under test doesn't care about job-side effects, those
    // are covered in service.test.ts (T101).
    enqueueJob: async () => "stub-job-id",
  });

  const getUserId = (c: import("hono").Context): string | null => {
    const sid = readSessionCookie(c);
    if (!sid) return null;
    const sessionRow = db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sid))
      .get();
    if (!sessionRow) return null;
    if (nowFn() >= sessionRow.expiresAt) return null;
    return sessionRow.userId;
  };

  const app = new Hono();
  app.route(
    "/v1/deep-inquiries",
    createDeepInquiriesRouter({ service, getUserId }),
  );
  return app;
}

const VALID_BODY = {
  company: "Acme Corp",
  contact_name: "Jane Operator",
  phone: "+79991234567",
  domains_text: "example.com\napi.example.com",
  scope_text: "We want a thorough pentest of our API surface.",
  consent_accepted: true,
};

function jsonReq(
  app: Hono,
  method: "POST",
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) headers.Cookie = cookie;
  return app.request(path, {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Anonymous funnel — 201
// ---------------------------------------------------------------------------

describe("POST /v1/deep-inquiries — anonymous", () => {
  test("valid body without cookie → 201 + persisted row with user_id IS NULL", async () => {
    const db = freshMemDb();
    const app = buildApp(db);

    const res = await jsonReq(app, "POST", "/v1/deep-inquiries", VALID_BODY);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("received");

    const row = db
      .select()
      .from(deepInquiriesTable)
      .where(eq(deepInquiriesTable.id, body.id))
      .get();
    expect(row).toBeTruthy();
    expect(row?.userId).toBeNull();
    expect(row?.company).toBe("Acme Corp");
    expect(row?.status).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Authenticated funnel — 201 with userId forwarded
// ---------------------------------------------------------------------------

describe("POST /v1/deep-inquiries — authenticated", () => {
  test("valid body with session cookie → 201 + row.user_id = session user", async () => {
    const db = freshMemDb();
    const { userId, cookie } = seedUserAndSession(db);
    const app = buildApp(db);

    const res = await jsonReq(
      app,
      "POST",
      "/v1/deep-inquiries",
      VALID_BODY,
      cookie,
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("received");

    const row = db
      .select()
      .from(deepInquiriesTable)
      .where(eq(deepInquiriesTable.id, body.id))
      .get();
    expect(row?.userId).toBe(userId);
  });
});

// ---------------------------------------------------------------------------
// 422 — validation errors
// ---------------------------------------------------------------------------

describe("POST /v1/deep-inquiries — validation", () => {
  test("missing required field (phone) → 422 with details[]", async () => {
    const db = freshMemDb();
    const app = buildApp(db);

    const { phone: _omit, ...bodyWithoutPhone } = VALID_BODY;
    const res = await jsonReq(
      app,
      "POST",
      "/v1/deep-inquiries",
      bodyWithoutPhone,
    );
    expect(res.status).toBe(422);

    const body = (await res.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("validation_error");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.some((d) => d.field === "phone")).toBe(true);
  });

  test("consent_accepted=false → 422", async () => {
    const db = freshMemDb();
    const app = buildApp(db);

    const res = await jsonReq(app, "POST", "/v1/deep-inquiries", {
      ...VALID_BODY,
      consent_accepted: false,
    });
    expect(res.status).toBe(422);

    const body = (await res.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("validation_error");
    expect(body.details.some((d) => d.field === "consent_accepted")).toBe(true);
  });

  test("malformed JSON body → 400", async () => {
    const db = freshMemDb();
    const app = buildApp(db);

    const res = await app.request("/v1/deep-inquiries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/json/i);
  });
});

// ---------------------------------------------------------------------------
// Sanitization round-trip
// ---------------------------------------------------------------------------

describe("POST /v1/deep-inquiries — sanitization", () => {
  test("scope_text containing `password:abc123` is redacted before persist", async () => {
    const db = freshMemDb();
    const app = buildApp(db);

    const scopeWithSecret =
      "Please test our staging env. Credentials: password:abc123 for the admin panel.";
    const res = await jsonReq(app, "POST", "/v1/deep-inquiries", {
      ...VALID_BODY,
      scope_text: scopeWithSecret,
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { id: string };
    const row = db
      .select()
      .from(deepInquiriesTable)
      .where(eq(deepInquiriesTable.id, body.id))
      .get();
    expect(row).toBeTruthy();
    expect(row?.scopeText).not.toContain("abc123");
    expect(row?.scopeText).toContain("[REDACTED]");
  });
});
