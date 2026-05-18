/**
 * T026 — Integration tests for the magic-link auth routes
 * (`server/src/routes/auth.ts`).
 *
 * Each test wires a fresh `:memory:` DB, a mock `EmailClient` that captures
 * outgoing sends, and a Hono app mounting `createAuthRoutes(...)` at
 * `/api/auth`. We exercise the routes via `app.request(...)` (Hono's in-
 * process test client) so cookie round-trips happen entirely in memory.
 *
 * Coverage matrix (acceptance criterion from tasks.md line 60):
 *   1. Happy path — POST request-link → GET verify → GET /me.
 *   2. Enumeration safety — unknown email still returns 204; we MUST NOT
 *      reveal that the email is unknown via status code, body, or timing.
 *   3. Invalid email body → 400.
 *   4. Verify with bogus / replayed token → 410.
 *   5. Logout — POST /logout clears cookie; subsequent /me → 401.
 *   6. Audit chain — issue/verify/logout each emit one signed audit row,
 *      and `verifyChain` confirms the chain is intact end-to-end.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { asc } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import { auditLog } from "../../src/db/schema.ts";
import { createClock } from "../../src/lib/time.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import {
  createAuthRoutes,
  type CreateAuthRoutesDeps,
} from "../../src/routes/auth.ts";
import { SESSION_COOKIE_NAME } from "../../src/auth/session.ts";
import type {
  EmailClient,
  EmailSendArgs,
  EmailSendResult,
} from "../../src/email/resend-client.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY =
  "test-key-64-chars-hex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_URL = "https://api.tensol.test";

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

interface CapturedEmail extends EmailSendArgs {
  readonly id: string;
}

function createCapturingEmail(): {
  client: EmailClient;
  sent: CapturedEmail[];
} {
  const sent: CapturedEmail[] = [];
  const client: EmailClient = {
    async send(args: EmailSendArgs): Promise<EmailSendResult> {
      const id = `mock-${sent.length}`;
      sent.push({ ...args, id });
      return { id };
    },
  };
  return { client, sent };
}

function buildApp(opts: {
  db: DB;
  email: EmailClient;
  now: () => number;
  redirectAfterVerify?: string;
}) {
  const app = new Hono();
  const deps: CreateAuthRoutesDeps = {
    db: opts.db,
    email: opts.email,
    signingKey: SIGNING_KEY,
    baseUrl: BASE_URL,
    now: opts.now,
    isProd: false,
    redirectAfterVerify: opts.redirectAfterVerify ?? "/dashboard",
  };
  app.route("/api/auth", createAuthRoutes(deps));
  return app;
}

/** Pluck the magic-link `?token=...` value out of a captured email's HTML. */
function tokenFromEmail(email: CapturedEmail): string {
  const m = email.html.match(/[?&]token=([A-Za-z0-9_-]+)/);
  if (!m) {
    throw new Error(`No token found in email html: ${email.html.slice(0, 200)}`);
  }
  return m[1]!;
}

/** Pluck a single Set-Cookie cookie value by name. */
function cookieValueFromSetCookie(
  res: Response,
  name: string,
): string | undefined {
  const header = res.headers.get("set-cookie");
  if (!header) return undefined;
  // Hono emits one Set-Cookie per cookie; `getSetCookie` is the polite API but
  // returns string[] only on newer runtimes — match by regex to stay portable.
  const re = new RegExp(`(?:^|, )${name}=([^;,\\s]+)`);
  const m = header.match(re);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// Test 1 — Happy path: request-link → verify → /me
// ---------------------------------------------------------------------------
test("T026: full magic-link happy path → /me returns the user", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { client: email, sent } = createCapturingEmail();
  const app = buildApp({ db, email, now: clock.now });

  // POST /api/auth/request-link
  const reqRes = await app.request("/api/auth/request-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ALICE@example.com" }),
  });
  expect(reqRes.status).toBe(204);
  expect(sent.length).toBe(1);
  expect(sent[0]!.to).toBe("alice@example.com"); // normalised
  expect(sent[0]!.html).toContain(`${BASE_URL}/api/auth/verify?token=`);

  const token = tokenFromEmail(sent[0]!);

  // GET /api/auth/verify?token=...
  const verifyRes = await app.request(
    `/api/auth/verify?token=${encodeURIComponent(token)}`,
    { method: "GET", redirect: "manual" },
  );
  expect(verifyRes.status).toBe(302);
  expect(verifyRes.headers.get("location")).toBe("/dashboard");
  const sessionId = cookieValueFromSetCookie(verifyRes, SESSION_COOKIE_NAME);
  expect(sessionId).toBeTruthy();

  // GET /api/auth/me with the cookie attached
  const meRes = await app.request("/api/auth/me", {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
  });
  expect(meRes.status).toBe(200);
  const meBody = (await meRes.json()) as {
    user: { id: string; email: string };
  };
  expect(meBody.user.email).toBe("alice@example.com");
  expect(meBody.user.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
});

