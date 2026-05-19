/**
 * T060 — watchdog_scan handler tests.
 *
 * The handler is built via `createWatchdogHandler({ db, fetchImpl,
 * signingKey, now, stuckThresholdMs, rescheduleDelayMs,
 * maxConsecutiveFailures })`. `fetchImpl` is fully mocked (no real
 * network), and the clock is injected so tests are deterministic.
 *
 * Counter model: `consecutive_failures` is carried inside the
 * `WatchdogJob` payload. Each failed probe re-enqueues a new
 * watchdog_scan job with `consecutive_failures+1`; each successful
 * probe re-enqueues with 0. When the incoming payload's counter is
 * already `maxConsecutiveFailures - 1` (i.e. the third probe is the
 * one we're handling) and the probe fails, the kill switch fires:
 * scan→failed, teardown enqueued, terminal audit.
 *
 * Coverage targets (per T060 brief):
 *   1. Scan not 'running' (already terminal) → no-op.
 *   2. Scan running < stuckThresholdMs → no-op + reschedule self in
 *      `rescheduleDelayMs`. consecutive_failures resets to 0.
 *   3. Scan running >= threshold + alive agent (200 OK) → no scan
 *      state change; reschedule watchdog +5min with counter=0;
 *      `watchdog_action` audit with outcome=success.
 *   4. Single failure (incoming counter=0, fetch fails) → no scan
 *      state change; reschedule with counter=1; audit
 *      outcome=failure, terminal=false.
 *   5. 3rd consecutive failure (incoming counter=2, fetch fails) →
 *      scan.status='failed' + failure_reason='agent_unresponsive' +
 *      completed_at set; teardown_vps job enqueued for the VPS;
 *      `watchdog_action` audit (terminal=true) + `scan_failed`
 *      audit. No further watchdog reschedule.
 *   6. Network-level fetch error counts as a failure (same path as
 *      non-2xx).
 *   7. Audit chain verifies after a sequence of probes.
 *   8. No vps_instance present (cleanup race) → no-op (no probe, no
 *      reschedule, no audit).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { createDb, type DB } from "../../db/client.ts";
import {
  auditLog,
  jobs,
  projects,
  scans,
  targets,
  users,
  vpsInstances,
} from "../../db/schema.ts";
import { verifyChain } from "../../audit/verify-chain.ts";
import { createWatchdogHandler } from "./watchdog.ts";
import type { TeardownVpsJob, WatchdogJob } from "../types.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "migrations");

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
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

const TEST_SIGNING_KEY = "test-audit-signing-key-watchdog";

const FIXED_USER_ID = "01H0USER00000000000000000A";
const FIXED_PROJECT_ID = "01H0PROJ00000000000000000A";
const FIXED_TARGET_ID = "01H0TGT0000000000000000000A";
const FIXED_SCAN_ID = "01H0SCAN00000000000000000A";
const FIXED_VPS_ID = "01H0VPS000000000000000000A";
const FIXED_PROVIDER_SERVER_ID = "srv-watchdog-1";
const FIXED_VPS_IPV4 = "10.0.0.42";

const SEED_TS = 1_700_000_000_000;
const THIRTY_ONE_MIN_MS = 31 * 60 * 1_000;
const FIVE_MIN_MS = 5 * 60 * 1_000;

interface SeedOpts {
  readonly scanStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
  /** Seed the vps row (true) or skip it for "no vps_instance" tests. */
  readonly includeVps?: boolean;
  /** Override scans.started_at (defaults to SEED_TS). */
  readonly startedAt?: number;
}

