/**
 * T021 — Magic-link issue + verify tests.
 *
 * Pins down:
 *   1. Email validation is Zod-strict (rejects malformed, normalises to
 *      lower-case + trimmed).
 *   2. `issueLink` stores the HMAC of the raw token (NOT the raw token
 *      itself) in `magic_link_tokens.token`. The returned `token` field is
 *      the only place the raw value is observable.
 *   3. `verifyLink` is atomic redemption: success creates session +
 *      find-or-creates user; subsequent verifies of the same token return
 *      `{ ok:false, reason:"used", code:410 }`.
 *   4. Expired tokens return `{ ok:false, reason:"expired", code:410 }`.
 *   5. Race protection: two concurrent verifies of the same token serialize
 *      via `BEGIN IMMEDIATE` — exactly one succeeds, the other observes
 *      `used_at` set and returns `used`.
 *   6. Audit emissions: `issueLink` writes `auth_login_requested`;
 *      `verifyLink` writes `auth_login_succeeded` on the happy path and
 *      `auth_login_failed` (with reason metadata) on used/expired paths.
 *
 * Setup mirrors `audit/emit.test.ts`: open a fresh DB (file-based for the
 * concurrency test, `:memory:` for everything else) and apply the bundled
 * migration SQL directly.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import { magicLinkTokens, sessions, users } from "../db/schema.ts";
import { auditLog } from "../db/schema.ts";
import { createClock } from "../lib/time.ts";
import { hmacSha256 } from "../lib/crypto.ts";
import { issueLink, verifyLink } from "./magic-link.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY =
  "test-key-64-chars-hex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .sql migrations found in ${MIGRATIONS_DIR}`);
  }
  return files
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

function applyMigrations(db: DB): void {
  (db.$client as Database).exec(migrationSql());
}

function freshMemDb(): DB {
  const db = createDb(":memory:");
  applyMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------
test("issueLink rejects malformed email with ZodError", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);

  let threw: unknown = null;
  try {
    await issueLink(db, "not-an-email", {
      signingKey: KEY,
      now: clock.now,
    });
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeInstanceOf(z.ZodError);
});

// ---------------------------------------------------------------------------
// issueLink — token stored as HMAC, raw returned
// ---------------------------------------------------------------------------
test("issueLink inserts hashed token row and returns raw token + expires_at", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);

  const result = await issueLink(db, "Alice@Example.COM ", {
    signingKey: KEY,
    now: clock.now,
  });

  // base64url-encoded 32 bytes → 43 chars, no padding.
  expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.expires_at).toBe(1_700_000_000_000 + 15 * 60 * 1000);

  const rows = db.select().from(magicLinkTokens).all();
  expect(rows.length).toBe(1);
  // The DB stores the HMAC, NOT the raw token.
  expect(rows[0]!.token).not.toBe(result.token);
  expect(rows[0]!.token).toBe(hmacSha256(KEY, result.token));
  // Email normalised: lower-case + trimmed.
  expect(rows[0]!.email).toBe("alice@example.com");
  expect(rows[0]!.expiresAt).toBe(result.expires_at);
  expect(rows[0]!.usedAt).toBeNull();

  // Audit row: auth_login_requested
  const audits = db.select().from(auditLog).all();
  const requested = audits.filter((a) => a.event === "auth_login_requested");
  expect(requested.length).toBe(1);
  expect(requested[0]!.outcome).toBe("success");
  const meta = JSON.parse(requested[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.email).toBe("alice@example.com");
});

// ---------------------------------------------------------------------------
// verifyLink — happy path
// ---------------------------------------------------------------------------
test("verifyLink happy path creates user + session, marks token used, emits audits", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);

  const issued = await issueLink(db, "bob@example.com", {
    signingKey: KEY,
    now: clock.now,
  });

  clock.advance(1000);
  const verified = await verifyLink(db, issued.token, {
    signingKey: KEY,
    now: clock.now,
  });

  expect(verified.ok).toBe(true);
  if (!verified.ok) return;
  expect(verified.user.email).toBe("bob@example.com");
  expect(verified.user.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(verified.session.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(verified.session.expires_at).toBe(
    1_700_000_000_000 + 1000 + 30 * 24 * 60 * 60 * 1000,
  );

  // Token row now marked used.
  const tokenRows = db.select().from(magicLinkTokens).all();
  expect(tokenRows.length).toBe(1);
  expect(tokenRows[0]!.usedAt).toBe(1_700_000_000_000 + 1000);

  // User + session rows persisted.
  const userRows = db
    .select()
    .from(users)
    .where(eq(users.email, "bob@example.com"))
    .all();
  expect(userRows.length).toBe(1);
  const sessionRows = db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userRows[0]!.id))
    .all();
  expect(sessionRows.length).toBe(1);

  // Two audit rows: requested + succeeded.
  const audits = db.select().from(auditLog).all();
  const events = audits.map((a) => a.event);
  expect(events).toContain("auth_login_requested");
  expect(events).toContain("auth_login_succeeded");
  const succeeded = audits.find((a) => a.event === "auth_login_succeeded");
  expect(succeeded?.outcome).toBe("success");
  expect(succeeded?.userId).toBe(userRows[0]!.id);
});

// ---------------------------------------------------------------------------
// verifyLink — invalid token
// ---------------------------------------------------------------------------
test("verifyLink with unknown token returns { ok:false, reason:invalid, code:404 }", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);

  const result = await verifyLink(db, "non-existent-token-bytes-xx", {
    signingKey: KEY,
    now: clock.now,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("invalid");
  expect(result.code).toBe(404);
});

// ---------------------------------------------------------------------------
// verifyLink — expired token
// ---------------------------------------------------------------------------
test("verifyLink with expired token returns { ok:false, reason:expired, code:410 } and emits failed audit", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);

  const issued = await issueLink(db, "carol@example.com", {
    signingKey: KEY,
    now: clock.now,
  });

  // Jump past 15min TTL.
  clock.advance(16 * 60 * 1000);

  const result = await verifyLink(db, issued.token, {
    signingKey: KEY,
    now: clock.now,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("expired");
  expect(result.code).toBe(410);

  // No session created.
  const sessionRows = db.select().from(sessions).all();
  expect(sessionRows.length).toBe(0);

  // auth_login_failed emitted with reason=expired.
  const audits = db.select().from(auditLog).all();
  const failed = audits.find((a) => a.event === "auth_login_failed");
  expect(failed).toBeDefined();
  expect(failed!.outcome).toBe("failure");
  const meta = JSON.parse(failed!.metadataJson) as Record<string, unknown>;
  expect(meta.reason).toBe("expired");
});

// ---------------------------------------------------------------------------
// verifyLink — double redemption
// ---------------------------------------------------------------------------
test("verifyLink — second redemption of the same token returns { ok:false, reason:used, code:410 }", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);

  const issued = await issueLink(db, "dave@example.com", {
    signingKey: KEY,
    now: clock.now,
  });

  const first = await verifyLink(db, issued.token, {
    signingKey: KEY,
    now: clock.now,
  });
  expect(first.ok).toBe(true);

  const second = await verifyLink(db, issued.token, {
    signingKey: KEY,
    now: clock.now,
  });
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.reason).toBe("used");
  expect(second.code).toBe(410);

  // Only one session — not two.
  const sessionRows = db.select().from(sessions).all();
  expect(sessionRows.length).toBe(1);

  // auth_login_failed with reason=used emitted.
  const audits = db.select().from(auditLog).all();
  const failed = audits.find(
    (a) =>
      a.event === "auth_login_failed" &&
      (JSON.parse(a.metadataJson) as Record<string, unknown>).reason === "used",
  );
  expect(failed).toBeDefined();
});

// ---------------------------------------------------------------------------
// find-or-create user — second verify for same email re-uses user row
// ---------------------------------------------------------------------------
test("verifyLink — second issue+verify for same email re-uses existing user_id", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);

  const first = await issueLink(db, "eve@example.com", {
    signingKey: KEY,
    now: clock.now,
  });
  const firstVerified = await verifyLink(db, first.token, {
    signingKey: KEY,
    now: clock.now,
  });
  expect(firstVerified.ok).toBe(true);
  if (!firstVerified.ok) return;

  clock.advance(1000);
  const second = await issueLink(db, "eve@example.com", {
    signingKey: KEY,
    now: clock.now,
  });
  const secondVerified = await verifyLink(db, second.token, {
    signingKey: KEY,
    now: clock.now,
  });
  expect(secondVerified.ok).toBe(true);
  if (!secondVerified.ok) return;

  // Same user_id, different session_id.
  expect(secondVerified.user.id).toBe(firstVerified.user.id);
  expect(secondVerified.session.id).not.toBe(firstVerified.session.id);

  const userRows = db
    .select()
    .from(users)
    .where(eq(users.email, "eve@example.com"))
    .all();
  expect(userRows.length).toBe(1);
});

// ---------------------------------------------------------------------------
// Race protection: two concurrent verifies of the same token
// ---------------------------------------------------------------------------
test("verifyLink — concurrent verifies on a single token: exactly one succeeds", async () => {
  // Concurrency test needs two open connections to a shared on-disk DB.
  const tmp = mkdtempSync(join(tmpdir(), "tensol-magic-link-race-"));
  const dbPath = join(tmp, "test.db");
  try {
    const db1 = createDb(dbPath);
    const db2 = createDb(dbPath);
    applyMigrations(db1);
    const clock = createClock(1_700_000_000_000);

    const issued = await issueLink(db1, "frank@example.com", {
      signingKey: KEY,
      now: clock.now,
    });

    // Fire both verifies in parallel — withTx + BEGIN IMMEDIATE must
    // serialize them.
    const [a, b] = await Promise.all([
      verifyLink(db1, issued.token, { signingKey: KEY, now: clock.now }),
      verifyLink(db2, issued.token, { signingKey: KEY, now: clock.now }),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    const failures = [a, b].filter((r) => !r.ok);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    const fail = failures[0];
    if (fail && !fail.ok) {
      expect(fail.reason).toBe("used");
      expect(fail.code).toBe(410);
    }

    // Exactly one session row.
    const sessionRows = db1.select().from(sessions).all();
    expect(sessionRows.length).toBe(1);

    db1.$client.close();
    db2.$client.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
