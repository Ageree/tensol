/**
 * T030 — Free-tier quota service.
 *
 * Implements spec FR-013..FR-017 (specs/002-blackbox-mvp/spec.md):
 *   - FR-013: each signed-in user gets ONE free Quick scan per rolling
 *     7-day (168h) window.
 *   - FR-014: rapid double-click MUST NOT double-spend — the gate is
 *     enforced atomically at the SQL layer.
 *   - FR-016: caller refunds the quota on timeout/cancel/provision-failure.
 *   - FR-017: caller does NOT refund on zero-findings (out of scope here;
 *     this module exposes an unconditional refund helper — the policy of
 *     when to call it lives in scan-orders/jobs/webhook handlers).
 *
 * Storage:
 *   `users.free_quick_consumed_at`    INTEGER (unix-ms, nullable)
 *   `users.free_quick_consumed_count` INTEGER NOT NULL DEFAULT 0
 *   (migration 0010, columns added per data-model.md E1.)
 *
 * Atomicity strategy: the consume gate is a SINGLE conditional UPDATE
 *   statement whose WHERE clause encodes the eligibility rule:
 *
 *     UPDATE users
 *        SET free_quick_consumed_at   = :now,
 *            free_quick_consumed_count = free_quick_consumed_count + 1
 *      WHERE id = :userId
 *        AND (free_quick_consumed_at IS NULL
 *             OR free_quick_consumed_at < :now - WINDOW_MS)
 *
 *   Because SQLite serializes writes (per-statement locking + the
 *   `BEGIN IMMEDIATE` wrapper from `withTx`), exactly one concurrent
 *   invocation can match the WHERE. The losing caller gets
 *   `changes === 0`, which we surface as `{ consumed: false }`. This is
 *   the FR-014 atomic gate.
 *
 *   We deliberately do NOT wrap in `withTx` for the consume/refund paths.
 *   bun:sqlite uses a single per-handle connection, so nesting BEGIN
 *   IMMEDIATE inside an already-open tx (e.g. when two concurrent service
 *   calls race on the same handle via Promise.all) throws "cannot start a
 *   transaction within a transaction" rather than serializing. Since this
 *   service's mutations are SINGLE conditional UPDATE statements,
 *   statement-level locking already provides the atomic gate; the `withTx`
 *   wrapper would add zero correctness and remove single-handle race
 *   tolerance. If a future refactor pairs the consume with a second
 *   statement (e.g. a `quota_log` insert), it MUST move to `withTx` AND
 *   must be called from a code path that uses a per-request connection.
 *
 * No signed-audit emit here. Per spec, free-tier consumption is not a
 * security-relevant event on its own — the audit chain logs the
 * downstream `scan_started` (and the matching `scan_failed`/`scan_cancelled`
 * for refunds). Wiring the audit at the scan-order layer (caller) avoids
 * double-logging and keeps this module a pure quota primitive.
 */
import { sql } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type { DB } from "../db/client.ts";
import { users as usersTable } from "../db/schema.ts";

/** Rolling free-tier window: 7 days = 168 hours = 604,800,000 ms. */
export const FREE_TIER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Shape bun:sqlite's `.run()` returns (preserved by Drizzle's bun-sqlite). */
interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/**
 * Read-only check: would `consumeFreeQuickQuota` succeed for this user now?
 *
 * Returns `true` IFF a `users` row exists for `userId` AND either
 *   - `free_quick_consumed_at IS NULL`, OR
 *   - `free_quick_consumed_at < now - FREE_TIER_WINDOW_MS`.
 *
 * Note this is advisory only — concurrent callers must rely on
 * `consumeFreeQuickQuota`'s atomic gate for correctness.
 */
export async function canStartFreeQuick(
  db: DB,
  userId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const threshold = now - FREE_TIER_WINDOW_MS;
  const rows = db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      sql`${usersTable.id} = ${userId} AND (${usersTable.freeQuickConsumedAt} IS NULL OR ${usersTable.freeQuickConsumedAt} < ${threshold})`,
    )
    .limit(1)
    .all();
  return rows.length === 1;
}

/**
 * Atomic quota gate. Attempts to consume the user's free-Quick slot.
 *
 * Returns:
 *   - `{ consumed: true }`  — slot reserved; `free_quick_consumed_at = now`,
 *                            `free_quick_consumed_count` incremented by 1.
 *   - `{ consumed: false }` — user already consumed within the window
 *                            (or the user row does not exist). Row unchanged.
 *
 * Concurrency: only the first caller in any 7-day window observes
 * `changes === 1`; all others (rapid double-click, parallel tabs, retries)
 * observe `changes === 0`. This is the FR-014 guarantee.
 */
export async function consumeFreeQuickQuota(
  db: DB,
  userId: string,
  now: number = Date.now(),
): Promise<{ consumed: boolean }> {
  const threshold = now - FREE_TIER_WINDOW_MS;
  const res = db
    .update(usersTable)
    .set({
      freeQuickConsumedAt: now,
      freeQuickConsumedCount: sql`${usersTable.freeQuickConsumedCount} + 1`,
    })
    .where(
      sql`${usersTable.id} = ${userId} AND (${usersTable.freeQuickConsumedAt} IS NULL OR ${usersTable.freeQuickConsumedAt} < ${threshold})`,
    )
    .run() as unknown as RunResult;
  return { consumed: res.changes === 1 };
}

/**
 * Refund the user's free-Quick quota.
 *
 * Caller responsibility (per FR-016/FR-017): invoke ONLY on
 *   - DNS-verify timeout
 *   - user-cancelled before significant runtime
 *   - VPS provisioning failure
 *   - scan-timeout with no results
 *
 * Do NOT invoke for zero-findings completion (valid result; quota stays
 * consumed).
 *
 * Returns:
 *   - `{ refunded: true }`  — row matched (i.e. user exists). consumed_at
 *                             is now NULL; count is decremented but floored
 *                             at 0 so repeated refunds cannot underflow.
 *   - `{ refunded: false }` — user row not found.
 *
 * Idempotent: calling refund on a row that's already at count=0 /
 * consumed_at=NULL is a no-op (the SET still touches the row, but the
 * stored values do not change).
 */
export async function refundFreeQuickQuota(
  db: DB,
  userId: string,
): Promise<{ refunded: boolean }> {
  const res = db
    .update(usersTable)
    .set({
      freeQuickConsumedAt: null,
      freeQuickConsumedCount: sql`MAX(${usersTable.freeQuickConsumedCount} - 1, 0)`,
    })
    .where(sql`${usersTable.id} = ${userId}`)
    .run() as unknown as RunResult;
  return { refunded: res.changes === 1 };
}

// Suppress unused-import warning when Database type ever becomes load-bearing
// for callers wanting the raw client; keeps T030 brief's signature option
// open for future direct-handle helpers.
export type { Database };