function seedScan(db: DB, opts: SeedOpts = {}): void {
  const {
    scanStatus = "running",
    includeVps = true,
    startedAt = SEED_TS,
  } = opts;
  db.insert(users)
    .values({ id: FIXED_USER_ID, email: "u@x.test", createdAt: SEED_TS })
    .run();
  db.insert(projects)
    .values({
      id: FIXED_PROJECT_ID,
      userId: FIXED_USER_ID,
      name: "P",
      createdAt: SEED_TS,
    })
    .run();
  db.insert(targets)
    .values({
      id: FIXED_TARGET_ID,
      projectId: FIXED_PROJECT_ID,
      url: "https://example.test",
      status: "verified",
      verifiedAt: SEED_TS,
      createdAt: SEED_TS,
    })
    .run();
  db.insert(scans)
    .values({
      id: FIXED_SCAN_ID,
      userId: FIXED_USER_ID,
      targetId: FIXED_TARGET_ID,
      profile: "recon",
      status: scanStatus,
      startedAt,
    })
    .run();
  if (includeVps) {
    db.insert(vpsInstances)
      .values({
        id: FIXED_VPS_ID,
        scanId: FIXED_SCAN_ID,
        provider: "hetzner",
        providerServerId: FIXED_PROVIDER_SERVER_ID,
        ipv4: FIXED_VPS_IPV4,
        status: "alive",
        signKey: "deadbeef".repeat(8),
        createdAt: SEED_TS,
      })
      .run();
  }
}

type FetchCall = { url: string };

