/**
 * T036 — Job discriminated union + DB row type.
 *
 * The `Job` discriminator strings ALIGN with the `jobs.type` column values
 * declared in `db/schema.ts`:
 *   - "spawn_vps"     — provision a VPS for a queued scan.
 *   - "dispatch_scan" — HMAC-POST the scan request to the VPS agent.
 *   - "watchdog_scan" — probe a running scan for liveness (alias for the
 *                       T036-spec `WatchdogJob` TS type).
 *   - "teardown_vps"  — destroy a VPS at scan completion / cancellation.
 *
 * The schema column already exports a `Job` type (`typeof jobs.$inferSelect`)
 * — we deliberately shadow that with the domain-level discriminated union
 * here. The DB row type is re-exported as `JobRow` so call sites can
 * distinguish payload-from-storage explicitly.
 *
 * Payloads are stored in `payload_json` as JSON of the FULL job object
 * (including `type`) — this keeps the union round-trip-safe: when the
 * runner reads a row, `JSON.parse(payload_json)` yields a value the
 * dispatcher map can switch on directly without joining `row.type` and
 * the parsed object.
 */
import type { jobs } from "../db/schema.ts";

// ---------------------------------------------------------------------------
// Domain jobs (the discriminated union)
// ---------------------------------------------------------------------------

/** Provision a new VPS instance for a queued scan. Inserted by the
 *  scans service when `startScan` succeeds. */
export interface SpawnVpsJob {
  readonly type: "spawn_vps";
  readonly scan_id: string;
}

/** HMAC-POST the scan request to a now-alive VPS. Inserted by the
 *  `spawn_vps` handler once the VPS reports ready. */
export interface DispatchScanJob {
  readonly type: "dispatch_scan";
  readonly scan_id: string;
  readonly vps_instance_id: string;
}

/** Periodic liveness probe for running scans. Spec calls this
 *  `WatchdogJob` (no `_scan` suffix in the TS name) but the schema
 *  column value is `watchdog_scan`.
 *
 *  `consecutive_failures` carries state across watchdog reschedules
 *  (see `handlers/watchdog.ts` for the 3-strike kill switch). When the
 *  job is first enqueued the field is absent / 0; each failed probe
 *  re-enqueues a watchdog_scan with an incremented counter. When the
 *  field reaches `maxConsecutiveFailures` (default 3) the scan is
 *  marked failed (failure_reason='agent_unresponsive') and a
 *  teardown_vps job is enqueued. A successful probe always reschedules
 *  with `consecutive_failures=0`. The field is optional for backward
 *  compatibility with existing enqueue sites that pre-date T060. */
export interface WatchdogJob {
  readonly type: "watchdog_scan";
  readonly scan_id: string;
  readonly consecutive_failures?: number;
}

