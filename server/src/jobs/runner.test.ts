/**
 * T036 — jobs/runner tests.
 *
 * Nine guarantees this test file pins down:
 *   1. enqueue + manual tick: a queued job is claimed, dispatched, and marked
 *      `done` with attempts=1 and `last_error=null`.
 *   2. Concurrent claim across TWO independent connections — only one runner
 *      observes the row; the other returns null. Status ends `done`,
 *      attempts=1. This is the canonical "two pollers can't claim same row"
 *      contract from T036.
 *   3. Handler exception → row goes back to `pending` with
 *      `scheduled_at = now() + 2^attempts * 1000` and `last_error` set.
 *   4. 6th attempt (i.e. attempts after increment == maxAttempts == 5) →
 *      status `failed`, no further retry scheduled.
 *   5. Row whose `scheduled_at > now()` is not claimable — tick returns null.
 *   6. start()/stop() lifecycle: start the poller, enqueue 3 jobs, await stop
 *      — all three end `done`, no orphaned `running` rows.
 *   7. Dispatcher routes each `type` to the right handler with the right
 *      typed payload (one job per discriminant).
 *   8. Clean shutdown mid-flight: a handler awaits 200ms; `stop()` waits for
 *      it to finish; row ends `done`, not `running`.
 *   9. Audit emission on permanent failure: when `signingKey` is supplied,
 *      reaching maxAttempts emits a `job_failed` audit row with the job
 *      type and error in metadata.
 *
 * Why a real temp file for the concurrency test:
 *   bun:sqlite single-handle transactions are serialised by the JS event
 *   loop; only cross-connection contention exercises `BEGIN IMMEDIATE`. Two
 *   `:memory:` opens are INDEPENDENT databases, so we must share a file.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import {
  jobs,
  auditLog,
  scans,
  targets,
  projects,
  users,
} from "../db/schema.ts";
import { createRunner, type Dispatcher } from "./runner.ts";
import type {
  Job,
  SpawnVpsJob,
  DispatchScanJob,
  WatchdogJob,
  TeardownVpsJob,
} from "./types.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .sql migrations found in ${MIGRATIONS_DIR}`);
  }
  return files
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

function applyMigrations(db: DB): void {
  (db.$client as Database).exec(migrationSql());
}

/** A no-op dispatcher useful when the test only exercises claim semantics. */
function noopDispatcher(): Dispatcher {
  return {
    spawn_vps: () => {},
    dispatch_scan: () => {},
    watchdog_scan: () => {},
    teardown_vps: () => {},
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-runner-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — enqueue + tick happy path
// ---------------------------------------------------------------------------
test("enqueue + tick: handler is called with typed payload, row → done", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  let received: SpawnVpsJob | null = null;
  const dispatcher: Dispatcher = {
    ...noopDispatcher(),
    spawn_vps: (payload) => {
      received = payload;
    },
  };

  const runner = createRunner({ db, dispatcher });
  const enqueued = await runner.enqueue({
    type: "spawn_vps",
    scan_id: "01H0000000000000000000SCAN",
  });
  expect(enqueued.status).toBe("pending");
  expect(enqueued.attempts).toBe(0);

  const claimed = await runner.tick();
  expect(claimed).not.toBeNull();
  expect(received).not.toBeNull();
  expect(received!.type).toBe("spawn_vps");
  expect(received!.scan_id).toBe("01H0000000000000000000SCAN");

  const row = db.select().from(jobs).where(eq(jobs.id, enqueued.id)).get()!;
  expect(row.status).toBe("done");
  expect(row.attempts).toBe(1);
  expect(row.lastError).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 2 — concurrent claim across two connections
// ---------------------------------------------------------------------------
test(
  "two pollers across separate connections cannot both claim the same row",
  async () => {
    const dbPath = join(tmpDir, "concurrent.sqlite");

    const boot = createDb(dbPath);
    applyMigrations(boot);
    (boot.$client as Database).close();

    const connA = createDb(dbPath);
    const connB = createDb(dbPath);

    try {
      let aCount = 0;
      let bCount = 0;
      const dispatcherA: Dispatcher = {
        ...noopDispatcher(),
        spawn_vps: async () => {
          aCount += 1;
          // small await so the JS scheduler hands control to runner B's
          // tick if it managed to claim first — without BEGIN IMMEDIATE
          // this is where both pollers could double-fire.
          await new Promise((r) => setTimeout(r, 5));
        },
      };
      const dispatcherB: Dispatcher = {
        ...noopDispatcher(),
        spawn_vps: async () => {
          bCount += 1;
          await new Promise((r) => setTimeout(r, 5));
        },
      };

      const runnerA = createRunner({ db: connA, dispatcher: dispatcherA });
      const runnerB = createRunner({ db: connB, dispatcher: dispatcherB });

      // Use either runner to enqueue — they share the same file.
      const enqueued = await runnerA.enqueue({
        type: "spawn_vps",
        scan_id: "01H0000000000000000000RACE",
      });

      // Race two ticks.
      const [resA, resB] = await Promise.all([runnerA.tick(), runnerB.tick()]);

      // Exactly one runner claimed; the other returned null.
      const claims = [resA, resB].filter((r) => r !== null);
      expect(claims).toHaveLength(1);
      expect(aCount + bCount).toBe(1);

      const row = connA.select().from(jobs).where(eq(jobs.id, enqueued.id)).get()!;
      expect(row.status).toBe("done");
      expect(row.attempts).toBe(1);
    } finally {
      (connA.$client as Database).close();
      (connB.$client as Database).close();
    }
  },
  15_000,
);

// ---------------------------------------------------------------------------
// Test 3 — handler exception → retry scheduled with exponential backoff
// ---------------------------------------------------------------------------
test("handler exception reschedules with 2^attempts * 1000 ms backoff", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  let clockMs = 1_000_000;
  const clock = () => clockMs;

  const dispatcher: Dispatcher = {
    ...noopDispatcher(),
    spawn_vps: () => {
      throw new Error("boom");
    },
  };

  const runner = createRunner({ db, dispatcher, now: clock });
  const enqueued = await runner.enqueue({
    type: "spawn_vps",
    scan_id: "01H0000000000000000000FAIL",
  });

  await runner.tick();
  const row = db.select().from(jobs).where(eq(jobs.id, enqueued.id)).get()!;
  expect(row.status).toBe("pending");
  expect(row.attempts).toBe(1);
  expect(row.lastError).toBe("boom");
  // attempts after increment == 1, so backoff = 2^1 = 2 seconds = 2000ms.
  expect(row.scheduledAt).toBe(clockMs + 2_000);
});

// ---------------------------------------------------------------------------
// Test 4 — 5th failed attempt flips status to 'failed' (no further retry)
// ---------------------------------------------------------------------------
test("max attempts reached → status='failed', no retry scheduled", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const dispatcher: Dispatcher = {
    ...noopDispatcher(),
    spawn_vps: () => {
      throw new Error("permanent");
    },
  };

  const onErrorCalls: Array<{ err: Error; jobId: string }> = [];
  const runner = createRunner({
    db,
    dispatcher,
    onError: (err, row) => {
      onErrorCalls.push({ err, jobId: row.id });
    },
  });

  // Seed a job at attempts=4 directly. After tick, attempts becomes 5
  // which == maxAttempts(default 5) → status flips to 'failed'.
  const id = "01H0000000000000000000DOOM";
  const ts = Date.now();
  db.insert(jobs)
    .values({
      id,
      type: "spawn_vps",
      payloadJson: JSON.stringify({
        type: "spawn_vps",
        scan_id: "01H0000000000000000000SC",
      }),
      status: "pending",
      scheduledAt: ts - 1,
      attempts: 4,
      lastError: "prior",
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  await runner.tick();
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get()!;
  expect(row.status).toBe("failed");
  expect(row.attempts).toBe(5);
  expect(row.lastError).toBe("permanent");
  expect(onErrorCalls).toHaveLength(1);
  expect(onErrorCalls[0]!.jobId).toBe(id);
});

// ---------------------------------------------------------------------------
// Test 5 — scheduled_at in the future blocks claim
// ---------------------------------------------------------------------------
test("row scheduled in the future is not claimable", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  let clockMs = 1_000_000;
  const runner = createRunner({
    db,
    dispatcher: noopDispatcher(),
    now: () => clockMs,
  });

  await runner.enqueue(
    { type: "spawn_vps", scan_id: "01H0000000000000000000LTR" },
    { delayMs: 10_000 },
  );

  const res = await runner.tick();
  expect(res).toBeNull();

  // After clock advances past scheduled_at, it becomes claimable.
  clockMs += 10_001;
  const res2 = await runner.tick();
  expect(res2).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Test 6 — start/stop lifecycle processes queued jobs
// ---------------------------------------------------------------------------
test("start() polls and processes jobs; stop() drains in-flight", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  let processed = 0;
  const dispatcher: Dispatcher = {
    ...noopDispatcher(),
    spawn_vps: () => {
      processed += 1;
    },
  };

  const runner = createRunner({ db, dispatcher, pollIntervalMs: 10 });
  for (let i = 0; i < 3; i++) {
    await runner.enqueue({
      type: "spawn_vps",
      scan_id: `01H000000000000000000000${i}`,
    });
  }

  runner.start();
  // Spin until the runner has had time to claim all three. Cap at 2s.
  const deadline = Date.now() + 2_000;
  while (processed < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await runner.stop();

  expect(processed).toBe(3);
  const remaining = db.select().from(jobs).all();
  expect(remaining.every((r) => r.status === "done")).toBe(true);
  // No orphaned 'running' rows after stop.
  expect(remaining.some((r) => r.status === "running")).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 7 — dispatcher routes each job type to its typed handler
// ---------------------------------------------------------------------------
test("dispatcher routes per-type with correctly typed payload", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const seen: Job[] = [];
  const dispatcher: Dispatcher = {
    spawn_vps: (p: SpawnVpsJob) => {
      seen.push(p);
    },
    dispatch_scan: (p: DispatchScanJob) => {
      seen.push(p);
    },
    watchdog_scan: (p: WatchdogJob) => {
      seen.push(p);
    },
    teardown_vps: (p: TeardownVpsJob) => {
      seen.push(p);
    },
  };

  const runner = createRunner({ db, dispatcher });
  await runner.enqueue({ type: "spawn_vps", scan_id: "01H0SCAN0000000000000000A" });
  await runner.enqueue({
    type: "dispatch_scan",
    scan_id: "01H0SCAN0000000000000000B",
    vps_instance_id: "01H0VPS00000000000000000B",
  });
  await runner.enqueue({ type: "watchdog_scan", scan_id: "01H0SCAN0000000000000000C" });
  await runner.enqueue({
    type: "teardown_vps",
    vps_instance_id: "01H0VPS00000000000000000D",
    reason: "scan_completed",
  });

  for (let i = 0; i < 4; i++) await runner.tick();

  expect(seen).toHaveLength(4);
  const byType = new Map(seen.map((j) => [j.type, j]));
  expect(byType.get("spawn_vps")).toEqual({
    type: "spawn_vps",
    scan_id: "01H0SCAN0000000000000000A",
  });
  expect(byType.get("dispatch_scan")).toEqual({
    type: "dispatch_scan",
    scan_id: "01H0SCAN0000000000000000B",
    vps_instance_id: "01H0VPS00000000000000000B",
  });
  expect(byType.get("watchdog_scan")).toEqual({
    type: "watchdog_scan",
    scan_id: "01H0SCAN0000000000000000C",
  });
  expect(byType.get("teardown_vps")).toEqual({
    type: "teardown_vps",
    vps_instance_id: "01H0VPS00000000000000000D",
    reason: "scan_completed",
  });
});

// ---------------------------------------------------------------------------
// Test 8 — clean shutdown waits for an in-flight handler
// ---------------------------------------------------------------------------
test("stop() awaits in-flight handler; no row left in 'running'", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  let handlerEntered = false;
  let handlerCompleted = false;
  const dispatcher: Dispatcher = {
    ...noopDispatcher(),
    spawn_vps: async () => {
      handlerEntered = true;
      await new Promise((r) => setTimeout(r, 200));
      handlerCompleted = true;
    },
  };

  const runner = createRunner({ db, dispatcher, pollIntervalMs: 5 });
  const enqueued = await runner.enqueue({
    type: "spawn_vps",
    scan_id: "01H0000000000000000000SHT",
  });

  runner.start();
  // Wait until the handler has been entered.
  const deadline = Date.now() + 1_000;
  while (!handlerEntered && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(handlerEntered).toBe(true);
  // Now stop — must NOT return until handler completes.
  await runner.stop();
  expect(handlerCompleted).toBe(true);

  const row = db.select().from(jobs).where(eq(jobs.id, enqueued.id)).get()!;
  expect(row.status).toBe("done");
});

// ---------------------------------------------------------------------------
// Test 9 — audit emission on permanent failure
// ---------------------------------------------------------------------------
test("permanent failure emits 'job_failed' signed audit row when key supplied", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const dispatcher: Dispatcher = {
    ...noopDispatcher(),
    teardown_vps: () => {
      throw new Error("kaput");
    },
  };

  const runner = createRunner({
    db,
    dispatcher,
    signingKey: "test-key-runner",
  });

  const id = "01H0000000000000000000AUD";
  const ts = Date.now();
  db.insert(jobs)
    .values({
      id,
      type: "teardown_vps",
      payloadJson: JSON.stringify({
        type: "teardown_vps",
        vps_instance_id: "01H0VPS00000000000000000A",
        reason: "scan_completed",
      }),
      status: "pending",
      scheduledAt: ts - 1,
      attempts: 4,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  await runner.tick();

  const row = db.select().from(jobs).where(eq(jobs.id, id)).get()!;
  expect(row.status).toBe("failed");

  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "job_failed"))
    .all();
  expect(auditRows).toHaveLength(1);
  const a = auditRows[0]!;
  expect(a.outcome).toBe("failure");
  const meta = JSON.parse(a.metadataJson) as Record<string, unknown>;
  expect(meta.error).toBe("kaput");
  expect(meta.job_id).toBe(id);
  expect(meta.type).toBe("teardown_vps");

  // Silence unused-import lint — sql is part of the canonical drizzle surface.
  void sql;
});

// ---------------------------------------------------------------------------
// T061 — periodic watchdog enqueue
//
// The runner exposes `scheduleWatchdog()` — a single-shot sweep that scans
// the `scans` table for status='running' rows and enqueues exactly one
// `watchdog_scan` job per running scan that does NOT already have an
// outstanding (status='pending' OR 'running') `watchdog_scan` job in the
// `jobs` table. Idempotency is enforced by inspecting `payload_json` for
// the canonical `"scan_id":"<id>"` substring.
//
// When `start()` is called with `watchdogIntervalMs > 0`, the runner also
// kicks off a recursive setTimeout that calls `scheduleWatchdog()` on
// each tick (mirroring the poll-loop pattern). `stop()` cancels the
// watchdog timer and awaits any in-flight sweep before resolving.
// ---------------------------------------------------------------------------

interface SeedScanArgs {
  readonly id: string;
  readonly status: "queued" | "running" | "completed" | "failed" | "cancelled";
  readonly startedAt?: number;
}

/** Insert a user + project + target + scan chain so the FK references on
 *  `scans` are satisfied. Returns the inserted scan id. */
function seedScan(db: DB, s: SeedScanArgs): string {
  const ts = s.startedAt ?? 1_000_000;
  const userId = `USR-${s.id}`;
  const projectId = `PRJ-${s.id}`;
  const targetId = `TGT-${s.id}`;
  db.insert(users)
    .values({ id: userId, email: `${s.id}@test`, createdAt: ts })
    .run();
  db.insert(projects)
    .values({ id: projectId, userId, name: "p", createdAt: ts })
    .run();
  db.insert(targets)
    .values({
      id: targetId,
      projectId,
      url: "https://example.com",
      status: "verified",
      verifiedAt: ts,
      createdAt: ts,
    })
    .run();
  db.insert(scans)
    .values({
      id: s.id,
      userId,
      targetId,
      profile: "recon",
      status: s.status,
      startedAt: ts,
    })
    .run();
  return s.id;
}

// ---------------------------------------------------------------------------
// T061 Test 1 — scheduleWatchdog enqueues one job per running scan
// ---------------------------------------------------------------------------
test("scheduleWatchdog enqueues one watchdog_scan per running scan, skips terminal", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, { id: "01H0SCANRUNNING000000000A", status: "running" });
  seedScan(db, { id: "01H0SCANRUNNING000000000B", status: "running" });
  seedScan(db, { id: "01H0SCANDONE0000000000001", status: "completed" });
  seedScan(db, { id: "01H0SCANFAIL0000000000001", status: "failed" });
  seedScan(db, { id: "01H0SCANQUEUE000000000001", status: "queued" });

  const runner = createRunner({
    db,
    dispatcher: noopDispatcher(),
    watchdogIntervalMs: 0, // periodic loop OFF; test calls method directly
  });

  const res = await runner.scheduleWatchdog();
  expect(res.enqueued).toBe(2);

  const enqueuedRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(enqueuedRows).toHaveLength(2);
  expect(enqueuedRows.every((r) => r.status === "pending")).toBe(true);

  const seenScanIds = new Set(
    enqueuedRows.map((r) => {
      const p = JSON.parse(r.payloadJson) as {
        type: string;
        scan_id: string;
        consecutive_failures?: number;
      };
      expect(p.type).toBe("watchdog_scan");
      expect(p.consecutive_failures).toBe(0);
      return p.scan_id;
    }),
  );
  expect(seenScanIds.has("01H0SCANRUNNING000000000A")).toBe(true);
  expect(seenScanIds.has("01H0SCANRUNNING000000000B")).toBe(true);
});

// ---------------------------------------------------------------------------
// T061 Test 2 — idempotent (does not double-enqueue while one is outstanding)
// ---------------------------------------------------------------------------
test("scheduleWatchdog does NOT double-enqueue when an outstanding job exists", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, { id: "01H0SCANRUNNING000000000C", status: "running" });

  const runner = createRunner({
    db,
    dispatcher: noopDispatcher(),
    watchdogIntervalMs: 0,
  });

  const r1 = await runner.scheduleWatchdog();
  expect(r1.enqueued).toBe(1);

  const r2 = await runner.scheduleWatchdog();
  expect(r2.enqueued).toBe(0);

  const allWatchdogs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(allWatchdogs).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// T061 Test 3 — after handler processes the job, next sweep enqueues again
// ---------------------------------------------------------------------------
test("scheduleWatchdog re-enqueues after the previous watchdog job is done", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  const scanId = seedScan(db, {
    id: "01H0SCANRUNNING000000000D",
    status: "running",
  });

  const runner = createRunner({
    db,
    dispatcher: noopDispatcher(),
    watchdogIntervalMs: 0,
  });

  const r1 = await runner.scheduleWatchdog();
  expect(r1.enqueued).toBe(1);

  // Hand-mark the outstanding job done (simulating handler completion).
  db.update(jobs)
    .set({ status: "done", updatedAt: 2_000_000 })
    .where(eq(jobs.type, "watchdog_scan"))
    .run();

  const r2 = await runner.scheduleWatchdog();
  expect(r2.enqueued).toBe(1);

  const allWatchdogs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(allWatchdogs).toHaveLength(2);
  // Both reference the same scan id.
  for (const r of allWatchdogs) {
    const p = JSON.parse(r.payloadJson) as { scan_id: string };
    expect(p.scan_id).toBe(scanId);
  }
});

// ---------------------------------------------------------------------------
// T061 Test 4 — start() fires scheduleWatchdog periodically
// ---------------------------------------------------------------------------
test("start() with watchdogIntervalMs>0 periodically fires scheduleWatchdog", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, { id: "01H0SCANRUNNING000000000E", status: "running" });

  const runner = createRunner({
    db,
    dispatcher: noopDispatcher(),
    pollIntervalMs: 10_000, // keep poll loop quiet so it doesn't claim
    watchdogIntervalMs: 30,
  });

  runner.start();
  // Spin until we observe at least one watchdog_scan row.
  const deadline = Date.now() + 1_000;
  let watchdogJobs: number = 0;
  while (Date.now() < deadline) {
    watchdogJobs = db
      .select()
      .from(jobs)
      .where(eq(jobs.type, "watchdog_scan"))
      .all().length;
    if (watchdogJobs > 0) break;
    await new Promise((r) => setTimeout(r, 15));
  }
  await runner.stop();

  expect(watchdogJobs).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// T061 Test 5 — watchdogIntervalMs=0 disables the periodic loop
// ---------------------------------------------------------------------------
test("watchdogIntervalMs=0 disables the periodic watchdog sweep", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, { id: "01H0SCANRUNNING000000000F", status: "running" });

  const runner = createRunner({
    db,
    dispatcher: noopDispatcher(),
    pollIntervalMs: 10_000,
    watchdogIntervalMs: 0,
  });

  runner.start();
  await new Promise((r) => setTimeout(r, 80));
  await runner.stop();

  const watchdogJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(watchdogJobs).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// T061 Test 6 — stop() cleanly cancels the watchdog timer (no orphan ticks)
// ---------------------------------------------------------------------------
test("stop() cancels the watchdog timer; no new jobs after shutdown", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  seedScan(db, { id: "01H0SCANRUNNING000000000G", status: "running" });

  const runner = createRunner({
    db,
    dispatcher: noopDispatcher(),
    pollIntervalMs: 10_000,
    watchdogIntervalMs: 20,
  });

  runner.start();
  // Allow at least one tick to fire.
  await new Promise((r) => setTimeout(r, 60));
  await runner.stop();

  const countAfterStop = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all().length;

  // Wait well past the interval; no further enqueues must occur.
  await new Promise((r) => setTimeout(r, 100));
  const countLater = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all().length;

  expect(countLater).toBe(countAfterStop);
});
