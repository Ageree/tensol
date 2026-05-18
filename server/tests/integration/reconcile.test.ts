/**
 * T051 — Integration test: boot-time reconcile is wired into the server.
 *
 * Goal
 *   When the backend boots, every scan still in `status='running'` must be
 *   reconciled against the VPS provider BEFORE the HTTP listener accepts
 *   traffic. The test simulates a server restart by:
 *     1. Seeding an in-memory SQLite with scans in `status='running'`,
 *        each with an associated `vps_instances` row.
 *     2. Calling the exported `bootstrap(...)` factory directly (no real
 *        Bun.serve — we don't want a listening socket in the test).
 *     3. Asserting that the resulting ReconcileResult counts match what
 *        the mock VpsProvider returns, that DB transitions match
 *        (dead-VPS scans → failed, teardown_vps job enqueued), and that
 *        the audit chain stayed consistent.
 *
 * Test surface (what we pin down)
 *   1. Running scans + dead VPS → bootstrap returns
 *      {checked, unchanged, failed, teardown_enqueued} matching the seed.
 *   2. Empty DB (no running scans) → bootstrap returns checked=0 and no
 *      audit row gets emitted by the reconciler.
 *   3. 60s gate (constitution / spec): bootstrap completes well under
 *      60s even with N=10 mocked scans. We assert <5_000ms (instant under
 *      the mock provider — the assertion exists to flag a regression
 *      where someone accidentally awaits a real network call here).
 *   4. bootstrap is awaitable + idempotent — calling it twice on the
 *      same DB after seed reconcile flips the scans on the first call,
 *      and the second call sees checked=0 (everything already terminal).
 *
 * Why we don't spawn `Bun.serve` here
 *   Booting a real listener would make this test environment-coupled
 *   (PORT conflicts, async cleanup of the server handle, etc.). The
 *   contract under test is:
 *     "the reconcile call sits between db-open and listener-start in
 *      the boot sequence, and it returns its result deterministically"
 *   — that's verifiable by calling `bootstrap()` and asserting on its
 *   return value + DB side-effects.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  auditLog,
  jobs as jobsTable,
  projects as projectsTable,
  scans as scansTable,
  targets as targetsTable,
  users as usersTable,
  vpsInstances as vpsInstancesTable,
} from "../../src/db/schema.ts";
import { ulid } from "../../src/lib/ids.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { bootstrap } from "../../src/server.ts";
import type {
  SpawnVpsArgs,
  SpawnedVps,
  VpsProvider,
  VpsStatus,
} from "../../src/vps/provider.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY =
  "test-key-64-chars-hex-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

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

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  return db;
}

interface SeedScanArgs {
  readonly db: DB;
  readonly now: number;
  /** Provider server ID returned by the mock — used to compute status. */
  readonly providerServerId: string;
  /** User email base — must be unique per call. */
  readonly emailLocal: string;
}

interface SeededScan {
  readonly userId: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly scanId: string;
  readonly vpsInstanceId: string;
  readonly providerServerId: string;
}

/** Bake a running scan + its vps_instance row directly via Drizzle. We
 *  bypass the magic-link / startScan ceremony — already covered by
 *  T026/T034/T041 — so the test focuses solely on the reconcile path. */
function seedRunningScan(args: SeedScanArgs): SeededScan {
  const { db, now, providerServerId, emailLocal } = args;
  const userId = ulid(now);
  db.insert(usersTable)
    .values({
      id: userId,
      email: `${emailLocal}@tensol.test`,
      createdAt: now,
    })
    .run();
  const projectId = ulid(now + 1);
  db.insert(projectsTable)
    .values({
      id: projectId,
      userId,
      name: "Reconcile Test Project",
      createdAt: now,
    })
    .run();
  const targetId = ulid(now + 2);
  db.insert(targetsTable)
    .values({
      id: targetId,
      projectId,
      url: `https://${emailLocal}.tensol.test`,
      status: "verified",
      verifiedAt: now,
      createdAt: now,
    })
    .run();
  const scanId = ulid(now + 3);
  db.insert(scansTable)
    .values({
      id: scanId,
      userId,
      targetId,
      profile: "recon",
      status: "running",
      startedAt: now,
    })
    .run();
  const vpsInstanceId = ulid(now + 4);
  db.insert(vpsInstancesTable)
    .values({
      id: vpsInstanceId,
      scanId,
      provider: "hetzner",
      providerServerId,
      ipv4: "10.0.0.1",
      status: "alive",
      signKey: "deadbeef".repeat(8),
      createdAt: now,
    })
    .run();
  return { userId, projectId, targetId, scanId, vpsInstanceId, providerServerId };
}

/** A `VpsProvider` whose `getVpsStatus` reads from a map keyed by
 *  provider_server_id. Anything missing from the map returns 'unknown'. */
