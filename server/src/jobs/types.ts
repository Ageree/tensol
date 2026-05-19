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

export type Job =
  | SpawnVpsJob
  | DispatchScanJob
  | WatchdogJob
  | TeardownVpsJob;

export type JobType = Job["type"];

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

/** Compile-time exhaustive map: every job discriminant MUST have a
 *  registered handler, and the handler receives the typed sub-variant. */
export type Dispatcher = {
  [K in JobType]: Handler<Extract<Job, { type: K }>>;
};
