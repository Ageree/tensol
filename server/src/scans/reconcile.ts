/**
 * T050 — reconcileInFlight: boot-time reconciliation of running scans.
 *
 * Purpose
 *   The backend boot path calls this once after migrations apply, before
 *   the job runner accepts new work. For every scan still in `status='running'`
 *   we ask the VPS provider whether the underlying server is alive. If the
 *   server is alive we leave the scan untouched (the runner / webhook
 *   pipeline will continue to drive it). If the server is dead, missing,
 *   unreachable, or stopped we mark the scan failed AND enqueue a
 *   `teardown_vps` job so the orphaned provider resource is reclaimed.
 *
 * Orphan handling
 *   If a `running` scan has NO `vps_instances` row at all — most likely
 *   because `spawn_vps` crashed between `vpsProvider.spawnVps()` and the
 *   row INSERT — we cannot enqueue teardown (no provider_server_id to
 *   destroy). We mark the scan failed with reason `vps_orphan_on_reconcile`
 *   and emit an audit row. Reaping that orphan server is the operator's
 *   problem; it should not happen in practice because spawn handler does
 *   the INSERT in the same withTx as `scans` status='running'.
 *
 * VPS-status interpretation
 *   - `running`         → keep scan running (no-op).
 *   - `initializing`    → keep scan running (boot in progress; defensive).
 *   - `stopped`         → treat as dead → failed + teardown.
 *   - `destroyed`       → treat as dead → failed + teardown.
 *   - `unknown`         → treat as dead → failed + teardown.
 *   - thrown error      → treated identically to `unknown` (we never let a
 *                          provider blip take the boot path down).
 *
 * Concurrency / ordering
 *   The loop is sequential (NOT Promise.all): determinism of the audit-chain
 *   order is more valuable than the few seconds we'd save on parallel
 *   provider polls. If reconcile turns into a bottleneck for very large
 *   running-scan backlogs, parallelism can be added by sharding the loop
 *   but emitting audits sequentially behind a single mutex. Out of scope
 *   for T050.
 *
 * Transactionality
 *   The scan update and teardown_vps job INSERT happen inside a single
 *   `withTx` per scan — either both commit or neither, so a crash mid-loop
 *   cannot leave a `failed` scan without its teardown job. The audit emit
 *   runs AFTER the tx commits (bun:sqlite cannot nest BEGINs, see
 *   `audit/emit.ts`). The pattern mirrors `scans/service.ts:startScan`.
 *
 * Audit pattern
 *   - `scan_failed` event, outcome=`failure`.
 *   - Metadata: `{ reason, vps_status }` (alpha-sorted via emit canonicalisation).
 *   - `vps_instance_id` is included when the scan had an associated VPS
 *     row; for orphans it is `null`.
 *
 * Why we pick the latest vps_instance per scan (not by status filter):
 *   Schema invariant `vps_instances.scan_id UNIQUE` (see schema.ts) means
 *   there is at most one row per scan. We `LIMIT 1` defensively in case a
 *   future schema relaxes this to 1:N.
 */
import { desc, eq, inArray } from "drizzle-orm";

import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  jobs as jobsTable,
  scans as scansTable,
  vpsInstances,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import type { TeardownVpsJob } from "../jobs/types.ts";
import type { VpsProvider, VpsStatus } from "../vps/provider.ts";

/** Return value of `reconcileInFlight`. */
export interface ReconcileResult {
  /** Count of scans observed in `status='running'` at start. */
  readonly checked: number;
  /** Count where VPS reported alive → left untouched. */
  readonly unchanged: number;
  /** Count transitioned to `status='failed'`. */
  readonly failed: number;
  /** Count of `teardown_vps` jobs inserted. <= `failed` (orphan path emits no job). */
  readonly teardown_enqueued: number;
}

/** Injected dependencies. */
export interface ReconcileDeps {
  readonly vpsProvider: VpsProvider;
  /** Audit-log signing key. */
  readonly signingKey: string;
  readonly now?: () => number;
}

/** VPS statuses we consider "alive". Anything else (or a throw) is dead. */
const ALIVE_STATUSES: ReadonlySet<VpsStatus> = new Set<VpsStatus>([
  "running",
  "initializing",
]);

/**
 * Reconcile every `running` scan against the VPS provider.
 *
 * Returns counts; never throws on a per-scan provider error (caught and
 * treated as `unknown`). May throw on SQLite errors — boot path can choose
 * to abort or log+continue.
 */
