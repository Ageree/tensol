/**
 * T064 — `scan_timeout_watcher` periodic handler.
 *
 * Style: cron-style sweeper, NOT an event-driven job-payload handler. The
 * jobs runner (T066) invokes this on a wall-clock cadence (every 5 minutes
 * per `specs/002-blackbox-mvp/tasks.md` T126), passing no payload — the
 * watcher introspects the `scans` table directly.
 *
 * Lifecycle (per task brief + spec FR-022):
 *   1. Compute `cutoff = now - 90*60*1000`.
 *   2. SELECT all rows from `scans` WHERE status='running' AND
 *      started_at < cutoff. Inner-join `scan_orders` so we can carry the
 *      attached `vps_instance_id` + `vps_zone` into the teardown job
 *      payload without a second round-trip.
 *   3. For each expired row, do the per-row work in this order:
 *        a) IN ONE TX:
 *             - UPDATE scans SET status='failed',
 *                              failure_reason='scan_timeout',
 *                              completed_at=now
 *               WHERE id=:scanId AND status='running'   ← idempotency gate
 *             - IF the UPDATE changed 0 rows (lost a race against another
 *               tick or a webhook), skip the rest of this iteration —
 *               another writer already took ownership.
 *             - UPDATE scan_orders SET status='failed',
 *                                      failure_reason='scan_timeout',
 *                                      updated_at=now
 *               WHERE id=:scanOrderId
 *             - INSERT teardown_scan_vm job (status='pending') carrying
 *               {scan_order_id, scan_id, vps_instance_id, vps_zone}
 *        b) refundFreeQuickQuota(userId) — OUTSIDE the tx (statement-level
 *           lock, same rationale as spawn-scan-vm.ts).
 *        c) emit `scan_failed` signed audit (metadata.reason='scan_timeout')
 *        d) IF refund returned `refunded: true`, emit `free_quota_refunded`
 *           signed audit.
 *
 * Why a SQL-level idempotency gate (UPDATE … WHERE status='running'):
 *   Two concurrent ticks could both observe the same expired row in step
 *   (2). Without the gate, both would enqueue teardown + emit audit. The
 *   conditional UPDATE means exactly one tick observes `changes === 1`;
 *   the other observes `changes === 0` and skips. Same atomic-gate pattern
 *   as `consumeFreeQuickQuota` in free-tier/service.ts.
 *
 * Why we use `scan_failed` (not `scan_timeout`) for the audit event:
 *   `BLACKBOX_AUDIT_EVENTS` in audit/emit.ts:72-114 does NOT contain a
 *   `scan_timeout` literal. We use `scan_failed` with `outcome='failure'`
 *   and `metadata.reason='scan_timeout'` — mirroring the substitution in
 *   spawn-scan-vm.ts (vm_provisioning_failed → scan_failed +
 *   reason='vm_spawn_failed').
 *
 * Why audit emit is post-commit (not inside withTx):
 *   `emitSignedAudit` opens its own `BEGIN IMMEDIATE`. bun:sqlite does not
 *   support nested transactions. Same pattern as spawn-scan-vm.ts
 *   (T056) / teardown-scan-vm.ts (T058). Per Constitution X, audit
 *   always emits AFTER the controlling tx commits.
 *
 * Why teardown is enqueued (not invoked synchronously):
 *   Teardown takes minutes (GCP long-running ops, polling). The watcher
 *   must remain fast and atomic per its 5-minute tick cadence. Enqueueing
 *   matches the pattern used by scan-orders/service.cancelOrder (T036).
 *
 * Return value: `{ processed: N }` where N is the count of rows whose
 * UPDATE took effect. The runner (T066) uses this for observability /
 * scheduling backoff.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "bun:sqlite";

import type { DB } from "../../db/client.ts";
import { withTx } from "../../db/client.ts";
import {
  jobs as jobsTable,
  scanOrders,
  scans,
} from "../../db/schema.ts";
import { ulid } from "../../lib/ids.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { emitSignedAudit } from "../../audit/emit.ts";

/** Default scan timeout: 90 minutes per spec FR-022. */
export const DEFAULT_SCAN_TIMEOUT_MS = 90 * 60 * 1000;

/** Shape bun:sqlite's `.run()` returns (preserved by Drizzle's bun-sqlite). */
interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface ScanTimeoutWatcherDeps {
  readonly db: DB;
  /**
   * Free-tier refund helper. Injected as a closure over the db handle so
   * tests can reuse the production `refundFreeQuickQuota(db, userId)` via
   * a thin adapter. Returns `{ refunded: boolean }`.
   */
  readonly refundFreeQuickQuota: (
    userId: string,
  ) => Promise<{ refunded: boolean }>;
  /** Audit-log signing key. */
  readonly auditKey: string;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Override for testing — defaults to 90 minutes per FR-022. */
  readonly timeoutMs?: number;
}

/** A handle returned by `createScanTimeoutWatcher`. */
export interface ScanTimeoutWatcher {
  /**
   * Run one sweep over the `scans` table.
   * @param currentNow optional override for the wall clock; if omitted,
   *   the watcher uses `deps.now()` (or `defaultNow()` if also omitted).
   * @returns `{ processed }` — the count of rows whose timeout was acted
   *   upon (i.e. UPDATE took effect AND the side effects fired).
   */
  tick(currentNow?: number): Promise<{ processed: number }>;
}

