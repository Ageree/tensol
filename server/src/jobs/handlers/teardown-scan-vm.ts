/**
 * T058 — `teardown_scan_vm` job handler.
 *
 * Lifecycle (per task brief):
 *   1. Idempotency gate: check audit_log for a prior `vm_teardown` row that
 *      already carries the same `vps_instance_id` in metadata. If found,
 *      no-op return (the runner marks job done so further invocations move
 *      on). This guards re-invocations from multiple paths (user cancel,
 *      scan completion, watchdog timeout, manual retry).
 *   2. Provider call with retry-on-transient: up to `MAX_RETRIES` attempts
 *      around `provider.teardownVm(vpsInstanceId)`. Transient errors
 *      (rate limit, 5xx, timeout, network) trigger a small backoff and a
 *      retry. Permanent errors break out immediately to the failure branch.
 *   3. The provider's contract (see vps/gcp.ts:151-174):
 *        - 404 → returns `{}` (operationId omitted) — instance was already
 *          reaped. Treat as "already-gone" success.
 *        - 200 → returns `{ operationId }` — long-running delete op. Poll
 *          until terminal before emitting audit.
 *   4. On success path: emit a signed `vm_teardown` audit row carrying
 *      `{ scan_order_id, vps_instance_id, vps_zone, already_gone }` in
 *      metadata. Do NOT mutate `scan_orders` — by the time teardown runs,
 *      the order is already in a terminal state (cancelled / completed /
 *      failed) and is the responsibility of whoever advanced it.
 *   5. On permanent failure (or retries exhausted) — INSERT a
 *      `retry_telegram_notification` job carrying an operator alert
 *      (`kind='operator_alert_vm_teardown_failed'`). Do NOT emit a
 *      `vm_teardown` audit on the failure path: the event semantically
 *      means "VM is gone" — if we could not confirm that, we did not
 *      achieve the state.
 *
 * Why audit is post-commit and not inside `withTx`:
 *   `emitSignedAudit` opens its own `BEGIN IMMEDIATE`. bun:sqlite does not
 *   support nested transactions. Same pattern as spawn-scan-vm.ts (T056)
 *   / teardown-vps.ts (T045). Per Constitution X, audit always emits AFTER
 *   the controlling tx commits.
 *
 * Why `vm_teardown` (no substitution needed):
 *   Unlike spawn-scan-vm.ts which substitutes `scan_failed` for the
 *   missing `vm_provisioning_failed`, `vm_teardown` IS a member of
 *   BLACKBOX_AUDIT_EVENTS (audit/emit.ts:88). We use it directly with
 *   `outcome='success'`.
 *
 * Why we use `retry_telegram_notification` for the operator alert:
 *   schema.ts:483 lists the legal `jobs.type` values; `notify_telegram` is
 *   not one of them. `retry_telegram_notification` is the only existing
 *   type that can carry a Telegram alert payload. We piggy-back on it and
 *   distinguish the alert kind via
 *   `payload.kind='operator_alert_vm_teardown_failed'`. Same convention as
 *   spawn-scan-vm.ts (T056).
 *
 * Return value: the handler never throws on a permanent provider failure —
 * the failure is captured in the alert job and the runner records the
 * handler as done. We DO throw on unexpected internal errors (malformed
 * payload missing `vpsInstanceId`) so the runner's retry / permanent-failure
 * logic catches them.
 */
import { and, eq, sql } from "drizzle-orm";

import type { DB } from "../../db/client.ts";
import { withTx } from "../../db/client.ts";
import {
  auditLog,
  jobs as jobsTable,
} from "../../db/schema.ts";
import { ulid } from "../../lib/ids.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { emitSignedAudit } from "../../audit/emit.ts";
import type { CloudProvider } from "../../vps/provider.ts";

/**
 * Job payload shape — mirrors what `scan-orders/service.cancelOrder` (or
 * the scan-completed webhook, or the watchdog timeout) inserts into the
 * `jobs.payload_json` column. Tolerant of both snake_case (DB-emitted) and
 * camelCase (briefs) keys.
 */
export interface TeardownScanVmJobPayload {
  readonly scanOrderId: string;
  readonly scanId?: string;
  readonly vpsInstanceId: string;
  readonly vpsZone?: string;
}

interface NormalizedPayload {
  readonly scanOrderId: string;
  readonly scanId: string | null;
  readonly vpsInstanceId: string;
  readonly vpsZone: string | null;
}

function normalizePayload(raw: unknown): NormalizedPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("teardown_scan_vm: payload is not an object");
  }
  const r = raw as Record<string, unknown>;
  const scanOrderId =
    (typeof r.scanOrderId === "string" && r.scanOrderId) ||
    (typeof r.scan_order_id === "string" && r.scan_order_id) ||
    "";
  const scanIdRaw =
    (typeof r.scanId === "string" && r.scanId) ||
    (typeof r.scan_id === "string" && r.scan_id) ||
    "";
  const vpsInstanceId =
    (typeof r.vpsInstanceId === "string" && r.vpsInstanceId) ||
    (typeof r.vps_instance_id === "string" && r.vps_instance_id) ||
    "";
  const vpsZoneRaw =
    (typeof r.vpsZone === "string" && r.vpsZone) ||
    (typeof r.vps_zone === "string" && r.vps_zone) ||
    "";

  if (!scanOrderId || !vpsInstanceId) {
    throw new Error(
      `teardown_scan_vm: payload missing scanOrderId/vpsInstanceId (got ${JSON.stringify(raw)})`,
    );
  }
  return {
    scanOrderId,
    scanId: scanIdRaw || null,
    vpsInstanceId,
    vpsZone: vpsZoneRaw || null,
  };
}

