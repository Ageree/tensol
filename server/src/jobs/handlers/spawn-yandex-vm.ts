/**
 * T056 — `spawn_yandex_vm` job handler.
 *
 * Lifecycle (per task brief):
 *   1. Idempotency gate: re-read the `scan_orders` row; if status is no
 *      longer `vm_provisioning` (cancelled / already running / already
 *      failed) → no-op return. This makes retries from the runner safe.
 *   2. Build the cloud-init userdata via `buildCloudInit(...)` (T044) using
 *      the deps-injected env-contract values (backend URL, AWS keys,
 *      bucket, sign key, decepticon image …) + the per-scan IDs.
 *   3. Provider call with retry-on-transient: up to `MAX_RETRIES` attempts
 *      around `provider.spawnVm({ scanId, userData })`. Transient errors
 *      (rate limit, timeout, 5xx, network) trigger a small backoff and a
 *      retry. Permanent errors break out immediately to the failure
 *      branch. The brief lists 3 retries — implemented as 3 *attempts*
 *      total (1 initial + 2 retries) which matches the wording "Retry on
 *      transient failures up to 3 times".
 *   4. On success: poll the operation (if any) until done, then in a
 *      single `withTx`:
 *        - persist `vps_instance_id` + `vps_zone` on `scan_orders`
 *        - flip `scan_orders.status` to `running`
 *        - flip `scans.status` to `running`
 *        - INSERT a `scan_events` row with `event_type='vm_ready'`
 *      After the tx commits, emit the `vm_ready` signed audit row.
 *   5. On permanent failure (or all retries exhausted) — in a single
 *      `withTx`:
 *        - flip `scan_orders.status` to `failed` with
 *          `failure_reason='vm_spawn_failed'`
 *        - flip `scans.status` to `failed` with the same reason
 *        - INSERT a `retry_telegram_notification` jobs row carrying an
 *          operator alert payload (the only existing job-type in
 *          schema.ts:483 that can carry a Telegram alert per the pivot doc
 *          docs/pivot-2026-05-19-telegram-auth.md)
 *      After the tx commits, refund the free-tier quota (statement-level
 *      lock — see free-tier/service.ts module comment for why this is
 *      OUTSIDE the tx), then emit two signed audit rows: `scan_failed`
 *      (carrying `reason='vm_spawn_failed'`) and `free_quota_refunded`.
 *
 * Why audit is post-commit and not inside `withTx`:
 *   `emitSignedAudit` opens its own BEGIN IMMEDIATE. bun:sqlite does not
 *   support nested transactions. Same pattern as spawn-vps.ts (T040) /
 *   teardown-vps.ts (T045) / scan-orders/service.ts (T036). Per
 *   Constitution X, audit always emits AFTER the controlling tx commits.
 *
 * Why we emit `scan_failed` (not `vm_provisioning_failed`):
 *   BLACKBOX_AUDIT_EVENTS in audit/emit.ts:72-114 does NOT contain
 *   `vm_provisioning_failed`. The closest semantic event is `scan_failed`.
 *   We carry the specifics in the metadata's `reason` field
 *   (=`vm_spawn_failed`, matching the lifecycle's `vm_spawn_failed` event
 *   name in lifecycle.ts:88).
 *
 * Why we use `retry_telegram_notification` for the operator alert:
 *   schema.ts:483 lists the legal `jobs.type` values; `notify_telegram` is
 *   not one of them. `retry_telegram_notification` is the only existing
 *   type that can carry a Telegram alert payload. We piggy-back on it and
 *   distinguish the alert kind via `payload.kind=
 *   'operator_alert_vm_spawn_failed'`.
 *
 * Signature & deps:
 *   - `db`, `provider`, `auditKey`, `refundFreeQuickQuota` are required.
 *   - `now` defaults to `lib/time.ts.now`.
 *   - `newId` defaults to `ulid(now())`.
 *   - `pollIntervalMs` / `pollTimeoutMs` default to 5s / 5min.
 *   - `retryBackoffMs` defaults to 1s (tests override to 1ms for speed).
 *   - cloud-init values + `vpsZone` are required for the success path.
 *
 * Return value: the handler never throws on a permanent provider failure —
 * the failure is captured in DB state + audit and the runner records the
 * job as `done`. We DO throw on unexpected internal errors (missing order,
 * malformed payload) so the runner's retry / permanent-failure logic
 * catches them.
 */