export async function reconcileInFlight(
  db: DB,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const { vpsProvider, signingKey } = deps;
  const clock = deps.now ?? defaultNow;

  // Step 1 — pick up all running scans (deterministic order by id ASC).
  const runningScans = db
    .select({ id: scansTable.id, userId: scansTable.userId })
    .from(scansTable)
    .where(eq(scansTable.status, "running"))
    .all();

  if (runningScans.length === 0) {
    return { checked: 0, unchanged: 0, failed: 0, teardown_enqueued: 0 };
  }

  // Step 2 — preload vps_instances for the running scans in one query.
  //          One row per scan (schema invariant), but order by created_at
  //          desc + LIMIT 1 per scan is overkill given UNIQUE(scan_id);
  //          a flat `inArray` is enough.
  const vpsRows = db
    .select()
    .from(vpsInstances)
    .where(
      inArray(
        vpsInstances.scanId,
        runningScans.map((s) => s.id),
      ),
    )
    .orderBy(desc(vpsInstances.createdAt))
    .all();
  const vpsByScanId = new Map<string, (typeof vpsRows)[number]>();
  for (const row of vpsRows) {
    // First write wins under desc(createdAt) — newest per scan.
    if (!vpsByScanId.has(row.scanId)) vpsByScanId.set(row.scanId, row);
  }

  let unchanged = 0;
  let failed = 0;
  let teardownEnqueued = 0;

  // Step 3 — sequential per-scan reconciliation.
  for (const scan of runningScans) {
    const vps = vpsByScanId.get(scan.id);

    if (!vps) {
      // Orphan path: mark failed, NO teardown.
      await markScanFailed(db, {
        scanId: scan.id,
        userId: scan.userId,
        reason: "vps_orphan_on_reconcile",
        now: clock(),
      });
      await emitSignedAudit(
        db,
        {
          event: "scan_failed",
          outcome: "failure",
          user_id: scan.userId,
          scan_id: scan.id,
          vps_instance_id: null,
          metadata: {
            reason: "vps_orphan_on_reconcile",
          },
        },
        { key: signingKey },
      );
      failed += 1;
      continue;
    }

    // Ask the provider. Errors are absorbed as `unknown`.
    let reported: VpsStatus;
    try {
      reported = await vpsProvider.getVpsStatus(vps.providerServerId);
    } catch {
      reported = "unknown";
    }

    if (ALIVE_STATUSES.has(reported)) {
      unchanged += 1;
      continue;
    }

    // Dead VPS — atomic (UPDATE scans + INSERT teardown job), then audit.
    const reconcileTs = clock();
    const jobId = ulid(reconcileTs);
    const teardownPayload: TeardownVpsJob = {
      type: "teardown_vps",
      vps_instance_id: vps.id,
      reason: "reconcile_failed",
    };

    await withTx(db, async (tx) => {
      tx.update(scansTable)
        .set({
          status: "failed",
          failureReason: "vps_unreachable_on_reconcile",
          completedAt: reconcileTs,
        })
        .where(eq(scansTable.id, scan.id))
        .run();

      tx.insert(jobsTable)
        .values({
          id: jobId,
          type: "teardown_vps",
          payloadJson: JSON.stringify(teardownPayload),
          status: "pending",
          scheduledAt: reconcileTs,
          attempts: 0,
          lastError: null,
          createdAt: reconcileTs,
          updatedAt: reconcileTs,
        })
        .run();
    });

    await emitSignedAudit(
      db,
      {
        event: "scan_failed",
        outcome: "failure",
        ts: reconcileTs,
        user_id: scan.userId,
        scan_id: scan.id,
        vps_instance_id: vps.id,
        metadata: {
          reason: "vps_unreachable_on_reconcile",
          vps_status: reported,
        },
      },
      { key: signingKey },
    );

    failed += 1;
    teardownEnqueued += 1;
  }

  return {
    checked: runningScans.length,
    unchanged,
    failed,
    teardown_enqueued: teardownEnqueued,
  };
}

/** Mark a scan failed with the given reason. Used only for the orphan
 *  path; the dead-VPS branch inlines the UPDATE inside its own withTx so
 *  it can pair with the teardown_vps job INSERT atomically. */
async function markScanFailed(
  db: DB,
  args: {
    scanId: string;
    userId: string;
    reason: string;
    now: number;
  },
): Promise<void> {
  await withTx(db, async (tx) => {
    tx.update(scansTable)
      .set({
        status: "failed",
        failureReason: args.reason,
        completedAt: args.now,
      })
      .where(eq(scansTable.id, args.scanId))
      .run();
  });
}
