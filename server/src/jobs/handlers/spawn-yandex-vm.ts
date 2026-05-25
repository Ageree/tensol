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
  vpsInstances,
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
  /** T128 Bug #7 — OpenRouter API key for the per-VM LiteLLM proxy. */
  readonly openrouterApiKey: string;
  /** LiteLLM master key shared between litellm and langgraph containers. */
  readonly litellmMasterKey: string;
  /** Postgres password for the per-VM litellm-backing DB. */
  readonly postgresPassword: string;
  /** Neo4j auth password for the per-VM KG. */
  readonly neo4jPassword: string;
  readonly vpsAgentImage?: string;
  readonly agentPort?: number;
  /**
   * HTTP client for the agent-dispatch probe. Injected so tests can drive
   * the agent-readiness loop without a real socket. Defaults to global
   * `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /** Total budget to wait for the vps-agent to bind :8080 (cloud-init). */
  readonly agentWaitBudgetMs?: number;
  /** Sleep between agent-readiness probes. Tests override to ~1ms. */
  readonly agentProbeIntervalMs?: number;
  /** Per-probe request timeout. */
  readonly agentProbeTimeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_AGENT_WAIT_BUDGET_MS = 8 * 60 * 1_000; // cloud-init 3-5 min
const DEFAULT_AGENT_PROBE_INTERVAL_MS = 10_000;
const DEFAULT_AGENT_PROBE_TIMEOUT_MS = 5_000;

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
    openrouterApiKey,
    litellmMasterKey,
    postgresPassword,
    neo4jPassword,
    vpsAgentImage,
    agentPort,
    fetchImpl = fetch,
    agentWaitBudgetMs = DEFAULT_AGENT_WAIT_BUDGET_MS,
    agentProbeIntervalMs = DEFAULT_AGENT_PROBE_INTERVAL_MS,
    agentProbeTimeoutMs = DEFAULT_AGENT_PROBE_TIMEOUT_MS,
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
      openrouterApiKey,
      litellmMasterKey,
      postgresPassword,
      neo4jPassword,
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

    // 4b. Wait for vps-agent on the new VM to come up, then dispatch.
    //
    // Yandex's create-instance operation resolves once the VM exists, but
    // cloud-init (apt install docker, docker pull tensol-vps-agent, docker
    // run -d …) keeps running in the background and typically takes 3-5
    // minutes to actually bind :8080. So we cannot just `fetch /scan` and
    // expect a response. Loop with backoff until either (a) some HTTP
    // status comes back from POST /scan — any code, including 401 for a
    // probe with no signature — meaning the agent is alive, or (b) we
    // exceed the wait budget.
    //
    // This wait happens BEFORE the vm_ready persistence below so that a
    // runner retry of the whole spawn_yandex_vm job (idempotency gate at
    // step 1 keys off `scan_orders.status`, which is still
    // `vm_provisioning` until 4c) can re-enter and try dispatch again.
    // Only after a successful dispatch do we commit vm_ready + audit
    // `decepticon_invoked`.
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
    // Webhook path: V1 callback handler is mounted at `/api/webhooks/*`
    // (see server.ts:345-348). Agent will send back the terminal status
    // POST /scan-progress with `x-tensol-scan-id` + `x-tensol-signature`
    // headers, and the V1 handler looks up the signKey via vps_instances.
    // We therefore (a) point the agent at /api/webhooks/scan-progress,
    // and (b) insert a vps_instances row below so the V1 lookup resolves.
    const dispatchBody = {
      profile: scanRow.profile,
      scan_id: scanId,
      target_url: `https://${orderRow.primaryDomain}`,
      webhook_url: `${backendUrl}/api/webhooks/scan-progress`,
    };
    const rawBody = JSON.stringify(dispatchBody);
    const signature = hmacSha256(signKey, rawBody);
    const dispatchUrl = `http://${publicIp}:${port}/scan`;

    // Wait-for-agent: probe POST /scan up to agentWaitBudgetMs,
    // agentProbeIntervalMs between attempts. Any HTTP response (success or
    // signed-rejection) means the agent has bound and is processing.
    const waitDeadline = now() + agentWaitBudgetMs;
    let dispatchRes: Response | null = null;
    let lastProbeErr: string | null = null;
    while (now() < waitDeadline) {
      try {
        const probe = await fetchImpl(dispatchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tensol-Signature": signature,
          },
          body: rawBody,
          signal: AbortSignal.timeout(agentProbeTimeoutMs),
        });
        // Any HTTP status from the agent (incl. 401) proves it's alive.
        // We only care about 2xx for success; non-2xx → terminal failure.
        dispatchRes = probe;
        break;
      } catch (e) {
        lastProbeErr = (e as Error).message ?? String(e);
        await sleep(agentProbeIntervalMs);
      }
    }
    if (!dispatchRes) {
      // Follow-up #3: the VM spawned but its agent never bound within the
      // budget — cloud-init likely failed. Throwing here would let the runner
      // retry the whole job against a dead VM (idempotency gate stays in
      // `vm_provisioning`), wasting ~8 min/attempt while the VM runs until the
      // 35-min orphan reaper. Instead: enqueue a teardown, mark the order/scan
      // terminally failed, refund, alert — then return (no retry).
      const msg = `spawn_yandex_vm: vps-agent at ${dispatchUrl} did not respond within ${agentWaitBudgetMs}ms (last error: ${lastProbeErr ?? "-"})`;
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
            public_ip: publicIp,
            agent_port: port,
            error: "agent_wait_timeout",
            last_probe_error: lastProbeErr ?? null,
          },
        },
        { key: auditKey },
      );
      await markFailure({
        db,
        scanOrderId,
        scanId,
        userId: orderRow.userId,
        error: new Error(msg),
        reason: "agent_dispatch_failed",
        teardown: { vpsInstanceId: finalInstanceId, vpsZone },
        auditKey,
        refundFreeQuickQuota,
        now,
        newId,
      });
      return;
    }
    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text().catch(() => "<no body>");
      const msg = `spawn_yandex_vm: agent dispatch HTTP ${dispatchRes.status} ${dispatchRes.statusText}: ${errText.slice(0, 200)}`;
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
            public_ip: publicIp,
            agent_port: port,
            http_status: dispatchRes.status,
            response_body: errText.slice(0, 200),
          },
        },
        { key: auditKey },
      );
      // Same rationale as the timeout branch — terminal + teardown, no retry.
      await markFailure({
        db,
        scanOrderId,
        scanId,
        userId: orderRow.userId,
        error: new Error(msg),
        reason: "agent_dispatch_failed",
        teardown: { vpsInstanceId: finalInstanceId, vpsZone },
        auditKey,
        refundFreeQuickQuota,
        now,
        newId,
      });
      return;
    }
    // Dispatch succeeded → emit decepticon_invoked + fall through to
    // vm_ready commit below.
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

    // 4c. Success-path persistence: scan_orders + scans + scan_events +
    //     vps_instances (so the V1 webhook handler at /api/webhooks/
    //     scan-progress can look up signKey by scan_id and verify the
    //     terminal callback HMAC). The shared `signKey` here is the same
    //     value the agent's verifySignature() uses — it came from this
    //     handler's deps and was injected into cloud-init env on the VM
    //     as TENSOL_SIGN_KEY. So the same secret signs and verifies on
    //     both sides; the V1 handler just needs the lookup row to exist.
    const ts = now();
    const scanEventId = newId();
    const vpsInstanceRowId = newId();
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

      tx.insert(vpsInstances)
        .values({
          id: vpsInstanceRowId,
          scanId,
          provider: "yandex",
          providerServerId: finalInstanceId,
          ipv4: publicIp,
          status: "alive",
          signKey,
          createdAt: ts,
        })
        .run();
    });

    // 4d. Post-commit audit (Constitution X).
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
  /**
   * Domain failure reason persisted on `scan_orders`/`scans` and carried in
   * the `scan_failed` audit metadata. Defaults to `vm_spawn_failed` (the
   * provider-spawn branch). The agent-dispatch branch passes
   * `agent_dispatch_failed`.
   */
  readonly reason?: string;
  /**
   * When the VM was already provisioned before the failure (agent-dispatch
   * branch), enqueue a `teardown_yandex_vm` job in the SAME tx so the orphan
   * is reaped promptly instead of waiting for the 35-minute cron (follow-up
   * #3). Omitted for the pre-spawn failure branches (no VM to tear down).
   */
  readonly teardown?: { readonly vpsInstanceId: string; readonly vpsZone: string };
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
    reason = "vm_spawn_failed",
    teardown,
  } = args;

  const ts = now();
  const telegramJobId = newId();
  const alertKind =
    reason === "agent_dispatch_failed"
      ? "operator_alert_agent_dispatch_failed"
      : "operator_alert_vm_spawn_failed";
  const telegramPayload = JSON.stringify({
    type: "retry_telegram_notification",
    kind: alertKind,
    scan_order_id: scanOrderId,
    scan_id: scanId,
    error: error.message,
  });
  const teardownJobId = teardown ? newId() : null;
  const teardownPayload = teardown
    ? JSON.stringify({
        type: "teardown_yandex_vm",
        scanOrderId,
        scanId,
        vpsInstanceId: teardown.vpsInstanceId,
        vpsZone: teardown.vpsZone,
      })
    : null;

  // 1. Persist domain failure + enqueue operator alert (+ optional teardown)
  //    in one tx.
  await withTx(db, async (tx) => {
    tx.update(scanOrders)
      .set({
        status: "failed",
        failureReason: reason,
        updatedAt: ts,
      })
      .where(eq(scanOrders.id, scanOrderId))
      .run();

    tx.update(scans)
      .set({
        status: "failed",
        failureReason: reason,
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

    if (teardownJobId && teardownPayload) {
      tx.insert(jobsTable)
        .values({
          id: teardownJobId,
          type: "teardown_yandex_vm",
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
        reason,
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
          reason,
        },
      },
      { key: auditKey },
    );
  }
}