export interface TeardownScanVmHandlerDeps {
  readonly db: DB;
  readonly provider: CloudProvider;
  /** Audit-log signing key. */
  readonly auditKey: string;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Polling cadence / ceiling for the teardown `Operation`. */
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  /** Sleep between provider-retry attempts. Tests override to 1ms. */
  readonly retryBackoffMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

/** Heuristic transient-error classifier — same set as spawn-scan-vm. */
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

/**
 * Re-run idempotency check: has a `vm_teardown` audit row already been
 * written for this VPS instance id? We use the dedicated
 * `audit_log.vps_instance_id` column (set by `emitSignedAudit`) for an
 * indexed lookup rather than scanning JSON metadata.
 */
function alreadyTornDown(db: DB, vpsInstanceId: string): boolean {
  const row = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.event, "vm_teardown"),
        eq(auditLog.vpsInstanceId, vpsInstanceId),
      ),
    )
    .limit(1)
    .get();
  return Boolean(row);
}

/** Build a `teardown_scan_vm` handler closing over the injected deps. */
export function createTeardownScanVmHandler(
  deps: TeardownScanVmHandlerDeps,
) {
  const {
    db,
    provider,
    auditKey,
    now = defaultNow,
    newId = () => ulid(now()),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
  } = deps;

  /**
   * @param jobId    The jobs.id from the runner — reserved for tracing.
   * @param rawPayload The parsed JSON from jobs.payload_json. Tolerant of
   *                   both snake_case and camelCase keys.
   */
  return async function handle(
    jobId: string,
    rawPayload: unknown,
  ): Promise<void> {
    void jobId;
    const { scanOrderId, scanId, vpsInstanceId, vpsZone } =
      normalizePayload(rawPayload);

    // 1. Re-run idempotency gate.
    if (alreadyTornDown(db, vpsInstanceId)) {
      return;
    }

    // 2. Provider call with transient retry.
    let teardownResult: { operationId?: string } | null = null;
    let lastErr: Error | null = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      attempts = attempt;
      try {
        teardownResult = await provider.teardownVm(vpsInstanceId);
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

    if (!teardownResult) {
      // 5. Permanent failure — operator-alert telegram job.
      await markFailure({
        db,
        scanOrderId,
        scanId,
        vpsInstanceId,
        vpsZone,
        attempts,
        error: lastErr ?? new Error("teardown_scan_vm: unknown failure"),
        now,
        newId,
      });
      return;
    }

    // 3. Detect "already gone" — provider returned an empty object (404
    //    path per gcp.ts:160-162). We still emit a successful
    //    `vm_teardown` audit but flag the case in metadata.
    const alreadyGone = !teardownResult.operationId;

    // 4a. If the provider returned a long-running delete op, poll until done.
    if (teardownResult.operationId) {
      const opId = teardownResult.operationId;
      const deadline = now() + pollTimeoutMs;
      while (true) {
        const res = await provider.pollOperation(opId);
        if (res.done) {
          if (res.error) {
            await markFailure({
              db,
              scanOrderId,
              scanId,
              vpsInstanceId,
              vpsZone,
              attempts,
              error: new Error(
                `teardown_scan_vm: operation errored: ${res.error}`,
              ),
              now,
              newId,
            });
            return;
          }
          break;
        }
        if (now() >= deadline) {
          await markFailure({
            db,
            scanOrderId,
            scanId,
            vpsInstanceId,
            vpsZone,
            attempts,
            error: new Error(
              `teardown_scan_vm: operation poll TIMEOUT (op=${opId})`,
            ),
            now,
            newId,
          });
          return;
        }
        await sleep(pollIntervalMs);
      }
    }

    // 4b. Success — emit signed audit. NO scan_orders mutation (terminal).
    const ts = now();
    const metadata: Record<string, unknown> = {
      scan_order_id: scanOrderId,
      vps_instance_id: vpsInstanceId,
      already_gone: alreadyGone,
    };
    if (vpsZone) {
      metadata.vps_zone = vpsZone;
    }
    await emitSignedAudit(
      db,
      {
        event: "vm_teardown",
        outcome: "success",
        ts,
        scan_id: scanId,
        vps_instance_id: vpsInstanceId,
        metadata,
      },
      { key: auditKey },
    );
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Failure-path helper — extracted because the failure persistence + alert
// job sequence is identical between the retry-exhaustion branch and the
// operation-poll branches.
// ───────────────────────────────────────────────────────────────────────────

interface MarkFailureArgs {
  readonly db: DB;
  readonly scanOrderId: string;
  readonly scanId: string | null;
  readonly vpsInstanceId: string;
  readonly vpsZone: string | null;
  readonly attempts: number;
  readonly error: Error;
  readonly now: () => number;
  readonly newId: () => string;
}

async function markFailure(args: MarkFailureArgs): Promise<void> {
  const {
    db,
    scanOrderId,
    scanId,
    vpsInstanceId,
    vpsZone,
    attempts,
    error,
    now,
    newId,
  } = args;

  const ts = now();
  const telegramJobId = newId();
  const telegramPayload = JSON.stringify({
    type: "retry_telegram_notification",
    kind: "operator_alert_vm_teardown_failed",
    scan_order_id: scanOrderId,
    scan_id: scanId,
    vps_instance_id: vpsInstanceId,
    vps_zone: vpsZone,
    attempts,
    error: error.message,
  });

  await withTx(db, async (tx) => {
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

  // No audit emission on failure: `vm_teardown` semantically means "VM is
  // gone" — we did not achieve that state. The operator alert job carries
  // the failure context.
}

// Keep `sql` import live for future query-builder needs.
void sql;