/** Destroy a VPS after a scan finishes / fails / is cancelled. */
export interface TeardownVpsJob {
  readonly type: "teardown_vps";
  readonly vps_instance_id: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// 002-blackbox-mvp additions (data-model.md §E7).
//
// The new job kinds carry their fields in camelCase (matching the handler
// factories shipped in T056/T058/T060/T062/T064). The runner serialises
// payloads via JSON.stringify(job) so the on-wire shape is whatever this
// interface declares; the handlers themselves normalize both camelCase and
// snake_case for tolerance with hand-rolled inserts.
//
// All five new kinds participate in the discriminated union below so the
// `Dispatcher` type retains exhaustiveness for the kinds that DO have
// handlers wired today (legacy 4) — new kinds are optional in the
// Dispatcher map so test fixtures that only register the legacy 4 keep
// type-checking, and the runner's runtime fallback (no-handler-registered →
// permanent failure) handles unregistered kinds safely.
// ---------------------------------------------------------------------------

/** T056 — provision a Google Cloud Compute VM for a queued scan. */
export interface SpawnScanVmJob {
  readonly type: "spawn_scan_vm";
  readonly scanOrderId: string;
  readonly scanId: string;
}

/** T058 — destroy a Google Cloud Compute VM. */
export interface TeardownScanVmJob {
  readonly type: "teardown_scan_vm";
  readonly scanOrderId: string;
  readonly scanId?: string;
  readonly vpsInstanceId: string;
  readonly vpsZone?: string;
}

/** T060 — render the PDF report and upload to S3. */
export interface RenderPdfJob {
  readonly type: "render_pdf";
  readonly scanId: string;
  readonly reportId: string;
}

/** T062 — send the scan-complete Telegram notification (PIVOT applied).
 *  Renamed from `send_scan_complete_email` per
 *  `docs/pivot-2026-05-19-telegram-auth.md`. */
export interface SendScanCompleteTelegramJob {
  readonly type: "send_scan_complete_telegram";
  readonly scanId: string;
  readonly scanOrderId: string;
  readonly reportId?: string;
  readonly userId: string;
}

/** Operator-alert envelope. Emitted by T056/T058/T060 on permanent failure
 *  and by future paths that need to reach the operator's Telegram. */
export interface RetryTelegramNotificationJob {
  readonly type: "retry_telegram_notification";
  readonly kind: string;
  readonly payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 003-whitebox additions — code-review engine job kinds.
//
// `pr_review` and `whitebox_scan` both run the shared review engine and persist
// via `review/service.ts`; they differ only in their candidate source (PR diff
// vs whole-repo). `resolve_threads` reconciles GitHub review threads after a
// re-review (resolving threads whose finding disappeared). `index_repo` is a
// placeholder for the future repo-map pre-index (out of MVP scope — handler is
// a no-op acknowledger today). All four are BlackboxJobType (optional in the
// Dispatcher) so test fixtures need not stub them.
// ---------------------------------------------------------------------------

/** Review a GitHub pull request (diff-scoped). Enqueued by the GitHub webhook. */
export interface PrReviewJob {
  readonly type: "pr_review";
  readonly reviewId: string;
}

/** Whitebox-scan a whole repository (full-tree-scoped). Enqueued by the API. */
export interface WhiteboxScanJob {
  readonly type: "whitebox_scan";
  readonly reviewId: string;
}

/** Reconcile GitHub review threads after a re-review of the same PR. */
export interface ResolveThreadsJob {
  readonly type: "resolve_threads";
  readonly reviewId: string;
}

/** Pre-index a repo's symbol map (future repo-map cache; no-op in MVP). */
export interface IndexRepoJob {
  readonly type: "index_repo";
  readonly repoId: string;
}

export type Job =
  | SpawnVpsJob
  | DispatchScanJob
  | WatchdogJob
  | TeardownVpsJob
  | SpawnScanVmJob
  | TeardownScanVmJob
  | RenderPdfJob
  | SendScanCompleteTelegramJob
  | RetryTelegramNotificationJob
  | PrReviewJob
  | WhiteboxScanJob
  | ResolveThreadsJob
  | IndexRepoJob;

export type JobType = Job["type"];

/** The four legacy job types from 001-backend-v2 (still wired through the
 *  same handler registry). `spawn_vps` and `teardown_vps` are deprecated
 *  aliases — see `runner.ts` for the warn-and-route behaviour. */
export type LegacyJobType =
  | "spawn_vps"
  | "dispatch_scan"
  | "watchdog_scan"
  | "teardown_vps";

/** The 002 additions that participate in the Dispatcher map optionally —
 *  this lets test fixtures keep registering only the legacy 4 without
 *  drowning under exhaustiveness errors, while production code registers
 *  all of them. */
export type BlackboxJobType = Exclude<JobType, LegacyJobType>;

// ---------------------------------------------------------------------------
// DB row shape — re-exported for runner consumers
// ---------------------------------------------------------------------------

/** Raw `jobs` row as returned by Drizzle. */
export type JobRow = typeof jobs.$inferSelect;

/** Permitted status values mirrored from the schema string enum. */
export type JobStatus = "pending" | "running" | "done" | "failed";

// ---------------------------------------------------------------------------
// Handler + dispatcher contract
// ---------------------------------------------------------------------------

/** Context passed to every handler so it can read the row's progress
 *  metadata (mostly for logging / audit). The dispatcher does NOT pass
 *  the DB handle: handlers reach out to the singleton `db` they were
 *  closed over at registration time. */
export interface HandlerContext {
  readonly jobId: string;
  readonly attempts: number;
}

export type Handler<P extends Job> = (
  payload: P,
  ctx: HandlerContext,
) => Promise<void> | void;

/** Compile-time map: every LEGACY job discriminant MUST have a
 *  registered handler, and the handler receives the typed sub-variant.
 *  The 002 additions (BlackboxJobType) are OPTIONAL — wiring lives in
 *  `server.ts` and test fixtures must not be forced to stub them.
 *
 *  Runtime contract: when the runner encounters a job whose type is not
 *  present in the Dispatcher, it marks the row permanently failed via
 *  the existing "no handler registered" branch in `runner.ts`. */
export type Dispatcher = {
  [K in LegacyJobType]: Handler<Extract<Job, { type: K }>>;
} & {
  [K in BlackboxJobType]?: Handler<Extract<Job, { type: K }>>;
};