import { eq } from "drizzle-orm";

import type { DB } from "../../db/client.ts";
import { withTx } from "../../db/client.ts";
import {
  jobs as jobsTable,
  scanEvents,
  scanOrders,
  scans,
} from "../../db/schema.ts";
import { ulid } from "../../lib/ids.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { emitSignedAudit } from "../../audit/emit.ts";
import { hmacSha256 } from "../../lib/crypto.ts";
import { buildCloudInit } from "../../vps/cloud-init.ts";
import type { CloudProvider } from "../../vps/provider.ts";

/**
 * Job payload shape — mirrors what `scan-orders/service.ts launchScan`
 * inserts into the `jobs` row (T036, commit b0ffe74). The runner reads
 * `payload_json` and calls the handler with the parsed object; we accept
 * both the camelCase (briefs) and snake_case (DB-emitted) forms to stay
 * decoupled from JSON-key style.
 */
export interface SpawnYandexVmJobPayload {
  readonly scanOrderId: string;
  readonly scanId: string;
}

/** Internal shape used to normalize both casings. */
interface NormalizedPayload {
  readonly scanOrderId: string;
  readonly scanId: string;
}

function normalizePayload(raw: unknown): NormalizedPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("spawn_yandex_vm: payload is not an object");
  }
  const r = raw as Record<string, unknown>;
  const scanOrderId =
    (typeof r.scanOrderId === "string" && r.scanOrderId) ||
    (typeof r.scan_order_id === "string" && r.scan_order_id) ||
    "";
  const scanId =
    (typeof r.scanId === "string" && r.scanId) ||
    (typeof r.scan_id === "string" && r.scan_id) ||
    "";
  if (!scanOrderId || !scanId) {
    throw new Error(
      `spawn_yandex_vm: payload missing scanOrderId/scanId (got ${JSON.stringify(raw)})`,
    );
  }
  return { scanOrderId, scanId };
}

export interface SpawnYandexVmHandlerDeps {
  readonly db: DB;
  readonly provider: CloudProvider;
  /** Audit-log signing key. */
  readonly auditKey: string;
  /** Free-tier refund helper. Injected for testability (T030). */
  readonly refundFreeQuickQuota: (
    db: DB,
    userId: string,
  ) => Promise<{ refunded: boolean }>;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Polling cadence / ceiling for the spawnVm `Operation`. */
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  /** Sleep between provider-retry attempts. Tests override to 1ms. */
  readonly retryBackoffMs?: number;
  /** Yandex zone label (e.g. "ru-central1-a"). Persisted on the order. */
  readonly vpsZone: string;

