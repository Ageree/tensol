/**
 * Unit tests for the Telegram deep-link auth core (`magic-link.ts`).
 *
 * These tests bypass the HTTP layer and drive `issueLink` / `consumeLink` /
 * `pollLink` directly — the integration suite in
 * `tests/integration/auth.test.ts` covers the end-to-end HTTP path. Here we
 * pin the function-level contract: result shapes, DB side-effects, and the
 * username-mismatch / expired / replay branches that the route doesn't
 * surface in isolation.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDb, type DB } from "../db/client.ts";
import {
  pendingSignups,
  users as usersTable,
  sessions as sessionsTable,
} from "../db/schema.ts";
import { createClock } from "../lib/time.ts";
import {
  consumeLink,
  issueLink,
  pollLink,
  PENDING_SIGNUP_TTL_MS,
  SESSION_TTL_MS,
  TelegramUsernameSchema,
} from "./magic-link.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY =
  "test-key-64-chars-hex-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

function freshDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  return db;
}

test("TelegramUsernameSchema: strips @, lowercases, enforces 5-32 chars", () => {
  expect(TelegramUsernameSchema.parse("@KAPITAL0")).toBe("kapital0");
  expect(TelegramUsernameSchema.parse("alice_123")).toBe("alice_123");
  expect(() => TelegramUsernameSchema.parse("abc")).toThrow();
  expect(() => TelegramUsernameSchema.parse("a".repeat(33))).toThrow();
  expect(() => TelegramUsernameSchema.parse("has space")).toThrow();
  expect(() => TelegramUsernameSchema.parse("dash-name")).toThrow();
});

test("issueLink: persists pending_signups + returns deep-link with bot username", async () => {
  const db = freshDb();
  const clock = createClock(1_700_000_000_000);

  const result = await issueLink(
    { telegramUsername: "@kapital0" },
    { db, signingKey: SIGNING_KEY, now: clock.now, botUsername: "tensol_leadsbot" },
  );

  expect(result.telegramUsername).toBe("kapital0");
  expect(result.deepLink).toBe(
    `https://t.me/tensol_leadsbot?start=${result.token}`,
  );
  expect(result.expiresAt).toBe(clock.now() + PENDING_SIGNUP_TTL_MS);

  const rows = db.select().from(pendingSignups).all();
  expect(rows.length).toBe(1);
  expect(rows[0]!.status).toBe("pending");
  expect(rows[0]!.telegramUsername).toBe("kapital0");
  expect(rows[0]!.token).toBe(result.token);
});

test("consumeLink: happy path creates user + session + flips row to resolved", async () => {
  const db = freshDb();
  const clock = createClock(1_700_000_000_000);

  const issued = await issueLink(
    { telegramUsername: "alice_a" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );

  const consumed = await consumeLink(
    {
      token: issued.token,
      telegramUserId: 42,
      telegramUsername: "alice_a",
    },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );

  expect(consumed.ok).toBe(true);
  if (!consumed.ok) return;
  expect(consumed.sessionExpiresAt).toBe(clock.now() + SESSION_TTL_MS);
  expect(consumed.telegramUsername).toBe("alice_a");

  const u = db.select().from(usersTable).all()[0]!;
  expect(u.telegramUserId).toBe(42);
  expect(u.telegramUsername).toBe("alice_a");
  expect(u.email).toBe("alice_a@telegram.local");

  const s = db.select().from(sessionsTable).all()[0]!;
  expect(s.id).toBe(consumed.sessionId);
  expect(s.userId).toBe(u.id);

  const p = db.select().from(pendingSignups).all()[0]!;
  expect(p.status).toBe("resolved");
  expect(p.chatId).toBe(42);
});

test("consumeLink: returns expired when token TTL elapsed", async () => {
  const db = freshDb();
  const clock = createClock(1_700_000_000_000);
  const issued = await issueLink(
    { telegramUsername: "bob_bob" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  clock.advance(PENDING_SIGNUP_TTL_MS + 1);

  const r = await consumeLink(
    { token: issued.token, telegramUserId: 1, telegramUsername: "bob_bob" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("expired");
});

test("consumeLink: returns used on replay", async () => {
  const db = freshDb();
  const clock = createClock(1_700_000_000_000);
  const issued = await issueLink(
    { telegramUsername: "charlie_c" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  await consumeLink(
    { token: issued.token, telegramUserId: 7, telegramUsername: "charlie_c" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  const second = await consumeLink(
    { token: issued.token, telegramUserId: 7, telegramUsername: "charlie_c" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.reason).toBe("used");
});

test("consumeLink: returns invalid for unknown token", async () => {
  const db = freshDb();
  const clock = createClock(1_700_000_000_000);
  const r = await consumeLink(
    { token: "NOT_A_REAL_TOKEN", telegramUserId: 1, telegramUsername: "dave_d" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("invalid");
});

test("consumeLink: returns username_mismatch when Telegram username differs", async () => {
  const db = freshDb();
  const clock = createClock(1_700_000_000_000);
  const issued = await issueLink(
    { telegramUsername: "eve_eve" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  const r = await consumeLink(
    {
      token: issued.token,
      telegramUserId: 1,
      telegramUsername: "frank_frank", // wrong account!
    },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("username_mismatch");
});

test("consumeLink: existing user (returning login) creates session without duplicate user row", async () => {
  const db = freshDb();
  const clock = createClock(1_700_000_000_000);

  // First login
  const issued1 = await issueLink(
    { telegramUsername: "returning_user" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  await consumeLink(
    {
      token: issued1.token,
      telegramUserId: 100,
      telegramUsername: "returning_user",
    },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );

  // Second login
  const issued2 = await issueLink(
    { telegramUsername: "returning_user" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  const r = await consumeLink(
    {
      token: issued2.token,
      telegramUserId: 100,
      telegramUsername: "returning_user",
    },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(r.ok).toBe(true);

  // Only one user row, but two session rows
  expect(db.select().from(usersTable).all().length).toBe(1);
  expect(db.select().from(sessionsTable).all().length).toBe(2);
});

test("pollLink: returns pending → resolved → invalid for missing/post-consume", async () => {
  const db = freshDb();
  const clock = createClock(1_700_000_000_000);

  // unknown token
  const unknown = await pollLink(
    { token: "ZZZZZ" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(unknown.status).toBe("invalid");

  const issued = await issueLink(
    { telegramUsername: "poll_user" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  const pending = await pollLink(
    { token: issued.token },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(pending.status).toBe("pending");

  await consumeLink(
    {
      token: issued.token,
      telegramUserId: 200,
      telegramUsername: "poll_user",
    },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  const resolved = await pollLink(
    { token: issued.token },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(resolved.status).toBe("resolved");
  if (resolved.status === "resolved") {
    expect(resolved.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  }
});

test("pollLink: returns expired after TTL for un-consumed token", async () => {
  const db = freshDb();
  const clock = createClock(1_700_000_000_000);
  const issued = await issueLink(
    { telegramUsername: "expire_user" },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  clock.advance(PENDING_SIGNUP_TTL_MS + 1);
  const r = await pollLink(
    { token: issued.token },
    { db, signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(r.status).toBe("expired");
});
