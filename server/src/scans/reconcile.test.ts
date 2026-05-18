/**
 * T050 — reconcileInFlight tests.
 *
 * Reconciliation is invoked at server boot to handle the case where the
 * backend was restarted while one or more scans were `running`. For each
 * running scan we ask the VPS provider about its server: if alive we leave
 * the scan running; if dead/stopped/destroyed/unknown we mark the scan
 * failed AND enqueue a teardown_vps job to reclaim the (possibly orphaned)
 * provider resource. If a running scan has NO vps_instance row at all
 * (provisioning crashed before the row was written) it is marked failed
 * with reason `vps_orphan_on_reconcile` and NO teardown is enqueued.
 *
 * Coverage:
 *   1. Alive VPS → no state change, no teardown, no audit.
 *   2. Dead (`destroyed`) VPS → scan failed + teardown_vps job inserted +
 *      audit emitted.
 *   3. Orphan (no vps_instance row) → scan failed (reason
 *      `vps_orphan_on_reconcile`) + audit; NO teardown job.
 *   4. `tearing_down` mid-state with provider reporting `stopped` → scan
 *      failed + teardown enqueued (so the cleanup completes).
 *   5. Terminal scans (`completed`, `failed`, `cancelled`, `queued`) are
 *      NOT touched.
 *   6. Counts in the returned `ReconcileResult` match the actions taken.
 *   7. Network error from provider.getVpsStatus is treated as `unknown`
 *      and flows through the dead-VPS branch.
 *   8. Audit chain integrity is preserved after reconcile.
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
import { and, eq, sql } from "drizzle-orm";

import { createDb, type DB } from "../db/client.ts";
import {
  auditLog,
  jobs as jobsTable,
  projects as projectsTable,
  scans as scansTable,
  targets as targetsTable,
  users as usersTable,
  vpsInstances,
} from "../db/schema.ts";
import { verifyChain } from "../audit/verify-chain.ts";
import type {
  SpawnVpsArgs,
  SpawnedVps,
  VpsProvider,
  VpsStatus,
} from "../vps/provider.ts";
import { reconcileInFlight } from "./reconcile.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const TEST_SIGNING_KEY = "test-audit-signing-key-reconcile-vps";

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

function freshDb(): DB {
  const db = createDb(":memory:");
  applyMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// Provider mock — returns scripted statuses keyed by provider_server_id.
// ---------------------------------------------------------------------------
type ProviderMock = {
  readonly provider: VpsProvider;
  readonly statusCalls: string[];
  readonly destroyCalls: string[];
};

function makeProviderMock(
  statusMap: Record<string, VpsStatus | Error>,
): ProviderMock {
  const statusCalls: string[] = [];
  const destroyCalls: string[] = [];
  const provider: VpsProvider = {
    async spawnVps(_args: SpawnVpsArgs): Promise<SpawnedVps> {
      throw new Error("spawnVps must not be called in reconcile tests");
    },
    async getVpsStatus(id: string): Promise<VpsStatus> {
      statusCalls.push(id);
      const v = statusMap[id];
      if (v instanceof Error) throw v;
      if (v === undefined) {
        throw new Error(`mock: no status configured for provider_server_id=${id}`);
      }
      return v;
    },
    async destroyVps(id: string): Promise<void> {
      destroyCalls.push(id);
    },
  };
  return { provider, statusCalls, destroyCalls };
}

// ---------------------------------------------------------------------------
// Seed helpers — build user/project/target/scan/vps in the canonical chain.
// ---------------------------------------------------------------------------
const BASE_TS = 1_700_000_000_000;

function seedBase(db: DB, suffix: string): { userId: string; projectId: string; targetId: string } {
  // ULIDs are 26 chars Crockford base32 — keep deterministic + valid.
  const userId = `01H0USR000000000000000${suffix}`.padEnd(26, "0").slice(0, 26);
  const projectId = `01H0PRJ000000000000000${suffix}`.padEnd(26, "0").slice(0, 26);
  const targetId = `01H0TGT000000000000000${suffix}`.padEnd(26, "0").slice(0, 26);
  db.insert(usersTable)
    .values({ id: userId, email: `u-${suffix}@x.test`, createdAt: BASE_TS })
    .run();
  db.insert(projectsTable)
    .values({ id: projectId, userId, name: `P-${suffix}`, createdAt: BASE_TS })
    .run();
  db.insert(targetsTable)
    .values({
      id: targetId,
      projectId,
      url: `https://example-${suffix}.test`,
      status: "verified",
      verifiedAt: BASE_TS,
      createdAt: BASE_TS,
    })
    .run();
  return { userId, projectId, targetId };
}

function seedScan(
  db: DB,
  args: {
    userId: string;
    targetId: string;
    scanId: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    startedAt?: number;
  },
): void {
  db.insert(scansTable)
    .values({
      id: args.scanId,
      userId: args.userId,
      targetId: args.targetId,
      profile: "recon",
      status: args.status,
      failureReason: null,
      startedAt: args.startedAt ?? BASE_TS,
      completedAt: null,
      usageTokens: null,
      usageUsdCents: null,
    })
    .run();
}

function seedVps(
  db: DB,
  args: {
    vpsId: string;
    scanId: string;
    providerServerId: string;
    status: "provisioning" | "alive" | "tearing_down" | "destroyed";
  },
): void {
  db.insert(vpsInstances)
    .values({
      id: args.vpsId,
      scanId: args.scanId,
      provider: "hetzner",
      providerServerId: args.providerServerId,
      ipv4: "10.0.0.1",
      status: args.status,
      signKey: "deadbeef".repeat(8),
      createdAt: BASE_TS,
      destroyedAt: null,
    })
    .run();
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-reconcile-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — Alive VPS → no state change, no teardown, no audit.
// ---------------------------------------------------------------------------
test("alive VPS keeps scan running, no teardown, no audit emitted", async () => {
  const db = freshDb();
  const { userId, targetId } = seedBase(db, "A");
  const scanId = "01H0SCNA00000000000000000A";
  const vpsId = "01H0VPSA00000000000000000A";
  seedScan(db, { userId, targetId, scanId, status: "running" });
  seedVps(db, { vpsId, scanId, providerServerId: "srv-A", status: "alive" });

  const mock = makeProviderMock({ "srv-A": "running" });
  const result = await reconcileInFlight(db, {
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => BASE_TS + 1_000,
  });

  expect(result.checked).toBe(1);
  expect(result.unchanged).toBe(1);
  expect(result.failed).toBe(0);
  expect(result.teardown_enqueued).toBe(0);

  // Scan row unchanged.
  const scanRow = db.select().from(scansTable).where(eq(scansTable.id, scanId)).get();
  expect(scanRow!.status).toBe("running");
  expect(scanRow!.failureReason).toBeNull();
  expect(scanRow!.completedAt).toBeNull();

  // No teardown_vps job.
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(0);

  // No audit emitted.
  const audits = db.select().from(auditLog).all();
  expect(audits).toHaveLength(0);

  // Provider asked once with provider_server_id (not vps.id).
  expect(mock.statusCalls).toEqual(["srv-A"]);
});

// ---------------------------------------------------------------------------
// Test 2 — Dead VPS (`destroyed`) → scan failed + teardown enqueued + audit.
// ---------------------------------------------------------------------------
test("destroyed VPS marks scan failed, enqueues teardown_vps, emits audit", async () => {
  const db = freshDb();
  const { userId, targetId } = seedBase(db, "B");
  const scanId = "01H0SCNB00000000000000000A";
  const vpsId = "01H0VPSB00000000000000000A";
  seedScan(db, { userId, targetId, scanId, status: "running" });
  seedVps(db, { vpsId, scanId, providerServerId: "srv-B", status: "alive" });

  const reconcileTs = BASE_TS + 5_000;
  const mock = makeProviderMock({ "srv-B": "destroyed" });
  const result = await reconcileInFlight(db, {
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => reconcileTs,
  });

  expect(result.checked).toBe(1);
  expect(result.unchanged).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.teardown_enqueued).toBe(1);

  // Scan transitioned to failed.
  const scanRow = db.select().from(scansTable).where(eq(scansTable.id, scanId)).get();
  expect(scanRow!.status).toBe("failed");
  expect(scanRow!.failureReason).toBe("vps_unreachable_on_reconcile");
  expect(scanRow!.completedAt).toBe(reconcileTs);

  // teardown_vps job inserted.
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(1);
  const payload = JSON.parse(teardownJobs[0]!.payloadJson);
  expect(payload.type).toBe("teardown_vps");
  expect(payload.vps_instance_id).toBe(vpsId);
  expect(payload.reason).toBe("reconcile_failed");
  expect(teardownJobs[0]!.status).toBe("pending");

  // scan_failed audit row emitted.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(audits).toHaveLength(1);
  const meta = JSON.parse(audits[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.reason).toBe("vps_unreachable_on_reconcile");
  expect(meta.vps_status).toBe("destroyed");
  expect(audits[0]!.scanId).toBe(scanId);
  expect(audits[0]!.vpsInstanceId).toBe(vpsId);
  expect(audits[0]!.outcome).toBe("failure");
});

// ---------------------------------------------------------------------------
// Test 3 — Orphan running scan (no vps_instance row) → failed, no teardown.
// ---------------------------------------------------------------------------
test("orphan running scan (no vps_instance row) → failed, no teardown enqueued", async () => {
  const db = freshDb();
  const { userId, targetId } = seedBase(db, "C");
  const scanId = "01H0SCNC00000000000000000A";
  seedScan(db, { userId, targetId, scanId, status: "running" });
  // Deliberately NO vps_instances row for this scan.

  const reconcileTs = BASE_TS + 5_000;
  const mock = makeProviderMock({}); // nothing should be called
  const result = await reconcileInFlight(db, {
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => reconcileTs,
  });

  expect(result.checked).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.teardown_enqueued).toBe(0);
  expect(result.unchanged).toBe(0);

  // Provider never queried.
  expect(mock.statusCalls).toHaveLength(0);

  const scanRow = db.select().from(scansTable).where(eq(scansTable.id, scanId)).get();
  expect(scanRow!.status).toBe("failed");
  expect(scanRow!.failureReason).toBe("vps_orphan_on_reconcile");
  expect(scanRow!.completedAt).toBe(reconcileTs);

  // No teardown job.
  expect(
    db.select().from(jobsTable).where(eq(jobsTable.type, "teardown_vps")).all(),
  ).toHaveLength(0);

  // scan_failed audit emitted (no vps_instance_id since none exists).
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.scanId).toBe(scanId);
  expect(audits[0]!.vpsInstanceId).toBeNull();
  expect(audits[0]!.outcome).toBe("failure");
  const meta = JSON.parse(audits[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.reason).toBe("vps_orphan_on_reconcile");
});

// ---------------------------------------------------------------------------
// Test 4 — `tearing_down` mid-state + provider reports stopped → failed + teardown.
// ---------------------------------------------------------------------------
test("tearing_down vps with stopped provider status → failed + teardown enqueued", async () => {
  const db = freshDb();
  const { userId, targetId } = seedBase(db, "D");
  const scanId = "01H0SCND00000000000000000A";
  const vpsId = "01H0VPSD00000000000000000A";
  seedScan(db, { userId, targetId, scanId, status: "running" });
  seedVps(db, {
    vpsId,
    scanId,
    providerServerId: "srv-D",
    status: "tearing_down",
  });

  const mock = makeProviderMock({ "srv-D": "stopped" });
  const result = await reconcileInFlight(db, {
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => BASE_TS + 9_000,
  });

  expect(result.failed).toBe(1);
  expect(result.teardown_enqueued).toBe(1);

  const scanRow = db.select().from(scansTable).where(eq(scansTable.id, scanId)).get();
  expect(scanRow!.status).toBe("failed");
  expect(scanRow!.failureReason).toBe("vps_unreachable_on_reconcile");

  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(1);
  const payload = JSON.parse(teardownJobs[0]!.payloadJson);
  expect(payload.vps_instance_id).toBe(vpsId);
});

// ---------------------------------------------------------------------------
// Test 5 — Terminal scans (completed/failed/cancelled/queued) are untouched.
// ---------------------------------------------------------------------------
test("non-running scans are not touched (completed, failed, cancelled, queued)", async () => {
  const db = freshDb();
  const { userId, targetId } = seedBase(db, "E");

  const completedId = "01H0SCNE10000000000000000A";
  const failedId = "01H0SCNE20000000000000000A";
  const cancelledId = "01H0SCNE30000000000000000A";
  const queuedId = "01H0SCNE40000000000000000A";
  seedScan(db, { userId, targetId, scanId: completedId, status: "completed" });
  seedScan(db, { userId, targetId, scanId: failedId, status: "failed" });
  seedScan(db, { userId, targetId, scanId: cancelledId, status: "cancelled" });
  seedScan(db, { userId, targetId, scanId: queuedId, status: "queued" });

  const mock = makeProviderMock({});
  const result = await reconcileInFlight(db, {
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => BASE_TS + 1_000,
  });

  expect(result.checked).toBe(0);
  expect(result.unchanged).toBe(0);
  expect(result.failed).toBe(0);
  expect(result.teardown_enqueued).toBe(0);

  // No provider calls.
  expect(mock.statusCalls).toHaveLength(0);

  // No audit rows.
  expect(db.select().from(auditLog).all()).toHaveLength(0);

  // Statuses preserved.
  const all = db.select().from(scansTable).all();
  const byId = new Map(all.map((s) => [s.id, s.status] as const));
  expect(byId.get(completedId)).toBe("completed");
  expect(byId.get(failedId)).toBe("failed");
  expect(byId.get(cancelledId)).toBe("cancelled");
  expect(byId.get(queuedId)).toBe("queued");
});

// ---------------------------------------------------------------------------
// Test 6 — Multiple scans batched: counts are correct.
// ---------------------------------------------------------------------------
test("multiple scans batched: counts match actions", async () => {
  const db = freshDb();
  const ts = BASE_TS + 1;

  const base = seedBase(db, "F");

  // scanA: running + alive vps
  const scanA = "01H0SCNF10000000000000000A";
  const vpsA = "01H0VPSF10000000000000000A";
  seedScan(db, { ...base, scanId: scanA, status: "running", startedAt: ts + 1 });
  seedVps(db, { vpsId: vpsA, scanId: scanA, providerServerId: "srv-Fa", status: "alive" });

  // scanB: running + destroyed vps
  const scanB = "01H0SCNF20000000000000000A";
  const vpsB = "01H0VPSF20000000000000000A";
  seedScan(db, { ...base, scanId: scanB, status: "running", startedAt: ts + 2 });
  seedVps(db, { vpsId: vpsB, scanId: scanB, providerServerId: "srv-Fb", status: "alive" });

  // scanC: running, no vps row (orphan)
  const scanC = "01H0SCNF30000000000000000A";
  seedScan(db, { ...base, scanId: scanC, status: "running", startedAt: ts + 3 });

  // scanD: running + tearing_down vps reporting stopped
  const scanD = "01H0SCNF40000000000000000A";
  const vpsD = "01H0VPSF40000000000000000A";
  seedScan(db, { ...base, scanId: scanD, status: "running", startedAt: ts + 4 });
  seedVps(db, { vpsId: vpsD, scanId: scanD, providerServerId: "srv-Fd", status: "tearing_down" });

  // scanE: completed (should NOT be checked).
  const scanE = "01H0SCNF50000000000000000A";
  seedScan(db, { ...base, scanId: scanE, status: "completed", startedAt: ts + 5 });

  const mock = makeProviderMock({
    "srv-Fa": "running",
    "srv-Fb": "destroyed",
    "srv-Fd": "stopped",
  });
  const result = await reconcileInFlight(db, {
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => BASE_TS + 10_000,
  });

  expect(result.checked).toBe(4);
  expect(result.unchanged).toBe(1); // scanA
  expect(result.failed).toBe(3); // scanB + scanC + scanD
  expect(result.teardown_enqueued).toBe(2); // scanB + scanD (not C)

  // scanE untouched.
  const scanERow = db.select().from(scansTable).where(eq(scansTable.id, scanE)).get();
  expect(scanERow!.status).toBe("completed");

  // Two teardown jobs.
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(2);
  const ids = teardownJobs
    .map((j) => JSON.parse(j.payloadJson).vps_instance_id as string)
    .sort();
  expect(ids).toEqual([vpsB, vpsD].sort());

  // Three audit rows for scan_failed.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(audits).toHaveLength(3);

  // Provider asked exactly 3 times (A, B, D — not C orphan).
  expect(mock.statusCalls.sort()).toEqual(["srv-Fa", "srv-Fb", "srv-Fd"]);
});

// ---------------------------------------------------------------------------
// Test 7 — Network error from getVpsStatus is treated as `unknown` → failed.
// ---------------------------------------------------------------------------
test("getVpsStatus network error treated as unknown → failed + teardown enqueued", async () => {
  const db = freshDb();
  const { userId, targetId } = seedBase(db, "G");
  const scanId = "01H0SCNG00000000000000000A";
  const vpsId = "01H0VPSG00000000000000000A";
  seedScan(db, { userId, targetId, scanId, status: "running" });
  seedVps(db, { vpsId, scanId, providerServerId: "srv-G", status: "alive" });

  const mock = makeProviderMock({
    "srv-G": new Error("ETIMEDOUT"),
  });
  const result = await reconcileInFlight(db, {
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => BASE_TS + 5_000,
  });

  expect(result.failed).toBe(1);
  expect(result.teardown_enqueued).toBe(1);

  const scanRow = db.select().from(scansTable).where(eq(scansTable.id, scanId)).get();
  expect(scanRow!.status).toBe("failed");
  expect(scanRow!.failureReason).toBe("vps_unreachable_on_reconcile");

  // Audit metadata records the unknown status.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(audits).toHaveLength(1);
  const meta = JSON.parse(audits[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.vps_status).toBe("unknown");
});

// ---------------------------------------------------------------------------
// Test 8 — Audit chain integrity preserved after reconcile.
// ---------------------------------------------------------------------------
test("audit chain remains valid after reconcile emits multiple rows", async () => {
  const db = freshDb();
  const base = seedBase(db, "H");

  const scanX = "01H0SCNH10000000000000000A";
  const vpsX = "01H0VPSH10000000000000000A";
  seedScan(db, { ...base, scanId: scanX, status: "running" });
  seedVps(db, { vpsId: vpsX, scanId: scanX, providerServerId: "srv-Ha", status: "alive" });

  const scanY = "01H0SCNH20000000000000000A";
  const vpsY = "01H0VPSH20000000000000000A";
  seedScan(db, { ...base, scanId: scanY, status: "running" });
  seedVps(db, { vpsId: vpsY, scanId: scanY, providerServerId: "srv-Hb", status: "alive" });

  const mock = makeProviderMock({
    "srv-Ha": "destroyed",
    "srv-Hb": "stopped",
  });
  await reconcileInFlight(db, {
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => BASE_TS + 1_000,
  });

  const verify = verifyChain(db, TEST_SIGNING_KEY);
  expect(verify.ok).toBe(true);
  expect(verify.rows).toBe(2);
});

// Silence unused-import for `and`/`sql` — reserved for future filter tests.
void and;
void sql;