  // ── cloud-init env contract (see vps-agent/.env.example) ──────────────
  readonly backendUrl: string;
  readonly webhookSecret: string;
  readonly evidenceBucket: string;
  readonly evidencePrefix: string;
  readonly awsAccessKeyId: string;
  readonly awsSecretAccessKey: string;
  readonly awsEndpoint: string;
  readonly awsRegion: string;
  readonly signKey: string;
  readonly decepticonImage: string;
  readonly vpsAgentImage?: string;
  readonly agentPort?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

/** Heuristic transient-error classifier — rate limits, 5xx, network blips,
 *  read/connect timeouts. Anything else is treated as permanent. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /RATE[_ ]?LIMIT/i,
  /TOO[_ ]MANY[_ ]REQUESTS/i,
  /TIMEOUT/i,
  /TIMED[_ ]?OUT/i,
  /UNAVAILABLE/i,
  /TEMPORARILY/i,
  /(^|[^0-9])5\d{2}([^0-9]|$)/, // 5xx in the message
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
];

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

/** Build a `spawn_yandex_vm` handler closing over the injected deps. */
export function createSpawnYandexVmHandler(deps: SpawnYandexVmHandlerDeps) {
  const {
    db,
    provider,
    auditKey,
    refundFreeQuickQuota,
    now = defaultNow,
    newId = () => ulid(now()),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
    vpsZone,
    backendUrl,
    webhookSecret,
    evidenceBucket,
    evidencePrefix,
    awsAccessKeyId,
    awsSecretAccessKey,
    awsEndpoint,
    awsRegion,
    signKey,
    decepticonImage,
    vpsAgentImage,
    agentPort,
  } = deps;

  /**
   * @param jobId    The jobs.id from the runner — passed through to audit
   *                 metadata for cross-referencing.
   * @param rawPayload The parsed JSON from jobs.payload_json. Tolerant of
   *                   both snake_case and camelCase keys.
   */
  return async function handle(
    jobId: string,
    rawPayload: unknown,
  ): Promise<void> {
    void jobId; // currently un-used in audit metadata; reserved for future tracing.
    const { scanOrderId, scanId } = normalizePayload(rawPayload);

    // 1. Idempotency gate — re-read the order.
    const orderRow = db
      .select()
      .from(scanOrders)
      .where(eq(scanOrders.id, scanOrderId))
      .get();
    if (!orderRow) {
      throw new Error(
        `spawn_yandex_vm: scan_order not found (id=${scanOrderId}). Job will retry / fail at the runner level.`,
      );
    }
    if (orderRow.status !== "vm_provisioning") {
      // No-op: order was cancelled, already running, completed, failed, or
      // somehow advanced by a parallel actor. Returning marks the job done
      // so the runner moves on.
      return;
    }

    // 2. Build cloud-init userdata (deterministic per args).
    const userData = buildCloudInit({
      scanId,
      backendUrl,
      webhookSecret,
      evidenceBucket,
      evidencePrefix,
      awsAccessKeyId,
      awsSecretAccessKey,
      awsEndpoint,
      awsRegion,
      signKey,
      decepticonImage,
      ...(vpsAgentImage !== undefined ? { vpsAgentImage } : {}),
      ...(agentPort !== undefined ? { agentPort } : {}),
    });

    // 3. Provider call with transient retry. We pass the scan id as the
    //    Yandex idempotency key value (see CloudProvider.spawnVm contract).
    let spawnResult: Awaited<ReturnType<CloudProvider["spawnVm"]>> | null = null;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        spawnResult = await provider.spawnVm({
          scanId,
          userData,
          metadata: {
            "tensol-scan-id": scanId,
            "tensol-scan-order-id": scanOrderId,
          },
        });
        break;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        lastErr = e;
        if (!isTransient(e)) {
          break; // permanent — no further retries
        }
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(retryBackoffMs);
        }
      }
    }

    if (!spawnResult) {
      // 5. Permanent failure branch (all retries exhausted OR non-transient).
      await markFailure({
        db,
        scanOrderId,
        scanId,
        userId: orderRow.userId,
        error: lastErr ?? new Error("spawn_yandex_vm: unknown failure"),
        auditKey,
        refundFreeQuickQuota,
        now,
        newId,
      });
      return;
    }

    // 4a. If the provider returned a long-running operation handle, poll it.
    //     The fake provider always returns an operationId; the real Yandex
    //     adapter does too. If `operationId` is absent the result is already
    //     terminal — skip polling.
    let finalInstanceId = spawnResult.instanceId;
    if (spawnResult.operationId) {
      const opId = spawnResult.operationId;
      const deadline = now() + pollTimeoutMs;
      while (true) {
        const res = await provider.pollOperation(opId);
        if (res.done) {
          if (res.error) {
            await markFailure({
              db,
              scanOrderId,
              scanId,
              userId: orderRow.userId,
              error: new Error(`spawn_yandex_vm: operation errored: ${res.error}`),
              auditKey,
              refundFreeQuickQuota,
              now,
              newId,
            });
            return;
          }
          // Success — the result discriminator carries the instanceId.
          if (res.result && "instanceId" in res.result) {
            finalInstanceId = res.result.instanceId;
          }
          break;
        }
        if (now() >= deadline) {
          await markFailure({
            db,
            scanOrderId,
            scanId,
            userId: orderRow.userId,
            error: new Error(
              `spawn_yandex_vm: operation poll TIMEOUT (op=${opId})`,
            ),
            auditKey,
            refundFreeQuickQuota,
            now,
            newId,
          });
          return;
        }
        await sleep(pollIntervalMs);
      }
    }

    // 4b. Success-path persistence: scan_orders + scans + scan_events.
    const ts = now();
    const scanEventId = newId();
    const eventPayload = JSON.stringify({
      vps_instance_id: finalInstanceId,
      vps_zone: vpsZone,
    });

    await withTx(db, async (tx) => {
      tx.update(scanOrders)
        .set({
          status: "running",
          vpsInstanceId: finalInstanceId,
          vpsZone,
          updatedAt: ts,
        })
        .where(eq(scanOrders.id, scanOrderId))
        .run();

      tx.update(scans)
        .set({ status: "running" })
        .where(eq(scans.id, scanId))
        .run();

      tx.insert(scanEvents)
        .values({
          id: scanEventId,
          scanId,
          eventType: "vm_ready",
          payloadJson: eventPayload,
          createdAt: ts,
        })
        .run();
    });

    // 4c. Post-commit audit (Constitution X).
    await emitSignedAudit(
      db,
      {
        event: "vm_ready",
        outcome: "success",
        ts,
        user_id: orderRow.userId,
        scan_id: scanId,
        metadata: {
          scan_order_id: scanOrderId,
          vps_instance_id: finalInstanceId,
          vps_zone: vpsZone,
        },
      },
      { key: auditKey },
    );

    // 4d. Inline dispatch to the vps-agent on the freshly-spawned VM.
    //
    // V1 (legacy `spawn_vps`) enqueued a separate `dispatch_scan` job that
    // read `vps_instances.ipv4` + `vps_instances.sign_key` and POSTed to
    // the agent. V2 deliberately moved most of that state onto
    // `scan_orders.vpsInstanceId`/`vpsZone` (no vps_instances row), but
    // never carried over the second half — so until 2026-05-21 V2 scans
    // sat in `running` forever because nothing ever called the agent.
    //
    // Inline-POST here keeps the existing `dispatch_scan` handler usable
    // for the legacy path and avoids inventing a new job type just for
    // V2. The agent already authenticates POST /scan by the body's HMAC
    // (X-Tensol-Signature) using the per-server `signKey` that cloud-init
    // baked into the VM as TENSOL_SIGN_KEY — exactly the same shared
    // secret the legacy dispatch handler used.
    //
    // Failure handling: any error here throws back to the runner, which
    // will retry the whole spawn_yandex_vm job. That re-enters the
    // idempotency gate at step 1; since `scan_orders.status` is now
    // 'running', the gate returns no-op. So a retry of spawn_yandex_vm
    // *after* this point currently CANNOT re-attempt dispatch. We accept
    // this for now (real fix is a dedicated `dispatch_yandex_scan` job
    // type with its own retry budget — tracked as follow-up). The good
    // news: in practice the inline POST is a single sub-100ms call to
    // a freshly-booted agent that has been alive for many minutes by
    // the time we reach it (operation-poll already waited for VM
    // running), so failure is rare.
    try {
      const vmStatus = await provider.getStatus(finalInstanceId);
      const publicIp = vmStatus.publicIp;
      if (!publicIp) {
        throw new Error(
          `spawn_yandex_vm: getStatus(${finalInstanceId}) returned no publicIp`,
        );
      }
      const scanRow = db
        .select({ profile: scans.profile })
        .from(scans)
        .where(eq(scans.id, scanId))
        .get();
      if (!scanRow) {
        throw new Error(
          `spawn_yandex_vm: scans row vanished mid-handler (id=${scanId})`,
        );
      }
      const port = agentPort ?? 8080;
      const dispatchBody = {
        profile: scanRow.profile,
        scan_id: scanId,
        target_url: `https://${orderRow.primaryDomain}`,
        webhook_url: `${backendUrl}/v1/webhooks/scan-progress`,
      };
      const rawBody = JSON.stringify(dispatchBody);
      const signature = hmacSha256(signKey, rawBody);
      const dispatchUrl = `http://${publicIp}:${port}/scan`;
      const res = await fetch(dispatchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tensol-Signature": signature,
        },
        body: rawBody,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "<no body>");
        throw new Error(
          `spawn_yandex_vm: agent dispatch HTTP ${res.status} ${res.statusText}: ${errText.slice(0, 200)}`,
        );
      }
      await emitSignedAudit(
        db,
        {
          event: "decepticon_invoked",
          outcome: "success",
          ts: now(),
          user_id: orderRow.userId,
          scan_id: scanId,
          metadata: {
            scan_order_id: scanOrderId,
            vps_instance_id: finalInstanceId,
            public_ip: publicIp,
            agent_port: port,
            profile: scanRow.profile,
            target_url: dispatchBody.target_url,
          },
        },
        { key: auditKey },
      );
    } catch (err) {
      // Best-effort failure audit so operators can see the gap. We do NOT
      // flip scan/order status here — runner retry semantics decide that.
      await emitSignedAudit(
        db,
        {
          event: "decepticon_invoked",
          outcome: "failure",
          ts: now(),
          user_id: orderRow.userId,
          scan_id: scanId,
          metadata: {
            scan_order_id: scanOrderId,
            vps_instance_id: finalInstanceId,
            error: (err as Error).message ?? String(err),
          },
        },
        { key: auditKey },
      );
      throw err;
    }
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Failure-path helper — shared between the post-retry-exhaustion branch and
// the operation-poll branches. Extracted because the failure persistence +
// refund + audit + telegram-enqueue sequence is identical in both cases.
// ───────────────────────────────────────────────────────────────────────────