// ---------------------------------------------------------------------------
// Test 2 — Enumeration safety: unknown email returns the same 204
// ---------------------------------------------------------------------------
test("T026: unknown email returns the same 204 (no enumeration leak)", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { client: email, sent } = createCapturingEmail();
  const app = buildApp({ db, email, now: clock.now });

  // Two different emails — one we'll later verify, one totally unknown.
  // From the route's POV both look identical at request-link time because
  // users are only materialised at verify; the spec still requires the
  // response shape to be byte-identical regardless of email existence.
  const knownRes = await app.request("/api/auth/request-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "known@example.com" }),
  });
  const unknownRes = await app.request("/api/auth/request-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ghost@example.com" }),
  });
  expect(knownRes.status).toBe(204);
  expect(unknownRes.status).toBe(204);
  // Body must be empty in both cases (204 No Content).
  expect(await knownRes.text()).toBe("");
  expect(await unknownRes.text()).toBe("");
  // Emails were sent for both — we MUST send a link in the unknown case too
  // (otherwise timing or downstream signals leak existence).
  expect(sent.length).toBe(2);
});

// ---------------------------------------------------------------------------
// Test 3 — Invalid email body → 400
// ---------------------------------------------------------------------------
test("T026: malformed email body → 400", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { client: email } = createCapturingEmail();
  const app = buildApp({ db, email, now: clock.now });

  const res = await app.request("/api/auth/request-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Test 4 — Verify with bogus token → 410; replay → 410
// ---------------------------------------------------------------------------
test("T026: bogus token → 410, replayed token → 410", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { client: email, sent } = createCapturingEmail();
  const app = buildApp({ db, email, now: clock.now });

  // Bogus token: never issued → 410 (we conflate invalid/used/expired into
  // 410 so the client cannot probe for which tokens existed).
  const bogus = await app.request(
    "/api/auth/verify?token=does-not-exist-token-value-xyz",
    { method: "GET", redirect: "manual" },
  );
  expect(bogus.status).toBe(410);

  // Issue + verify once, then replay → 410 (used branch).
  await app.request("/api/auth/request-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "replay@example.com" }),
  });
  const token = tokenFromEmail(sent[0]!);
  const first = await app.request(
    `/api/auth/verify?token=${encodeURIComponent(token)}`,
    { method: "GET", redirect: "manual" },
  );
  expect(first.status).toBe(302);

  const replay = await app.request(
    `/api/auth/verify?token=${encodeURIComponent(token)}`,
    { method: "GET", redirect: "manual" },
  );
  expect(replay.status).toBe(410);
});

// ---------------------------------------------------------------------------
// Test 5 — Logout: clears cookie + /me returns 401 afterwards
// ---------------------------------------------------------------------------
test("T026: POST /logout clears the session — /me afterwards → 401", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { client: email, sent } = createCapturingEmail();
  const app = buildApp({ db, email, now: clock.now });

  await app.request("/api/auth/request-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "logout@example.com" }),
  });
  const token = tokenFromEmail(sent[0]!);
  const verifyRes = await app.request(
    `/api/auth/verify?token=${encodeURIComponent(token)}`,
    { method: "GET", redirect: "manual" },
  );
  const sessionId = cookieValueFromSetCookie(verifyRes, SESSION_COOKIE_NAME)!;

  // Sanity: cookie works.
  const meBefore = await app.request("/api/auth/me", {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
  });
  expect(meBefore.status).toBe(200);

  // POST logout.
  const logoutRes = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
  });
  expect(logoutRes.status).toBe(204);
  // Set-Cookie clears the cookie (Max-Age=0 or expires in the past).
  const setCookie = logoutRes.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(SESSION_COOKIE_NAME);
  expect(setCookie.toLowerCase()).toMatch(/max-age=0|expires=/);

  // Re-presenting the (now revoked) cookie → 401.
  const meAfter = await app.request("/api/auth/me", {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
  });
  expect(meAfter.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Test 6 — Audit chain end-to-end: request → succeed → logout
// ---------------------------------------------------------------------------
test("T026: audit chain captures request/success/logout in order", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { client: email, sent } = createCapturingEmail();
  const app = buildApp({ db, email, now: clock.now });

  await app.request("/api/auth/request-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "audit@example.com" }),
  });
  const token = tokenFromEmail(sent[0]!);
  const verifyRes = await app.request(
    `/api/auth/verify?token=${encodeURIComponent(token)}`,
    { method: "GET", redirect: "manual" },
  );
  const sessionId = cookieValueFromSetCookie(verifyRes, SESSION_COOKIE_NAME)!;
  await app.request("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
  });

  const events = db
    .select({ event: auditLog.event })
    .from(auditLog)
    .orderBy(asc(auditLog.id))
    .all();
  expect(events.map((r) => r.event)).toEqual([
    "auth_login_requested",
    "auth_login_succeeded",
    "auth_logout",
  ]);

  // Chain integrity.
  const result = verifyChain(db, SIGNING_KEY);
  expect(result.ok).toBe(true);
  expect(result.rows).toBe(3);
});
