/**
 * T036 — Job runner: poll loop + atomic claim + retry-with-backoff.
 *
 * Lifecycle:
 *   start() → recursive setTimeout poll loop that calls `tick()` every
 *             `pollIntervalMs`. Recursive (not setInterval) so a slow
 *             handler never lets two ticks stack.
 *   tick()  → at-most-one job: atomically claim one `pending` row whose
 *             `scheduled_at <= now()`, dispatch its handler, and either
 *             mark it `done` or schedule a retry / fail it.
 *   stop()  → cancel the poll timer, then await any in-flight tick. Idle
 *             rows are left in `pending`; mid-flight ones complete normally.
 *   enqueue() → INSERT a new `pending` row, returning it.
 *
 * Atomic claim semantics:
 *   We open a `withTx` (which emits `BEGIN IMMEDIATE`) and inside:
 *     1. SELECT the oldest `pending` row whose `scheduled_at <= now()`.
 *     2. UPDATE that row to `status='running'`, `attempts+1` WHERE
 *        `id=? AND status='pending'`. The status guard turns the update
 *        into a CAS — if another connection raced us and won, the row's
 *        status is already `running` and our UPDATE affects 0 rows.
 *   BEGIN IMMEDIATE itself prevents two connections from both completing
 *   the SELECT+UPDATE pair: the second BEGIN is held off until the first
 *   commits, at which point the second SELECT sees the row as `running`
 *   and returns nothing to claim.
 *
 * Retry policy:
 *   On handler success → `status='done'`, `last_error=null`.
 *   On handler failure with `attempts < maxAttempts` →
 *     `status='pending'`, `scheduled_at = now() + 2^attempts * 1000`,
 *     `last_error = err.message`.
 *     Backoff math: with maxAttempts=5 and attempts incremented BEFORE
 *     dispatch, after the first failure attempts=1, backoff = 2s; second
 *     failure attempts=2, backoff = 4s; etc. up to attempts=4 → 16s.
 *     The 5th failure (attempts becomes 5) flips status to `failed`.
 *   On handler failure with `attempts >= maxAttempts` →
 *     `status='failed'`, audit emitted (if signingKey supplied),
 *     onError callback invoked.
 *
 * Audit emission:
 *   When a job permanently fails AND `signingKey` is set, the runner
 *   emits a `job_failed` row with `outcome='failure'` and metadata
 *   `{ job_id, type, error }`. The audit row is signed via
 *   `emitSignedAudit` (T014), preserving the canonical hash chain.
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { withTx, type DB } from "../db/client.ts";
import { jobs, scans } from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import { emitSignedAudit } from "../audit/emit.ts";
import type {
  Dispatcher,
  Job,
  JobRow,
  JobType,
  WatchdogJob,
} from "./types.ts";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60 * 1_000;

export interface RunnerOpts {
  readonly db: DB;
  readonly dispatcher: Dispatcher;
  readonly pollIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly signingKey?: string;
  /** Called when a job exhausts maxAttempts. Defaults to no-op. Tests
   *  use this to assert permanent-failure signalling without inspecting
   *  the audit chain. */
  readonly onError?: (err: Error, row: JobRow) => void;
  /** T061 — interval (ms) between periodic `watchdog_scan` enqueue
   *  sweeps. Default 5 minutes. Set to `0` to disable the periodic
   *  sweep entirely (tests + single-shot CLI runs). When enabled,
   *  `start()` schedules a recursive setTimeout that calls
   *  `scheduleWatchdog()` each tick; `stop()` cancels the timer and
   *  awaits any in-flight sweep. */
  readonly watchdogIntervalMs?: number;
}

export interface Runner {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<JobRow | null>;
  enqueue<T extends Job>(
    job: T,
    opts?: { delayMs?: number },
  ): Promise<JobRow>;
  /** T061 — sweep `scans` for status='running' rows and enqueue one
   *  `watchdog_scan` job per scan that does NOT already have an
   *  outstanding (pending|running) watchdog job. Returns the number of
   *  jobs enqueued during this sweep. Exposed for tests + manual /
   *  cron-style invocations. */
  scheduleWatchdog(): Promise<{ enqueued: number }>;
}

/**
 * Build a runner over `opts.db`. Calling `start()` is OPT-IN — the
 * returned instance is dormant until you call it. `tick()` is exposed
 * for tests and for manual processing in single-step debugging.
 */