function makeFetchMock(opts: {
  status?: number;
  throws?: Error;
}): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    if (opts.throws) throw opts.throws;
    return new Response("ok", { status: opts.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-watchdog-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — scan already terminal → no-op
// ---------------------------------------------------------------------------
test("no-op when scan is not in 'running' status", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScan(db, { scanStatus: "completed" });

  const { fetchImpl, calls } = makeFetchMock({ status: 200 });
  const handler = createWatchdogHandler({
    db,
    fetchImpl,
    signingKey: TEST_SIGNING_KEY,
    now: () => SEED_TS + THIRTY_ONE_MIN_MS,
  });

  await handler(
    { type: "watchdog_scan", scan_id: FIXED_SCAN_ID },
    { jobId: "j", attempts: 1 },
  );

  expect(calls).toHaveLength(0);
  const watchdogRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(watchdogRows).toHaveLength(0);
  const auditRows = db.select().from(auditLog).all();
  expect(auditRows).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 2 — scan running but stuck_for < threshold → no-op + reschedule
// ---------------------------------------------------------------------------
test("scan running <30min: no probe, reschedule watchdog +5min", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  // started_at 15min ago, well under the 30min threshold.
  seedScan(db, { startedAt: SEED_TS });

  const { fetchImpl, calls } = makeFetchMock({ status: 200 });
  const callTime = SEED_TS + 15 * 60 * 1_000;
  const handler = createWatchdogHandler({
    db,
    fetchImpl,
    signingKey: TEST_SIGNING_KEY,
    now: () => callTime,
  });

  await handler(
    { type: "watchdog_scan", scan_id: FIXED_SCAN_ID, consecutive_failures: 0 },
    { jobId: "j", attempts: 1 },
  );

  // No probe issued.
  expect(calls).toHaveLength(0);
  // Watchdog re-enqueued exactly once, +5min.
  const watchdogRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(watchdogRows).toHaveLength(1);
  expect(watchdogRows[0]!.scheduledAt).toBe(callTime + FIVE_MIN_MS);
  const parsed = JSON.parse(watchdogRows[0]!.payloadJson) as WatchdogJob;
  expect(parsed.type).toBe("watchdog_scan");
  expect(parsed.scan_id).toBe(FIXED_SCAN_ID);
  expect(parsed.consecutive_failures ?? 0).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 3 — stuck 31min + alive agent → reschedule, no state change, audit ok
// ---------------------------------------------------------------------------
test("stuck 31min + alive agent (200): no state change, reschedule, audit success", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScan(db);

  const { fetchImpl, calls } = makeFetchMock({ status: 200 });
  const callTime = SEED_TS + THIRTY_ONE_MIN_MS;
  const handler = createWatchdogHandler({
    db,
    fetchImpl,
    signingKey: TEST_SIGNING_KEY,
    now: () => callTime,
  });

  await handler(
    { type: "watchdog_scan", scan_id: FIXED_SCAN_ID, consecutive_failures: 2 },
    { jobId: "j", attempts: 1 },
  );

  // Probed the VPS at https://<ipv4>/status.
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(`https://${FIXED_VPS_IPV4}/status`);

  // Scan untouched.
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, FIXED_SCAN_ID))
    .get();
  expect(scanRow!.status).toBe("running");
  expect(scanRow!.failureReason).toBeNull();
  expect(scanRow!.completedAt).toBeNull();

  // Watchdog rescheduled with counter reset to 0.
  const watchdogRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(watchdogRows).toHaveLength(1);
  expect(watchdogRows[0]!.scheduledAt).toBe(callTime + FIVE_MIN_MS);
  const parsed = JSON.parse(watchdogRows[0]!.payloadJson) as WatchdogJob;
  expect(parsed.consecutive_failures ?? 0).toBe(0);

  // No teardown.
  const teardownRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "teardown_vps"))
    .all();
  expect(teardownRows).toHaveLength(0);

  // Audit: one watchdog_action with outcome=success.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "watchdog_action"))
    .all();
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0]!.outcome).toBe("success");
  expect(auditRows[0]!.scanId).toBe(FIXED_SCAN_ID);
  const meta = JSON.parse(auditRows[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.outcome).toBe("probe_ok");
  expect(meta.terminal).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 4 — single failure → reschedule with counter=1, no state change
// ---------------------------------------------------------------------------
test("first probe failure (counter 0→1): reschedule, scan stays running", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScan(db);

  const { fetchImpl } = makeFetchMock({ status: 500 });
  const callTime = SEED_TS + THIRTY_ONE_MIN_MS;
  const handler = createWatchdogHandler({
    db,
    fetchImpl,
    signingKey: TEST_SIGNING_KEY,
    now: () => callTime,
  });

  await handler(
    { type: "watchdog_scan", scan_id: FIXED_SCAN_ID, consecutive_failures: 0 },
    { jobId: "j", attempts: 1 },
  );

  // Scan untouched.
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, FIXED_SCAN_ID))
    .get();
  expect(scanRow!.status).toBe("running");

  // Watchdog rescheduled with counter=1.
  const watchdogRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(watchdogRows).toHaveLength(1);
  const parsed = JSON.parse(watchdogRows[0]!.payloadJson) as WatchdogJob;
  expect(parsed.consecutive_failures).toBe(1);

  // No teardown.
  const teardownRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "teardown_vps"))
    .all();
  expect(teardownRows).toHaveLength(0);

  // Audit watchdog_action outcome=failure, terminal=false.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "watchdog_action"))
    .all();
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0]!.outcome).toBe("failure");
  const meta = JSON.parse(auditRows[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.outcome).toBe("probe_failure");
  expect(meta.terminal).toBe(false);
  expect(meta.consecutive_failures).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 5 — 3rd consecutive failure → kill switch fires
// ---------------------------------------------------------------------------
test("third failure (counter 2→3): scan failed, teardown enqueued, terminal audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScan(db);

  const { fetchImpl } = makeFetchMock({ status: 502 });
  const callTime = SEED_TS + THIRTY_ONE_MIN_MS;
  const handler = createWatchdogHandler({
    db,
    fetchImpl,
    signingKey: TEST_SIGNING_KEY,
    now: () => callTime,
  });

  await handler(
    { type: "watchdog_scan", scan_id: FIXED_SCAN_ID, consecutive_failures: 2 },
    { jobId: "j", attempts: 1 },
  );

  // Scan marked failed.
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, FIXED_SCAN_ID))
    .get();
  expect(scanRow!.status).toBe("failed");
  expect(scanRow!.failureReason).toBe("agent_unresponsive");
  expect(scanRow!.completedAt).toBe(callTime);

  // Teardown enqueued.
  const teardownRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "teardown_vps"))
    .all();
  expect(teardownRows).toHaveLength(1);
  const teardownPayload = JSON.parse(teardownRows[0]!.payloadJson) as TeardownVpsJob;
  expect(teardownPayload.vps_instance_id).toBe(FIXED_VPS_ID);
  expect(teardownPayload.reason).toBe("agent_unresponsive");

  // No further watchdog reschedule on terminal.
  const watchdogRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(watchdogRows).toHaveLength(0);

  // Audit: terminal watchdog_action + scan_failed.
  const watchdogAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "watchdog_action"))
    .all();
  expect(watchdogAudits).toHaveLength(1);
  expect(watchdogAudits[0]!.outcome).toBe("failure");
  const wMeta = JSON.parse(watchdogAudits[0]!.metadataJson) as Record<
    string,
    unknown
  >;
  expect(wMeta.terminal).toBe(true);
  expect(wMeta.consecutive_failures).toBe(3);

  const scanAudits = db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.event, "scan_failed"), eq(auditLog.scanId, FIXED_SCAN_ID)),
    )
    .all();
  expect(scanAudits).toHaveLength(1);
  expect(scanAudits[0]!.outcome).toBe("failure");
  const sMeta = JSON.parse(scanAudits[0]!.metadataJson) as Record<string, unknown>;
  expect(sMeta.reason).toBe("agent_unresponsive");
  expect(sMeta.consecutive_failures).toBe(3);
});

