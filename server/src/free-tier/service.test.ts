/**
 * T031 — Free-tier quota service tests.
 *
 * Pins down free-Quick quota semantics per spec FR-013..FR-017:
 *   - FR-013: one free Quick scan per rolling 7-day window
 *   - FR-014: atomic gating against rapid double-click race
 *   - FR-016: refund on timeout/cancel/provision-failure/scan-timeout
 *   - FR-017: NO refund on zero-findings completion (out of scope here;
 *     handled by caller — service.refund() is unconditional helper)
 *
 * Window: exactly 7 * 24 * 60 * 60 * 1000 ms (168 hours).
 *
 * Concurrency note: bun:sqlite serializes writes on a single connection,
 * so the "concurrent Promise.all" test is a faithful proxy for double-click
 * — the conditional UPDATE is single-statement so SQLite's per-statement
 * locking guarantees only one matches the WHERE.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import { users as usersTable } from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import {
  canStartFreeQuick,
  consumeFreeQuickQuota,
  refundFreeQuickQuota,
  FREE_TIER_WINDOW_MS,
} from "./service.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

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

function seedUser(db: DB, ts: number): string {
  const id = ulid(ts);
  db.insert(usersTable)
    .values({ id, email: `${id}@test.local`, createdAt: ts })
    .run();
  return id;
}

function readUser(db: DB, userId: string) {
  return db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .all()[0];
}

// ---------------------------------------------------------------------------
// FREE_TIER_WINDOW_MS sanity
// ---------------------------------------------------------------------------
test("FREE_TIER_WINDOW_MS == 7 * 24 * 60 * 60 * 1000 (168h)", () => {
  expect(FREE_TIER_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  expect(FREE_TIER_WINDOW_MS).toBe(604_800_000);
});

// ---------------------------------------------------------------------------
// canStartFreeQuick
// ---------------------------------------------------------------------------
describe("canStartFreeQuick", () => {
  test("returns true for fresh user (consumed_at is null)", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    expect(await canStartFreeQuick(db, userId, now)).toBe(true);
  });

  test("returns false within 7d of consume", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    const consumed = await consumeFreeQuickQuota(db, userId, now);
    expect(consumed.consumed).toBe(true);

    // 1 hour later
    expect(await canStartFreeQuick(db, userId, now + 60 * 60 * 1000)).toBe(
      false,
    );
    // 6 days + 23 hours later
    expect(
      await canStartFreeQuick(
        db,
        userId,
        now + FREE_TIER_WINDOW_MS - 60 * 60 * 1000,
      ),
    ).toBe(false);
    // Exactly 7d later (boundary: consumed_at < now-7d means equal does NOT
    // unlock — strict <).
    expect(
      await canStartFreeQuick(db, userId, now + FREE_TIER_WINDOW_MS),
    ).toBe(false);
  });

  test("returns true 7d+1ms after consume", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    await consumeFreeQuickQuota(db, userId, now);

    expect(
      await canStartFreeQuick(db, userId, now + FREE_TIER_WINDOW_MS + 1),
    ).toBe(true);
  });

  test("returns false for unknown user (no row matches)", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    expect(await canStartFreeQuick(db, "01HXNONEXISTENTUSER0000000", now)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// consumeFreeQuickQuota
// ---------------------------------------------------------------------------
describe("consumeFreeQuickQuota", () => {
  test("first consume sets consumed_at + count=1 → {consumed:true}", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    const res = await consumeFreeQuickQuota(db, userId, now);
    expect(res.consumed).toBe(true);

    const row = readUser(db, userId);
    expect(row?.freeQuickConsumedAt).toBe(now);
    expect(row?.freeQuickConsumedCount).toBe(1);
  });

  test("second consume within 7d → {consumed:false} (row unchanged)", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    await consumeFreeQuickQuota(db, userId, now);
    const rowBefore = readUser(db, userId);

    const res = await consumeFreeQuickQuota(db, userId, now + 60_000);
    expect(res.consumed).toBe(false);

    const rowAfter = readUser(db, userId);
    expect(rowAfter?.freeQuickConsumedAt).toBe(rowBefore?.freeQuickConsumedAt);
    expect(rowAfter?.freeQuickConsumedCount).toBe(
      rowBefore?.freeQuickConsumedCount,
    );
  });

  test("consume 7d+1ms later → {consumed:true} + count increments to 2", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    const r1 = await consumeFreeQuickQuota(db, userId, now);
    expect(r1.consumed).toBe(true);

    const later = now + FREE_TIER_WINDOW_MS + 1;
    const r2 = await consumeFreeQuickQuota(db, userId, later);
    expect(r2.consumed).toBe(true);

    const row = readUser(db, userId);
    expect(row?.freeQuickConsumedAt).toBe(later);
    expect(row?.freeQuickConsumedCount).toBe(2);
  });

  test("race: two concurrent Promise.all consumes → exactly one wins", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    const [r1, r2] = await Promise.all([
      consumeFreeQuickQuota(db, userId, now),
      consumeFreeQuickQuota(db, userId, now),
    ]);

    // Exactly one must succeed; order is irrelevant.
    expect([r1.consumed, r2.consumed].sort()).toEqual([false, true]);

    const row = readUser(db, userId);
    expect(row?.freeQuickConsumedAt).toBe(now);
    expect(row?.freeQuickConsumedCount).toBe(1);
  });

  test("consume for unknown user → {consumed:false}", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const res = await consumeFreeQuickQuota(
      db,
      "01HXNONEXISTENTUSER0000000",
      now,
    );
    expect(res.consumed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refundFreeQuickQuota
// ---------------------------------------------------------------------------
describe("refundFreeQuickQuota", () => {
  test("clears consumed_at to null + decrements count", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    await consumeFreeQuickQuota(db, userId, now);
    const rowBefore = readUser(db, userId);
    expect(rowBefore?.freeQuickConsumedAt).toBe(now);
    expect(rowBefore?.freeQuickConsumedCount).toBe(1);

    const refund = await refundFreeQuickQuota(db, userId);
    expect(refund.refunded).toBe(true);

    const rowAfter = readUser(db, userId);
    expect(rowAfter?.freeQuickConsumedAt).toBeNull();
    expect(rowAfter?.freeQuickConsumedCount).toBe(0);

    // And after refund, user can start fresh again.
    expect(await canStartFreeQuick(db, userId, now + 60_000)).toBe(true);
  });

  test("refund when count=0 is idempotent (no underflow)", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    // Fresh user: count=0, consumed_at=null. Refund must not underflow.
    const refund = await refundFreeQuickQuota(db, userId);
    expect(refund.refunded).toBe(true); // row matched (UPDATE touched it)

    const row = readUser(db, userId);
    expect(row?.freeQuickConsumedAt).toBeNull();
    expect(row?.freeQuickConsumedCount).toBe(0); // floored at 0
  });

  test("refund for unknown user → {refunded:false}", async () => {
    const db = freshMemDb();
    const res = await refundFreeQuickQuota(
      db,
      "01HXNONEXISTENTUSER0000000",
    );
    expect(res.refunded).toBe(false);
  });

  test("consume → refund → consume cycle works end-to-end", async () => {
    const db = freshMemDb();
    const now = 1_700_000_000_000;
    const userId = seedUser(db, now);

    expect((await consumeFreeQuickQuota(db, userId, now)).consumed).toBe(true);
    expect((await refundFreeQuickQuota(db, userId)).refunded).toBe(true);
    // After refund within the same window, user can consume again
    // (e.g. provision-failed scan refunded; user retries immediately).
    expect(
      (await consumeFreeQuickQuota(db, userId, now + 60_000)).consumed,
    ).toBe(true);

    const row = readUser(db, userId);
    expect(row?.freeQuickConsumedAt).toBe(now + 60_000);
    expect(row?.freeQuickConsumedCount).toBe(1);
  });
});