/** Build a `scan_timeout_watcher` handle closing over the injected deps. */
export function createScanTimeoutWatcher(
  deps: ScanTimeoutWatcherDeps,
): ScanTimeoutWatcher {
  const {
    db,
    refundFreeQuickQuota,
    auditKey,
    now = defaultNow,
    newId = () => ulid(now()),
    timeoutMs = DEFAULT_SCAN_TIMEOUT_MS,
  } = deps;

  return {
    async tick(currentNow?: number): Promise<{ processed: number }> {
      const ts = currentNow ?? now();
      const cutoff = ts - timeoutMs;

      // 1. Find expired running scans. We join scan_orders explicitly so
      //    that the teardown payload carries the (potentially nullable)
      //    vps_instance_id + vps_zone without a follow-up query per row.
      //
      //    NOTE: drizzle's `innerJoin` does not have a one-shot row shape
      //    that lints clean, so we drive this via the raw bun:sqlite handle
      //    for clarity. Same pattern is used inside withTx blocks elsewhere
      //    in the codebase (search for `.$client as Database`).
      const rawDb = db.$client as Database;
      const rows = rawDb
        .query(
          `SELECT s.id           AS scan_id,
                  s.user_id      AS user_id,
                  s.scan_order_id AS scan_order_id,
                  o.vps_instance_id AS vps_instance_id,
                  o.vps_zone     AS vps_zone
             FROM scans s
             JOIN scan_orders o ON o.id = s.scan_order_id
            WHERE s.status = 'running'
              AND s.started_at < ?`,
        )
        .all(cutoff) as Array<{
        scan_id: string;
        user_id: string;
        scan_order_id: string;
        vps_instance_id: string | null;
        vps_zone: string | null;
      }>;

      if (rows.length === 0) {
        return { processed: 0 };
      }

      let processed = 0;

      for (const row of rows) {
        const result = await processExpiredScan({
          db,
          row,
          ts,
          newId,
          auditKey,
          refundFreeQuickQuota,
        });
        if (result.acted) {
          processed += 1;
        }
      }

      return { processed };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-row processing — extracted because the body has 4 distinct phases
// (conditional UPDATE / order+job persist / refund / audit pair) and putting
// them inline in the loop would push the watcher past the 80-line readable-
// function ceiling.
// ───────────────────────────────────────────────────────────────────────────

interface ExpiredRow {
  readonly scan_id: string;
  readonly user_id: string;
  readonly scan_order_id: string;
  readonly vps_instance_id: string | null;
  readonly vps_zone: string | null;
}

interface ProcessArgs {
  readonly db: DB;
  readonly row: ExpiredRow;
  readonly ts: number;
  readonly newId: () => string;
  readonly auditKey: string;
  readonly refundFreeQuickQuota: (
    userId: string,
  ) => Promise<{ refunded: boolean }>;
}

async function processExpiredScan(
  args: ProcessArgs,
): Promise<{ acted: boolean }> {
  const { db, row, ts, newId, auditKey, refundFreeQuickQuota } = args;
  const { scan_id, user_id, scan_order_id, vps_instance_id, vps_zone } = row;

  // Conditional UPDATE + ancillary persistence in one tx. The conditional
  // UPDATE is the atomic-gate: if another tick already claimed this row,
  // we observe changes === 0 and bail out before touching the order /
  // enqueueing the teardown / emitting audit.
  let claimed = false;
  await withTx(db, async (tx) => {
    const updRes = tx
      .update(scans)
      .set({
        status: "failed",
        failureReason: "scan_timeout",
        completedAt: ts,
      })
      .where(and(eq(scans.id, scan_id), eq(scans.status, "running")))
      .run() as unknown as RunResult;

    if (updRes.changes !== 1) {
      // Lost the race — another tick / webhook handler took ownership.
      return;
    }
    claimed = true;

    tx.update(scanOrders)
      .set({
        status: "failed",
        failureReason: "scan_timeout",
        updatedAt: ts,
      })
      .where(eq(scanOrders.id, scan_order_id))
      .run();

    // Enqueue teardown_scan_vm. We always enqueue, even if vps_instance_id
    // is NULL — the teardown handler is idempotent on missing-instance via
    // its `alreadyTornDown` check, and would normally throw on a missing
    // vpsInstanceId. To avoid a follow-up wedge we only enqueue when we
    // have an instance to clean up.
    if (vps_instance_id) {
      const teardownJobId = newId();
      const teardownPayload = JSON.stringify({
        type: "teardown_scan_vm",
        scan_order_id,
        scan_id,
        vps_instance_id,
        vps_zone,
      });
      tx.insert(jobsTable)
        .values({
          id: teardownJobId,
          type: "teardown_scan_vm",
          payloadJson: teardownPayload,
          status: "pending",
          scheduledAt: ts,
          attempts: 0,
          lastError: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }
  });

  if (!claimed) {
    return { acted: false };
  }

  // Refund free-tier quota outside the tx (statement-level lock; see
  // free-tier/service.ts module comment for why).
  const refund = await refundFreeQuickQuota(user_id);

  // Audit emit — scan_failed first (causal order), then refund. Both are
  // post-commit per Constitution X.
  await emitSignedAudit(
    db,
    {
      event: "scan_failed",
      outcome: "failure",
      ts,
      user_id,
      scan_id,
      metadata: {
        scan_order_id,
        reason: "scan_timeout",
      },
    },
    { key: auditKey },
  );

  if (refund.refunded) {
    await emitSignedAudit(
      db,
      {
        event: "free_quota_refunded",
        outcome: "success",
        ts,
        user_id,
        metadata: {
          scan_order_id,
          reason: "scan_timeout",
        },
      },
      { key: auditKey },
    );
  }

  return { acted: true };
}

// Keep `lt`/`sql` imports live for future query-builder needs (the SQL
// driver path above uses raw `?` placeholders).
void lt;
void sql;
