/**
 * T035 — DNS-verify service tests (token generation + polling state machine).
 *
 * Pins down:
 *   - `generateToken` shape: `tensol-verify-<26-char-ulid>` (Crockford-32)
 *   - `checkVerification` success path:
 *       resolver agrees on TXT containing dns_verify_token →
 *       persists dns_verified_at + bumps dns_check_attempts +
 *       emits signed `dns_verified` audit row.
 *   - `checkVerification` failure paths:
 *       resolver returns null (no agreement / resolver error) →
 *       bumps dns_check_attempts, leaves dns_verified_at NULL,
 *       returns verified:false + remaining time.
 *   - `checkVerification` 30-min hard timeout → emits signed
 *       `dns_verify_failed` audit with reason=timeout.
 *   - Dev bypass:
 *       `TENSOL_DEV_DNS_BYPASS=true` short-circuits to verified:true after
 *       ≥5 sec elapsed since `dns_verify_requested_at`.
 *       Unset env → real resolver path runs.
 *
 * Notes on test isolation:
 *   - We seed scan_orders with status='dns_pending' and the token already
 *     written to dns_verify_token (matches the wizard flow: request →
 *     poll loop).
 *   - dnsVerifyRequestedAt is the anchor for the 30-min timeout window
 *     (per data-model E2 state machine: "30-min timeout → failed").
 *   - There is NO `dns_last_error` column in 0010 (verified against
 *     schema.ts at commit 90bd3e6). `lastError` lives only on the result.
 *
 * Mirrors test infra used by `free-tier/service.test.ts`.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import {
  users as usersTable,
  scanOrders as scanOrdersTable,
  auditLog as auditLogTable,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import {
  generateToken,
  checkVerification,
  VERIFY_TIMEOUT_MS,
  DEV_BYPASS_MIN_ELAPSED_MS,
} from "./service.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-dns-verify";

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

function seedUser(db: DB, ts: number): string {
  const id = ulid(ts);
  db.insert(usersTable)
    .values({ id, email: `${id}@test.local`, createdAt: ts })
    .run();
  return id;
}

interface SeedOrderArgs {
  userId: string;
  ts: number;
  token: string;
  domain?: string;
  requestedAt?: number | null;
  attempts?: number;
  verifiedAt?: number | null;
}

function seedScanOrder(db: DB, args: SeedOrderArgs): string {
  const id = ulid(args.ts);
  db.insert(scanOrdersTable)
    .values({
      id,
      userId: args.userId,
      status: "dns_pending",
      tier: "quick",
      primaryDomain: args.domain ?? "example.com",
      dnsVerifyToken: args.token,
      dnsVerifyRequestedAt: args.requestedAt ?? args.ts,
      dnsVerifiedAt: args.verifiedAt ?? null,
      dnsCheckAttempts: args.attempts ?? 0,
      createdAt: args.ts,
      updatedAt: args.ts,
    })
    .run();
  return id;
}

function readOrder(db: DB, id: string) {
  return db
    .select()
    .from(scanOrdersTable)
    .where(eq(scanOrdersTable.id, id))
    .all()[0];
}

function readAuditEvents(db: DB, orderId: string): string[] {
  return db
    .select({ event: auditLogTable.event, metadata: auditLogTable.metadataJson })
    .from(auditLogTable)
    .all()
    .filter((r) => {
      try {
        const m = JSON.parse(r.metadata) as { scan_order_id?: string };
        return m.scan_order_id === orderId;
      } catch {
        return false;
      }
    })
    .map((r) => r.event);
}

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------

describe("generateToken", () => {
  test("produces tensol-verify-<26-char-Crockford-32-ulid> shape", () => {
    const t = generateToken("01HXYZSAMPLEORDERIDFAKE000");
    expect(t).toMatch(/^tensol-verify-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("is distinct across calls (fresh ULID, not derived from orderId)", () => {
    const id = "01HXYZSAMPLEORDERIDFAKE000";
    const a = generateToken(id);
    const b = generateToken(id);
    expect(a).not.toBe(b);
  });

  test("total token length = 'tensol-verify-' (14) + 26 = 40 chars", () => {
    const t = generateToken("x");
    expect(t.length).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// checkVerification — already verified short-circuit
// ---------------------------------------------------------------------------

describe("checkVerification — already verified", () => {
  test("returns verified:true immediately, no resolver call, no new audit", async () => {
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, {
      userId,
      ts,
      token,
      verifiedAt: ts + 1_000,
      attempts: 3,
    });

    let resolverCalls = 0;
    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + 5_000,
      resolver: async () => {
        resolverCalls++;
        return [token];
      },
    });

    expect(result.verified).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.remainingSec).toBe(0);
    expect(result.lastError).toBeNull();
    expect(resolverCalls).toBe(0);
    expect(readAuditEvents(db, orderId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkVerification — success path
// ---------------------------------------------------------------------------

describe("checkVerification — production success path", () => {
  test("verified=true when resolver returns TXT containing the token", async () => {
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token });

    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + 10_000,
      resolver: async () => [token, "unrelated=other"],
    });

    expect(result.verified).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.lastError).toBeNull();
  });

  test("persists dns_verified_at and increments dns_check_attempts", async () => {
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token, attempts: 2 });

    await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + 10_000,
      resolver: async () => [token],
    });

    const row = readOrder(db, orderId);
    expect(row?.dnsVerifiedAt).toBe(ts + 10_000);
    expect(row?.dnsCheckAttempts).toBe(3);
  });

  test("emits signed dns_verified audit on success", async () => {
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token });

    await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + 10_000,
      resolver: async () => [token],
    });

    const events = readAuditEvents(db, orderId);
    expect(events).toContain("dns_verified");
  });

  test("verified=false when resolver returns TXT records but token not present", async () => {
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token });

    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + 10_000,
      resolver: async () => ["v=spf1 -all"],
    });

    expect(result.verified).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.lastError).toBeNull();
    expect(result.remainingSec).toBeGreaterThan(0);
    expect(readOrder(db, orderId)?.dnsVerifiedAt).toBeNull();
    expect(readAuditEvents(db, orderId)).not.toContain("dns_verified");
  });

  test("verified=false when resolver returns null (no agreement)", async () => {
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token });

    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + 10_000,
      resolver: async () => null,
    });

    expect(result.verified).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.lastError).toBeNull();
  });

  test("surfaces resolver thrown error as lastError without verifying", async () => {
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token });

    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + 10_000,
      resolver: async () => {
        throw new Error("EAI_AGAIN");
      },
    });

    expect(result.verified).toBe(false);
    expect(result.lastError).toBe("EAI_AGAIN");
    expect(result.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// checkVerification — 30-min timeout
// ---------------------------------------------------------------------------

describe("checkVerification — 30-min timeout", () => {
  test("returns verified:false and emits dns_verify_failed when window elapsed", async () => {
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, {
      userId,
      ts,
      token,
      requestedAt: ts,
    });

    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + VERIFY_TIMEOUT_MS + 1,
      resolver: async () => [token], // resolver would say yes, but timeout wins
    });

    expect(result.verified).toBe(false);
    expect(result.remainingSec).toBe(0);
    expect(result.lastError).toBe("timeout");

    const events = readAuditEvents(db, orderId);
    expect(events).toContain("dns_verify_failed");
    expect(events).not.toContain("dns_verified");

    expect(readOrder(db, orderId)?.dnsVerifiedAt).toBeNull();
  });

  test("just inside the window still polls the resolver", async () => {
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, {
      userId,
      ts,
      token,
      requestedAt: ts,
    });

    let calls = 0;
    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + VERIFY_TIMEOUT_MS - 1,
      resolver: async () => {
        calls++;
        return [token];
      },
    });

    expect(calls).toBe(1);
    expect(result.verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dev bypass
// ---------------------------------------------------------------------------

describe("checkVerification — TENSOL_DEV_DNS_BYPASS", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.TENSOL_DEV_DNS_BYPASS;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.TENSOL_DEV_DNS_BYPASS;
    else process.env.TENSOL_DEV_DNS_BYPASS = savedEnv;
  });

  test("auto-verifies after >=5 sec elapsed when env=true (no resolver call)", async () => {
    process.env.TENSOL_DEV_DNS_BYPASS = "true";
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token, requestedAt: ts });

    let calls = 0;
    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + DEV_BYPASS_MIN_ELAPSED_MS,
      resolver: async () => {
        calls++;
        return null;
      },
    });

    expect(calls).toBe(0);
    expect(result.verified).toBe(true);
    expect(readOrder(db, orderId)?.dnsVerifiedAt).toBe(
      ts + DEV_BYPASS_MIN_ELAPSED_MS,
    );
    expect(readAuditEvents(db, orderId)).toContain("dns_verified");
  });

  test("does NOT bypass before 5 sec elapsed — real resolver runs", async () => {
    process.env.TENSOL_DEV_DNS_BYPASS = "true";
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token, requestedAt: ts });

    let calls = 0;
    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + (DEV_BYPASS_MIN_ELAPSED_MS - 1),
      resolver: async () => {
        calls++;
        return null;
      },
    });

    expect(calls).toBe(1);
    expect(result.verified).toBe(false);
  });

  test("unset env → real resolver path even at long elapsed time", async () => {
    delete process.env.TENSOL_DEV_DNS_BYPASS;
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token, requestedAt: ts });

    let calls = 0;
    const result = await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + 60_000,
      resolver: async () => {
        calls++;
        return null;
      },
    });

    expect(calls).toBe(1);
    expect(result.verified).toBe(false);
  });

  test("env=other-truthy-string is NOT bypass (strict 'true' only)", async () => {
    process.env.TENSOL_DEV_DNS_BYPASS = "1";
    const db = freshMemDb();
    const ts = 1_700_000_000_000;
    const userId = seedUser(db, ts);
    const token = generateToken("seed");
    const orderId = seedScanOrder(db, { userId, ts, token, requestedAt: ts });

    let calls = 0;
    await checkVerification(db, orderId, {
      key: KEY,
      now: () => ts + 30_000,
      resolver: async () => {
        calls++;
        return null;
      },
    });

    expect(calls).toBe(1);
  });
});
