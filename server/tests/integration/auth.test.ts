/**
 * Integration tests for the Telegram deep-link auth routes
 * (`server/src/routes/auth.ts` + `server/src/routes/webhooks-telegram.ts`).
 *
 * Replaces the legacy email-based magic-link tests (pre-pivot 2026-05-19).
 * Each test wires a fresh `:memory:` DB and a Hono app mounting both
 * routers; the webhook handler runs against a captured-message mock notifier
 * so we can assert reply content without hitting Telegram.
 *
 * Coverage matrix:
 *   1. Happy path — issue-link → simulate Telegram /start → poll-link →
 *      resolved + cookie + /me.
 *   2. issue-link rejects malformed usernames (400).
 *   3. poll-link returns pending until consumed, expired after TTL.
 *   4. Legacy /request-link + /verify return 410 Gone.
 *   5. Webhook secret mismatch is dropped (200 with no DB change).
 *   6. Audit chain captures `auth_login_requested` + `auth_login_succeeded`
 *      + `auth_logout` in order.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { asc } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import { auditLog, pendingSignups, users } from "../../src/db/schema.ts";
import { createClock } from "../../src/lib/time.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { createAuthRoutes } from "../../src/routes/auth.ts";
import {
  createWebhookTelegramRouter,
  type WebhookTelegramNotifier,
} from "../../src/routes/webhooks-telegram.ts";
import { SESSION_COOKIE_NAME } from "../../src/auth/session.ts";
import { PENDING_SIGNUP_TTL_MS } from "../../src/auth/magic-link.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY =
  "test-key-64-chars-hex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TELEGRAM_SECRET = "test-telegram-webhook-secret-hex";

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

interface CapturedReply {
  readonly chatId: number;
  readonly text: string;
}

function captureNotifier(): {
  notifier: WebhookTelegramNotifier;
  sent: CapturedReply[];
} {
  const sent: CapturedReply[] = [];
  const notifier: WebhookTelegramNotifier = {
    async sendMessage(args) {
      sent.push({ chatId: args.chatId, text: args.text });
    },
  };
  return { notifier, sent };
}

function buildApp(opts: {
  db: DB;
  now: () => number;
  notifier: WebhookTelegramNotifier;
}) {
  const app = new Hono();
  app.route(
    "/api/auth",
    createAuthRoutes({
      db: opts.db,
      signingKey: SIGNING_KEY,
      now: opts.now,
      isProd: false,
      botUsername: "tensol_leadsbot",
    }),
  );
  app.route(
    "/v1/webhooks",
    createWebhookTelegramRouter({
      db: opts.db,
      signingKey: SIGNING_KEY,
      webhookSecret: TELEGRAM_SECRET,
      notifier: opts.notifier,
      now: opts.now,
    }),
  );
  return app;
}

/** Simulate a Telegram Update for `/start <token>` and POST it to the webhook. */
async function sendStartUpdate(
  app: Hono,
  opts: {
    token: string;
    fromId: number;
    fromUsername?: string;
    secret?: string;
  },
): Promise<Response> {
  const update = {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: 1,
      from: {
        id: opts.fromId,
        ...(opts.fromUsername !== undefined && { username: opts.fromUsername }),
        is_bot: false,
        first_name: "Test",
      },
      chat: { id: opts.fromId },
      text: `/start ${opts.token}`,
    },
  };
  return app.request("/v1/webhooks/telegram-update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": opts.secret ?? TELEGRAM_SECRET,
    },
    body: JSON.stringify(update),
  });
}

