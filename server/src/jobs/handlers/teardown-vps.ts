/**
 * T045 — teardown_vps job handler.
 *
 * Lifecycle:
 *   1. SELECT vps_instances row by id. If missing → defensive no-op (handler
 *      must not fail for a missing row; e.g. could happen if an operator
 *      manually purged it). Returning marks the job done so the runner moves on.
 *   2. If status === 'destroyed' → idempotent no-op (no provider call, no
 *      duplicate audit). This is the guarantee required by the brief:
 *      teardown_vps can be enqueued from multiple paths (watchdog timeout,
 *      scan finish webhook, cancel) and the second/third one must be a noop.
 *   3. Mark status='tearing_down' in withTx — gives webhook receiver (T044)
 *      a visible mid-transition state. Skipped if already 'tearing_down'.
 *   4. Call vpsProvider.destroyVps(provider_server_id). Provider is
 *      idempotent on 404 (per T037). If it throws (5xx Hetzner), let the
 *      error propagate — runner retries with backoff; on retry we'll see
 *      'tearing_down' and skip step 3, going straight to destroyVps.
 *   5. In withTx: UPDATE status='destroyed', destroyed_at=now().
 *   6. After commit: emit vps_destroyed audit. Metadata = { reason,
 *      provider_server_id }. Sign-key is NEVER included.
 *
 * Why audit is post-commit and not inside withTx:
 *   emitSignedAudit opens its own BEGIN IMMEDIATE; bun:sqlite does not
 *   support nested transactions. Same pattern as T040/T021. If audit emit
 *   fails after the operational writes commit, we end up with a destroyed
 *   VPS and a missing audit row — acceptable because emit failures are
 *   local SQLite errors that would also block the runner from marking the
 *   job done anyway.
 *
 * SECURITY: sign_key MUST NEVER leak into audit metadata.
 */
import { eq } from "drizzle-orm";

import type { DB } from "../../db/client.ts";
import { withTx } from "../../db/client.ts";
import { vpsInstances } from "../../db/schema.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { emitSignedAudit } from "../../audit/emit.ts";
import type { Handler, TeardownVpsJob } from "../types.ts";
import type { VpsProvider } from "../../vps/provider.ts";

export interface TeardownVpsHandlerDeps {
  readonly db: DB;
  readonly vpsProvider: VpsProvider;
  /** Audit-log signing key. */
  readonly signingKey: string;
  readonly now?: () => number;
}

/** Build a `teardown_vps` Handler closing over the injected deps. */
export function createTeardownVpsHandler(
  deps: TeardownVpsHandlerDeps,
): Handler<TeardownVpsJob> {
  const { db, vpsProvider, signingKey, now = defaultNow } = deps;

  return async function teardownVpsHandler(
    job: TeardownVpsJob,
  ): Promise<void> {
    // 1. Look up the row.
    const vpsRow = db
      .select()
      .from(vpsInstances)
      .where(eq(vpsInstances.id, job.vps_instance_id))
      .get();
    if (!vpsRow) {
      // Defensive no-op: row gone (operator purge, never created, etc.).
      return;
    }

    // 2. Idempotent: already destroyed → nothing to do.
    if (vpsRow.status === "destroyed") {
      return;
    }

    // 3. Transition to 'tearing_down' (visible mid-state for webhook).
    //    Skip the write if we're already there (retry path).
    if (vpsRow.status !== "tearing_down") {
      await withTx(db, async (tx) => {
        tx.update(vpsInstances)
          .set({ status: "tearing_down" })
          .where(eq(vpsInstances.id, job.vps_instance_id))
          .run();
      });
    }

    // 4. Provider destroy. Throws on 5xx → propagate so runner retries.
    //    Provider is idempotent on 404 (per T037) so retries are safe.
    await vpsProvider.destroyVps(vpsRow.providerServerId);

    // 5. Mark destroyed + record destroyed_at.
    const destroyedAt = now();
    await withTx(db, async (tx) => {
      tx.update(vpsInstances)
        .set({ status: "destroyed", destroyedAt })
        .where(eq(vpsInstances.id, job.vps_instance_id))
        .run();
    });

    // 6. Audit emission OUTSIDE the tx — emit owns its own BEGIN IMMEDIATE.
    //    Metadata deliberately excludes sign_key.
    await emitSignedAudit(
      db,
      {
        event: "vps_destroyed",
        outcome: "success",
        scan_id: vpsRow.scanId,
        vps_instance_id: vpsRow.id,
        metadata: {
          reason: job.reason,
          provider_server_id: vpsRow.providerServerId,
        },
      },
      { key: signingKey },
    );
  };
}