function makeProviderMock(statusMap: Record<string, VpsStatus>): {
  provider: VpsProvider;
  spawnCalls: SpawnVpsArgs[];
  statusCalls: string[];
  destroyCalls: string[];
} {
  const spawnCalls: SpawnVpsArgs[] = [];
  const statusCalls: string[] = [];
  const destroyCalls: string[] = [];
  const provider: VpsProvider = {
    async spawnVps(args): Promise<SpawnedVps> {
      spawnCalls.push(args);
      return { provider_server_id: "srv-mock", ipv4: "10.0.0.1" };
    },
    async getVpsStatus(id): Promise<VpsStatus> {
      statusCalls.push(id);
      return statusMap[id] ?? "unknown";
    },
    async destroyVps(id): Promise<void> {
      destroyCalls.push(id);
    },
  };
  return { provider, spawnCalls, statusCalls, destroyCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("T051: bootstrap reconciles running scans against the VPS provider", async () => {
  const db = freshMemDb();
  const baseTs = 1_700_000_000_000;
  const seedAlive = seedRunningScan({
    db,
    now: baseTs,
    providerServerId: "srv-alive",
    emailLocal: "alice",
  });
  const seedDead = seedRunningScan({
    db,
    now: baseTs + 1_000,
    providerServerId: "srv-dead",
    emailLocal: "bob",
  });
  const seedStopped = seedRunningScan({
    db,
    now: baseTs + 2_000,
    providerServerId: "srv-stopped",
    emailLocal: "carol",
  });

  const { provider, statusCalls } = makeProviderMock({
    "srv-alive": "running",
    "srv-dead": "destroyed",
    "srv-stopped": "stopped",
  });

  const result = await bootstrap({
    db,
    vpsProvider: provider,
    signingKey: SIGNING_KEY,
    now: () => baseTs + 10_000,
  });

  // Each running scan is polled exactly once.
  expect(statusCalls.sort()).toEqual(
    ["srv-alive", "srv-dead", "srv-stopped"].sort(),
  );
  expect(result.reconcileResult).toEqual({
    checked: 3,
    unchanged: 1,
    failed: 2,
    teardown_enqueued: 2,
  });

  // DB side-effects:
  const aliveScan = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, seedAlive.scanId))
    .get();
  expect(aliveScan?.status).toBe("running");

  const deadScan = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, seedDead.scanId))
    .get();
  expect(deadScan?.status).toBe("failed");
  expect(deadScan?.failureReason).toBe("vps_unreachable_on_reconcile");

  const stoppedScan = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, seedStopped.scanId))
    .get();
  expect(stoppedScan?.status).toBe("failed");

  // Two teardown_vps jobs were enqueued (one per dead scan).
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs.length).toBe(2);
  for (const job of teardownJobs) {
    expect(job.status).toBe("pending");
  }

  // Audit chain still verifies + two scan_failed rows landed.
  const auditOk = verifyChain(db, SIGNING_KEY);
  expect(auditOk.ok).toBe(true);
  const failedAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(failedAudits.length).toBe(2);
});

test("T051: bootstrap on an empty DB is a fast no-op", async () => {
  const db = freshMemDb();
  const { provider, statusCalls } = makeProviderMock({});

  const start = performance.now();
  const result = await bootstrap({
    db,
    vpsProvider: provider,
    signingKey: SIGNING_KEY,
  });
  const elapsedMs = performance.now() - start;

  expect(result.reconcileResult).toEqual({
    checked: 0,
    unchanged: 0,
    failed: 0,
    teardown_enqueued: 0,
  });
  expect(statusCalls.length).toBe(0);
  // 60s budget per spec; mock provider should be ~instant. Pick a tight
  // bound that catches an accidental real network call.
  expect(elapsedMs).toBeLessThan(5_000);

  // No audit rows from reconcile.
  const audits = db.select().from(auditLog).all();
  expect(audits.length).toBe(0);
});

test("T051: bootstrap completes within 60s for N=10 mocked scans", async () => {
  const db = freshMemDb();
  const baseTs = 1_700_000_000_000;
  const statusMap: Record<string, VpsStatus> = {};
  for (let i = 0; i < 10; i += 1) {
    const providerServerId = `srv-${i}`;
    seedRunningScan({
      db,
      now: baseTs + i * 1_000,
      providerServerId,
      emailLocal: `user${i}`,
    });
    // Alternate alive vs dead so we exercise both reconcile branches.
    statusMap[providerServerId] = i % 2 === 0 ? "running" : "destroyed";
  }
  const { provider } = makeProviderMock(statusMap);

  const start = performance.now();
  const result = await bootstrap({
    db,
    vpsProvider: provider,
    signingKey: SIGNING_KEY,
    now: () => baseTs + 100_000,
  });
  const elapsedMs = performance.now() - start;

  expect(result.reconcileResult.checked).toBe(10);
  expect(result.reconcileResult.unchanged).toBe(5);
  expect(result.reconcileResult.failed).toBe(5);
  expect(result.reconcileResult.teardown_enqueued).toBe(5);
  // Constitution / spec budget is 60s; assert we're well under.
  expect(elapsedMs).toBeLessThan(60_000);
});

test("T051: bootstrap is idempotent — a second call sees nothing to reconcile", async () => {
  const db = freshMemDb();
  const baseTs = 1_700_000_000_000;
  seedRunningScan({
    db,
    now: baseTs,
    providerServerId: "srv-dead",
    emailLocal: "alice",
  });
  const { provider } = makeProviderMock({ "srv-dead": "destroyed" });

  const first = await bootstrap({
    db,
    vpsProvider: provider,
    signingKey: SIGNING_KEY,
    now: () => baseTs + 1_000,
  });
  expect(first.reconcileResult.checked).toBe(1);
  expect(first.reconcileResult.failed).toBe(1);

  const second = await bootstrap({
    db,
    vpsProvider: provider,
    signingKey: SIGNING_KEY,
    now: () => baseTs + 2_000,
  });
  expect(second.reconcileResult).toEqual({
    checked: 0,
    unchanged: 0,
    failed: 0,
    teardown_enqueued: 0,
  });
});