// ---------------------------------------------------------------------------
// Test 6 — network error counts as failure
// ---------------------------------------------------------------------------
test("network-level fetch error counts as a probe failure", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScan(db);

  const { fetchImpl } = makeFetchMock({ throws: new Error("ECONNREFUSED") });
  const callTime = SEED_TS + THIRTY_ONE_MIN_MS;
  const handler = createWatchdogHandler({
    db,
    fetchImpl,
    signingKey: TEST_SIGNING_KEY,
    now: () => callTime,
  });

  await handler(
    { type: "watchdog_scan", scan_id: FIXED_SCAN_ID, consecutive_failures: 0 },
    { jobId: "j", attempts: 1 },
  );

  // Treated identically to a non-2xx response: counter increments,
  // scan stays running, watchdog rescheduled.
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, FIXED_SCAN_ID))
    .get();
  expect(scanRow!.status).toBe("running");

  const watchdogRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(watchdogRows).toHaveLength(1);
  const parsed = JSON.parse(watchdogRows[0]!.payloadJson) as WatchdogJob;
  expect(parsed.consecutive_failures).toBe(1);

  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "watchdog_action"))
    .all();
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0]!.outcome).toBe("failure");
  const meta = JSON.parse(auditRows[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.error_kind).toBe("network");
});

// ---------------------------------------------------------------------------
// Test 7 — audit chain remains intact across success + kill switch
// ---------------------------------------------------------------------------
test("audit chain verifies after success-then-kill sequence", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScan(db);

  // First call: alive agent.
  const ok = makeFetchMock({ status: 200 });
  let clock = SEED_TS + THIRTY_ONE_MIN_MS;
  const okHandler = createWatchdogHandler({
    db,
    fetchImpl: ok.fetchImpl,
    signingKey: TEST_SIGNING_KEY,
    now: () => clock,
  });
  await okHandler(
    { type: "watchdog_scan", scan_id: FIXED_SCAN_ID },
    { jobId: "j1", attempts: 1 },
  );

  // Second call (simulate 3rd failure outright): kill switch.
  clock += FIVE_MIN_MS;
  const bad = makeFetchMock({ throws: new Error("ETIMEDOUT") });
  const badHandler = createWatchdogHandler({
    db,
    fetchImpl: bad.fetchImpl,
    signingKey: TEST_SIGNING_KEY,
    now: () => clock,
  });
  await badHandler(
    { type: "watchdog_scan", scan_id: FIXED_SCAN_ID, consecutive_failures: 2 },
    { jobId: "j2", attempts: 1 },
  );

  const result = verifyChain(db, TEST_SIGNING_KEY);
  expect(result.ok).toBe(true);
  // success watchdog_action + failure watchdog_action + scan_failed = 3.
  expect(result.rows).toBeGreaterThanOrEqual(3);
});

// ---------------------------------------------------------------------------
// Test 8 — no vps_instance present → defensive no-op
// ---------------------------------------------------------------------------
test("no vps_instance (cleanup race): no probe, no reschedule, no audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScan(db, { includeVps: false });

  const { fetchImpl, calls } = makeFetchMock({ status: 200 });
  const handler = createWatchdogHandler({
    db,
    fetchImpl,
    signingKey: TEST_SIGNING_KEY,
    now: () => SEED_TS + THIRTY_ONE_MIN_MS,
  });

  await handler(
    { type: "watchdog_scan", scan_id: FIXED_SCAN_ID, consecutive_failures: 0 },
    { jobId: "j", attempts: 1 },
  );

  expect(calls).toHaveLength(0);
  const watchdogRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "watchdog_scan"))
    .all();
  expect(watchdogRows).toHaveLength(0);
  const auditRows = db.select().from(auditLog).all();
  expect(auditRows).toHaveLength(0);
});