function cookieValueFromSetCookie(
  res: Response,
  name: string,
): string | undefined {
  const header = res.headers.get("set-cookie");
  if (!header) return undefined;
  const re = new RegExp(`(?:^|, )${name}=([^;,\\s]+)`);
  const m = header.match(re);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// Test 1 — Happy path
// ---------------------------------------------------------------------------
test("telegram-auth: full happy path → issue-link → /start → poll-link → /me", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { notifier, sent } = captureNotifier();
  const app = buildApp({ db, now: clock.now, notifier });

  // 1. POST /issue-link
  const issueRes = await app.request("/api/auth/issue-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram_username: "@kapital0" }),
  });
  expect(issueRes.status).toBe(200);
  const issueBody = (await issueRes.json()) as {
    deep_link: string;
    token: string;
    telegram_username: string;
    expires_at: number;
  };
  expect(issueBody.deep_link).toBe(
    `https://t.me/tensol_leadsbot?start=${issueBody.token}`,
  );
  expect(issueBody.telegram_username).toBe("kapital0");

  // 2. poll-link before /start → pending
  const pendingRes = await app.request(
    `/api/auth/poll-link?token=${encodeURIComponent(issueBody.token)}`,
  );
  expect(pendingRes.status).toBe(200);
  expect((await pendingRes.json()) as { status: string }).toEqual({
    status: "pending",
    expires_at: issueBody.expires_at,
  });

  // 3. Simulate Telegram delivering `/start <token>`
  const hookRes = await sendStartUpdate(app, {
    token: issueBody.token,
    fromId: 496866748,
    fromUsername: "kapital0",
  });
  expect(hookRes.status).toBe(200);
  expect(sent.length).toBe(1);
  expect(sent[0]!.chatId).toBe(496866748);
  expect(sent[0]!.text).toContain("Готово");

  // 4. poll-link → resolved + session cookie set
  const resolvedRes = await app.request(
    `/api/auth/poll-link?token=${encodeURIComponent(issueBody.token)}`,
  );
  expect(resolvedRes.status).toBe(200);
  const resolvedBody = (await resolvedRes.json()) as {
    status: string;
    session_id: string;
  };
  expect(resolvedBody.status).toBe("resolved");
  expect(resolvedBody.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  const cookieSession = cookieValueFromSetCookie(
    resolvedRes,
    SESSION_COOKIE_NAME,
  );
  expect(cookieSession).toBe(resolvedBody.session_id);

  // 5. GET /me with the cookie
  const meRes = await app.request("/api/auth/me", {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookieSession}` },
  });
  expect(meRes.status).toBe(200);
  const meBody = (await meRes.json()) as { user: { id: string; email: string } };
  expect(meBody.user.email).toBe("kapital0@telegram.local");
  expect(meBody.user.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

  // 6. users row + pending_signups row state
  const userRow = db.select().from(users).all()[0]!;
  expect(userRow.telegramUserId).toBe(496866748);
  expect(userRow.telegramUsername).toBe("kapital0");
  const pendingRow = db.select().from(pendingSignups).all()[0]!;
  expect(pendingRow.status).toBe("resolved");
  expect(pendingRow.chatId).toBe(496866748);
});

// ---------------------------------------------------------------------------
// Test 2 — Malformed username → 400
// ---------------------------------------------------------------------------
test("telegram-auth: issue-link rejects malformed usernames", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { notifier } = captureNotifier();
  const app = buildApp({ db, now: clock.now, notifier });

  const cases = [
    "abc", // too short
    "a".repeat(40), // too long
    "has spaces",
    "has-dashes",
    "with$symbol",
  ];
  for (const username of cases) {
    const res = await app.request("/api/auth/issue-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegram_username: username }),
    });
    expect(res.status).toBe(400);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — poll-link returns expired after TTL elapses
// ---------------------------------------------------------------------------
test("telegram-auth: poll-link returns expired after TTL", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { notifier } = captureNotifier();
  const app = buildApp({ db, now: clock.now, notifier });

  const issueRes = await app.request("/api/auth/issue-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram_username: "alice" }),
  });
  const { token } = (await issueRes.json()) as { token: string };

  // Advance clock past TTL
  clock.advance(PENDING_SIGNUP_TTL_MS + 1_000);

  const res = await app.request(
    `/api/auth/poll-link?token=${encodeURIComponent(token)}`,
  );
  expect(res.status).toBe(200);
  expect((await res.json()) as { status: string }).toEqual({
    status: "expired",
  });

  // Replay /start after expiry → reply EXPIRED, no session
  const hookRes = await sendStartUpdate(app, {
    token,
    fromId: 12345,
    fromUsername: "alice",
  });
  expect(hookRes.status).toBe(200);
});

// ---------------------------------------------------------------------------
// Test 4 — Legacy endpoints return 410 Gone
// ---------------------------------------------------------------------------
test("telegram-auth: legacy /request-link + /verify return 410", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { notifier } = captureNotifier();
  const app = buildApp({ db, now: clock.now, notifier });

  const reqLink = await app.request("/api/auth/request-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "x@y.com" }),
  });
  expect(reqLink.status).toBe(410);

  const verify = await app.request("/api/auth/verify?token=anything");
  expect(verify.status).toBe(410);
});

// ---------------------------------------------------------------------------
// Test 5 — Webhook secret mismatch is dropped silently with 200
// ---------------------------------------------------------------------------
test("telegram-auth: webhook with bad secret returns 200 but no DB change", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { notifier, sent } = captureNotifier();
  const app = buildApp({ db, now: clock.now, notifier });

  const issueRes = await app.request("/api/auth/issue-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram_username: "bob_abc" }),
  });
  const { token } = (await issueRes.json()) as { token: string };

  const hookRes = await sendStartUpdate(app, {
    token,
    fromId: 999,
    fromUsername: "bob_abc",
    secret: "WRONG-SECRET",
  });
  expect(hookRes.status).toBe(200);
  // No reply was sent because the body was never parsed
  expect(sent.length).toBe(0);
  // Pending row still pending
  const row = db.select().from(pendingSignups).all()[0]!;
  expect(row.status).toBe("pending");
});

// ---------------------------------------------------------------------------
// Test 6 — Audit chain end-to-end
// ---------------------------------------------------------------------------
test("telegram-auth: audit chain captures request/success/logout", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { notifier } = captureNotifier();
  const app = buildApp({ db, now: clock.now, notifier });

  // 1. issue
  const issueRes = await app.request("/api/auth/issue-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram_username: "audit_user" }),
  });
  const { token } = (await issueRes.json()) as { token: string };

  // 2. /start (consume)
  await sendStartUpdate(app, {
    token,
    fromId: 555,
    fromUsername: "audit_user",
  });

  // 3. poll → grab cookie
  const pollRes = await app.request(
    `/api/auth/poll-link?token=${encodeURIComponent(token)}`,
  );
  const cookie = cookieValueFromSetCookie(pollRes, SESSION_COOKIE_NAME)!;

  // 4. logout
  const logoutRes = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  });
  expect(logoutRes.status).toBe(204);

  // Audit row order: requested → succeeded → logout
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

  // Chain integrity
  const result = verifyChain(db, SIGNING_KEY);
  expect(result.ok).toBe(true);
  expect(result.rows).toBe(3);
});

// ---------------------------------------------------------------------------
// Test 7 — Replay /start after resolved → "used" → reply expired
// ---------------------------------------------------------------------------
test("telegram-auth: replaying /start after consumption replies expired", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const { notifier, sent } = captureNotifier();
  const app = buildApp({ db, now: clock.now, notifier });

  const issueRes = await app.request("/api/auth/issue-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram_username: "replay_user" }),
  });
  const { token } = (await issueRes.json()) as { token: string };

  // First /start succeeds
  await sendStartUpdate(app, {
    token,
    fromId: 777,
    fromUsername: "replay_user",
  });
  expect(sent[0]!.text).toContain("Готово");

  // Second /start with same token → reply EXPIRED
  await sendStartUpdate(app, {
    token,
    fromId: 777,
    fromUsername: "replay_user",
  });
  expect(sent.length).toBe(2);
  expect(sent[1]!.text).toContain("устарела");

  // Only one session minted
  const userRows = db.select().from(users).all();
  expect(userRows.length).toBe(1);
});