export function createRunner(opts: RunnerOpts): Runner {
  const {
    db,
    dispatcher,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    now = defaultNow,
    signingKey,
    onError,
    watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
  } = opts;

  // Mutable state: the poll timer handle and the currently-in-flight
  // tick promise. `stop()` cancels the timer and awaits the promise.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  // T061 — independent watchdog scheduler state. Kept SEPARATE from the
  // poll loop so a slow watchdog sweep never delays a job tick and vice
  // versa; `stop()` awaits both.
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogInFlight: Promise<unknown> | null = null;

  // ---- enqueue ----------------------------------------------------------
  const enqueue: Runner["enqueue"] = async (job, eOpts) => {
    const delay = eOpts?.delayMs ?? 0;
    const ts = now();
    const id = ulid(ts);
    const row: typeof jobs.$inferInsert = {
      id,
      type: job.type,
      payloadJson: JSON.stringify(job),
      status: "pending",
      scheduledAt: ts + delay,
      attempts: 0,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
    };
    db.insert(jobs).values(row).run();
    const inserted = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!inserted) {
      throw new Error("runner.enqueue: INSERT did not produce a row");
    }
    return inserted;
  };

  // ---- atomic claim ------------------------------------------------------
  // Returns the claimed row (status='running', attempts incremented) or
  // null if no row is currently claimable. `BEGIN IMMEDIATE` serialises
  // concurrent claim attempts across separate connections.
  async function claimNext(): Promise<JobRow | null> {
    return await withTx(db, async (tx) => {
      const ts = now();
      const candidate = tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, "pending"), lte(jobs.scheduledAt, ts)))
        .orderBy(asc(jobs.scheduledAt), asc(jobs.id))
        .limit(1)
        .get();
      if (!candidate) return null;

      // CAS update — guards against a sibling connection that beat us
      // to BEGIN IMMEDIATE (shouldn't happen given the lock semantics,
      // but the guard makes the contract self-enforcing).
      const upd = tx
        .update(jobs)
        .set({
          status: "running",
          attempts: candidate.attempts + 1,
          updatedAt: ts,
        })
        .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "pending")))
        .returning()
        .get();
      return upd ?? null;
    });
  }

  // ---- dispatch + persist outcome ---------------------------------------
  async function processClaimed(row: JobRow): Promise<void> {
    let parsed: Job;
    try {
      parsed = JSON.parse(row.payloadJson) as Job;
    } catch (err) {
      // Malformed payload — terminal failure, do not retry.
      await finalizeFailure(
        row,
        new Error(
          `job ${row.id}: payload_json is not valid JSON: ${(err as Error).message}`,
        ),
        /*permanent=*/ true,
      );
      return;
    }

    const handlerKey = parsed.type as JobType;
    const handler = dispatcher[handlerKey] as
      | ((p: Job, ctx: { jobId: string; attempts: number }) => Promise<void> | void)
      | undefined;

    if (!handler) {
      await finalizeFailure(
        row,
        new Error(`job ${row.id}: no handler registered for type='${handlerKey}'`),
        /*permanent=*/ true,
      );
      return;
    }

    try {
      // `row.attempts` already reflects the post-claim count because
      // claimNext().returning() yields the UPDATED row.
      await handler(parsed, { jobId: row.id, attempts: row.attempts });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await finalizeFailure(
        row,
        error,
        /*permanent=*/ row.attempts >= maxAttempts,
      );
      return;
    }

    // Handler success — mark done.
    const ts = now();
    db.update(jobs)
      .set({
        status: "done",
        lastError: null,
        updatedAt: ts,
      })
      .where(eq(jobs.id, row.id))
      .run();
  }

  async function finalizeFailure(
    row: JobRow,
    err: Error,
    permanent: boolean,
  ): Promise<void> {
    const ts = now();
    // `row.attempts` here is the POST-claim count (returned by the CAS
    // update's RETURNING clause). Backoff exponent matches that count
    // directly: 1st failure → 2s, 2nd → 4s, 3rd → 8s, 4th → 16s.
    if (permanent) {
      db.update(jobs)
        .set({
          status: "failed",
          lastError: err.message,
          updatedAt: ts,
        })
        .where(eq(jobs.id, row.id))
        .run();
      if (signingKey) {
        try {
          await emitSignedAudit(
            db,
            {
              event: "job_failed",
              outcome: "failure",
              ts,
              metadata: {
                error: err.message,
                job_id: row.id,
                type: row.type,
              },
            },
            { key: signingKey },
          );
        } catch (auditErr) {
          // Audit emission must NEVER block job-status persistence. Log
          // through onError so tests can detect it without console noise.
          if (onError) {
            onError(
              new Error(
                `audit emission failed for job ${row.id}: ${(auditErr as Error).message}`,
              ),
              row,
            );
          }
        }
      }
      if (onError) onError(err, row);
    } else {
      const backoffMs = Math.pow(2, row.attempts) * BACKOFF_BASE_MS;
      db.update(jobs)
        .set({
          status: "pending",
          lastError: err.message,
          scheduledAt: ts + backoffMs,
          updatedAt: ts,
        })
        .where(eq(jobs.id, row.id))
        .run();
    }
  }

  // ---- tick --------------------------------------------------------------
  const tick: Runner["tick"] = async () => {
    const claimed = await claimNext();
    if (!claimed) return null;
    await processClaimed(claimed);
    return claimed;
  };

  // ---- T061 — periodic watchdog enqueue ---------------------------------
  // Sweep `scans` for status='running' rows. For each, check whether an
  // outstanding (pending|running) `watchdog_scan` job already targets
  // that scan; if not, INSERT a fresh `watchdog_scan` job with
  // `consecutive_failures: 0` scheduled for `now()` (immediate).
  //
  // Idempotency rationale: handler reschedules itself with a 5min delay
  // (see handlers/watchdog.ts), so absent this guard a periodic sweep
  // would stack a second outstanding probe whenever the sweep cadence
  // happened to fall between dispatch and handler completion. We match
  // the scan_id substring inside `payload_json` because the column is a
  // JSON-encoded string of the full payload — `"scan_id":"<id>"` is the
  // canonical form produced by `enqueue()` / `reschedule()`. Both code
  // paths use `JSON.stringify` which always emits the field in that
  // exact form (no whitespace, key always quoted), so substring matching
  // is safe and avoids a JSON-extension dependency on the SQLite build.
  const scheduleWatchdog: Runner["scheduleWatchdog"] = async () => {
    const runningScans = db
      .select({ id: scans.id })
      .from(scans)
      .where(eq(scans.status, "running"))
      .all();
    if (runningScans.length === 0) return { enqueued: 0 };

    // Pre-fetch ALL outstanding watchdog rows in one query, then bucket
    // by scan_id, so the inner per-scan check is O(1) and we don't
    // emit N round-trips.
    const outstanding = db
      .select({ payloadJson: jobs.payloadJson })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "watchdog_scan"),
          inArray(jobs.status, ["pending", "running"]),
        ),
      )
      .all();
    const covered = new Set<string>();
    for (const row of outstanding) {
      try {
        const p = JSON.parse(row.payloadJson) as { scan_id?: unknown };
        if (typeof p.scan_id === "string") covered.add(p.scan_id);
      } catch {
        // Malformed payloads are tolerated — they'll be culled by the
        // handler's defensive parse + the runner's max-attempts loop.
      }
    }

    let enqueued = 0;
    for (const s of runningScans) {
      if (covered.has(s.id)) continue;
      const ts = now();
      const id = ulid(ts);
      const payload: WatchdogJob = {
        type: "watchdog_scan",
        scan_id: s.id,
        consecutive_failures: 0,
      };
      db.insert(jobs)
        .values({
          id,
          type: "watchdog_scan",
          payloadJson: JSON.stringify(payload),
          status: "pending",
          scheduledAt: ts,
          attempts: 0,
          lastError: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      // Add to the covered set so a subsequent iteration in the same
      // sweep (multiple running scans → impossible to collide here, but
      // defensive against future code paths that share state) doesn't
      // re-enqueue.
      covered.add(s.id);
      enqueued += 1;
    }
    return { enqueued };
  };

  // ---- start / stop ------------------------------------------------------
  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped) return;
      const p = tick().catch(() => null);
      inFlight = p;
      try {
        await p;
      } finally {
        inFlight = null;
      }
      if (!stopped) scheduleNext();
    }, pollIntervalMs);
  }

  // Recursive setTimeout for the watchdog sweep (NOT setInterval — same
  // rationale as the poll loop: a slow sweep must never stack a second
  // tick on top of itself).
  function scheduleNextWatchdog(): void {
    if (stopped) return;
    if (watchdogIntervalMs <= 0) return;
    watchdogTimer = setTimeout(async () => {
      watchdogTimer = null;
      if (stopped) return;
      const p = scheduleWatchdog().catch(() => ({ enqueued: 0 }));
      watchdogInFlight = p;
      try {
        await p;
      } finally {
        watchdogInFlight = null;
      }
      if (!stopped) scheduleNextWatchdog();
    }, watchdogIntervalMs);
  }

  function start(): void {
    if (stopped) {
      throw new Error("runner.start: cannot restart a stopped runner");
    }
    if (timer !== null || inFlight !== null) return;
    scheduleNext();
    if (watchdogIntervalMs > 0 && watchdogTimer === null) {
      scheduleNextWatchdog();
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // tick swallows handler errors internally; defensive.
      }
    }
    if (watchdogInFlight) {
      try {
        await watchdogInFlight;
      } catch {
        // scheduleWatchdog catches its own errors above; defensive.
      }
    }
  }

  // Silence unused-import lint — sql is part of the canonical drizzle
  // surface that downstream patches will likely need.
  void sql;

  return { start, stop, tick, enqueue, scheduleWatchdog };
}

export type { Dispatcher } from "./types.ts";