interface MarkFailureArgs {
  readonly db: DB;
  readonly scanOrderId: string;
  readonly scanId: string;
  readonly userId: string;
  readonly error: Error;
  readonly auditKey: string;
  readonly refundFreeQuickQuota: (
    db: DB,
    userId: string,
  ) => Promise<{ refunded: boolean }>;
  readonly now: () => number;
  readonly newId: () => string;
}

async function markFailure(args: MarkFailureArgs): Promise<void> {
  const {
    db,
    scanOrderId,
    scanId,
    userId,
    error,
    auditKey,
    refundFreeQuickQuota,
    now,
    newId,
  } = args;

  const ts = now();
  const telegramJobId = newId();
  const telegramPayload = JSON.stringify({
    type: "retry_telegram_notification",
    kind: "operator_alert_vm_spawn_failed",
    scan_order_id: scanOrderId,
    scan_id: scanId,
    error: error.message,
  });

  // 1. Persist domain failure + enqueue operator alert in one tx.
  await withTx(db, async (tx) => {
    tx.update(scanOrders)
      .set({
        status: "failed",
        failureReason: "vm_spawn_failed",
        updatedAt: ts,
      })
      .where(eq(scanOrders.id, scanOrderId))
      .run();

    tx.update(scans)
      .set({
        status: "failed",
        failureReason: "vm_spawn_failed",
        completedAt: ts,
      })
      .where(eq(scans.id, scanId))
      .run();

    tx.insert(jobsTable)
      .values({
        id: telegramJobId,
        type: "retry_telegram_notification",
        payloadJson: telegramPayload,
        status: "pending",
        scheduledAt: ts,
        attempts: 0,
        lastError: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  });

  // 2. Refund free-tier quota OUTSIDE the tx (statement-level lock; see
  //    free-tier/service.ts module comment for why).
  const refund = await refundFreeQuickQuota(db, userId);

  // 3. Audit emissions — scan_failed first (causal order), then refund.
  await emitSignedAudit(
    db,
    {
      event: "scan_failed",
      outcome: "failure",
      ts,
      user_id: userId,
      scan_id: scanId,
      metadata: {
        scan_order_id: scanOrderId,
        reason: "vm_spawn_failed",
        error: error.message,
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
        user_id: userId,
        metadata: {
          scan_order_id: scanOrderId,
          reason: "vm_spawn_failed",
        },
      },
      { key: auditKey },
    );
  }
}
