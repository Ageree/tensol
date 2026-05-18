/**
 * T040 — spawn_vps job handler.
 *
 * Lifecycle:
 *   1. Re-read the scan; if it is no longer 'queued' (e.g. user cancelled
 *      between enqueue and pickup) → no-op return. This guards against
 *      provisioning a VPS for a scan that will never be dispatched.
 *   2. Generate a 32-byte HMAC sign_key (64 hex chars). This key is the
 *      sole secret the VPS-agent and backend share to authenticate webhook
 *      callbacks (T044) and the dispatch_scan request body.
 *   3. Call `vpsProvider.spawnVps({ scanId, signKey })`. The provider is
 *      responsible for embedding signKey into cloud-init so the VPS comes
 *      up knowing it.
 *   4. Poll `vpsProvider.getVpsStatus(provider_server_id)` every
 *      `pollIntervalMs` until it reports 'running' OR until `pollTimeoutMs`
 *      elapses. On timeout we THROW so the runner retries the whole
 *      handler (the runner's backoff will re-attempt provisioning from
 *      scratch — semantically, a stuck VPS is treated as never having
 *      existed at the handler boundary).
 *   5. In one transaction:
 *        INSERT vps_instances (status='alive', sign_key stored)
 *        UPDATE scans SET status='running'
 *        INSERT jobs (type='dispatch_scan', payload references the new
 *                     vps_instance_id) so the runner picks it up next.
 *   6. After the tx commits, emit a `vps_provisioned` audit row. The audit
 *      is OUTSIDE the tx so its hash chain isn't held under the same lock
 *      as the operational writes (audit emission acquires its own
 *      BEGIN IMMEDIATE — see emit.ts).
 *
 * Why audit is post-commit and not inside withTx:
 *   `emitSignedAudit` itself opens a transaction. Nesting transactions on
 *   bun:sqlite is not supported (BEGIN inside BEGIN errors). The operational
 *   writes must commit first; if the audit emit then fails, the runner
 *   retries this handler — and the retry sees the scan as 'running', skips
 *   spawn, and... actually no: step 1 only no-ops on a non-'queued' scan,
 *   but a 'running' scan will fall through with NO matching provider call.
 *   Worth documenting: an audit emit failure leaves the system functional
 *   (VPS exists, scan running, dispatch enqueued) but with a missing audit
 *   row. Acceptable trade-off; in practice emit failures are local SQLite
 *   errors that also block the runner from updating job status anyway.
 *
 * SECURITY: sign_key MUST NEVER leak into audit metadata. The audit metadata
 *   includes `provider_server_id` and `ipv4` only.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import type { DB } from "../../db/client.ts";
import { withTx } from "../../db/client.ts";
import { jobs, scans, vpsInstances } from "../../db/schema.ts";
import { ulid } from "../../lib/ids.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { emitSignedAudit } from "../../audit/emit.ts";
import type { Handler, SpawnVpsJob, DispatchScanJob } from "../types.ts";
import type { VpsProvider } from "../../vps/provider.ts";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export interface SpawnVpsHandlerDeps {
  readonly db: DB;
  readonly vpsProvider: VpsProvider;
  /** Audit-log signing key. */
  readonly signingKey: string;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

/** Build a `spawn_vps` Handler closing over the injected deps. The shape is
 *  `(job, ctx) => Promise<void>` so it slots straight into the runner's
 *  `Dispatcher.spawn_vps` slot. */
export function createSpawnVpsHandler(
  deps: SpawnVpsHandlerDeps,
): Handler<SpawnVpsJob> {
  const {
    db,
    vpsProvider,
    signingKey,
    now = defaultNow,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  } = deps;

  return async function spawnVpsHandler(job: SpawnVpsJob): Promise<void> {
    // 1. Re-read the scan to honour cancellation races.
    const scan = db.select().from(scans).where(eq(scans.id, job.scan_id)).get();
    if (!scan) {
      throw new Error(
        `spawn_vps: scan not found (scan_id=${job.scan_id}). Job will retry.`,
      );
    }
    if (scan.status !== "queued") {
      // No-op: scan was cancelled, already running, completed, or failed.
      // Returning success here marks the job done so the runner moves on.
      return;
    }

    // 2. Generate signKey (HMAC secret shared with VPS via cloud-init).
    const signKey = randomBytes(32).toString("hex");

    // 3. Provision the VPS.
    const spawned = await vpsProvider.spawnVps({
      scanId: job.scan_id,
      signKey,
    });

    // 4. Poll until 'running' or timeout.
    const deadline = now() + pollTimeoutMs;
    let lastStatus = "initializing";
    while (true) {
      const status = await vpsProvider.getVpsStatus(spawned.provider_server_id);
      lastStatus = status;
      if (status === "running") break;
      if (now() >= deadline) {
        throw new Error(
          `spawn_vps: VPS ${spawned.provider_server_id} did not become 'running' within ${pollTimeoutMs}ms (last status: ${lastStatus}). Timeout.`,
        );
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // 5. Atomic DB writes: vps_instances + scans + dispatch_scan job row.
    const vpsId = ulid(now());
    const dispatchPayload: DispatchScanJob = {
      type: "dispatch_scan",
      scan_id: job.scan_id,
      vps_instance_id: vpsId,
    };

    await withTx(db, async (tx) => {
      const ts = now();
      tx.insert(vpsInstances)
        .values({
          id: vpsId,
          scanId: job.scan_id,
          provider: "hetzner",
          providerServerId: spawned.provider_server_id,
          ipv4: spawned.ipv4,
          status: "alive",
          signKey,
          createdAt: ts,
        })
        .run();

      tx.update(scans)
        .set({ status: "running" })
        .where(eq(scans.id, job.scan_id))
        .run();

      const dispatchJobId = ulid(ts);
      tx.insert(jobs)
        .values({
          id: dispatchJobId,
          type: "dispatch_scan",
          payloadJson: JSON.stringify(dispatchPayload),
          status: "pending",
          scheduledAt: ts,
          attempts: 0,
          lastError: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    });

    // 6. Audit emission OUTSIDE the tx — emit owns its own BEGIN IMMEDIATE.
    //    Metadata deliberately excludes sign_key.
    await emitSignedAudit(
      db,
      {
        event: "vps_provisioned",
        outcome: "success",
        scan_id: job.scan_id,
        vps_instance_id: vpsId,
        metadata: {
          provider_server_id: spawned.provider_server_id,
          ipv4: spawned.ipv4,
        },
      },
      { key: signingKey },
    );
  };
}
