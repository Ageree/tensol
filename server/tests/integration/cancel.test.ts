/**
 * T065 — Integration tests for `cancelScan` service + `POST /api/scans/:id/cancel`.
 *
 * T041 originally landed a minimal inline cancel handler in `routes/scans.ts`.
 * T065 lifts the cancel semantics into the service layer (`scans/service.ts`)
 * with:
 *   1. Owner-scoped 404 (foreign user / unknown id).
 *   2. 409 on terminal states (`completed | failed | cancelled`).
 *   3. Atomic `withTx`: UPDATE scans.status='cancelled' + INSERT teardown_vps
 *      jobs for every live vps_instance (`provisioning | alive | tearing_down`).
 *   4. AFTER-commit `scan_cancelled` audit emission (bun:sqlite cannot nest
 *      BEGINs — same rule as `startScan`).
 *
 * Test scenarios (mirror the T065 brief):
 *   1. Cancel queued scan → 204, no teardown enqueued (vps not yet spawned).
 *   2. Cancel running scan → 204, teardown_vps job inserted, vps_instance
 *      still in `alive` state (the teardown handler will flip it later).
 *   3. Cancel completed → 409 `scan_terminal`, scan row untouched.
 *   4. Cancel cancelled (second call) → 409 idempotent rejection.
 *   5. Cancel failed → 409.
 *   6. Foreign user → 404, scan untouched.
 *   7. Audit chain integrity preserved across all flows.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  auditLog,
  jobs as jobsTable,
  projects as projectsTable,
  scans as scansTable,
  sessions as sessionsTable,
  targets as targetsTable,
  users as usersTable,
  vpsInstances as vpsInstancesTable,
} from "../../src/db/schema.ts";
import { createClock } from "../../src/lib/time.ts";
import { ulid } from "../../src/lib/ids.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { SESSION_COOKIE_NAME } from "../../src/auth/session.ts";
import { createScansRoutes } from "../../src/routes/scans.ts";
import { createRunner, type Dispatcher } from "../../src/jobs/runner.ts";
import { createSpawnVpsHandler } from "../../src/jobs/handlers/spawn-vps.ts";
import { createDispatchScanHandler } from "../../src/jobs/handlers/dispatch-scan.ts";
import { cancelScan } from "../../src/scans/service.ts";
import type {
  SpawnVpsArgs,
  SpawnedVps,
  VpsProvider,
  VpsStatus,
} from "../../src/vps/provider.ts";

// ---------------------------------------------------------------------------
// Shared helpers (small duplication from scan-lifecycle.test.ts is OK —
// each integration test file is independent so we don't share a helpers/
// module yet).
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

interface PreBakedUser {
  readonly userId: string;
  readonly sessionId: string;
  readonly cookieHeader: string;
}

function bakeUser(db: DB, args: { email: string; now: number }): PreBakedUser {
  const userId = ulid(args.now);
  db.insert(usersTable)
    .values({ id: userId, email: args.email, createdAt: args.now })
    .run();
  const sessionId = ulid(args.now + 1);
  db.insert(sessionsTable)
    .values({
      id: sessionId,
      userId,
      createdAt: args.now,
      expiresAt: args.now + 30 * 24 * 60 * 60 * 1000,
    })
    .run();
  return {
    userId,
    sessionId,
    cookieHeader: `${SESSION_COOKIE_NAME}=${sessionId}`,
  };
}

interface PreBakedTarget {
  readonly projectId: string;
  readonly targetId: string;
}

function bakeVerifiedTarget(
  db: DB,
  args: { userId: string; url: string; now: number },
): PreBakedTarget {
  const projectId = ulid(args.now + 10);
  db.insert(projectsTable)
    .values({
      id: projectId,
      userId: args.userId,
      name: "Cancel Test Project",
      createdAt: args.now,
    })
    .run();
  const targetId = ulid(args.now + 11);
  db.insert(targetsTable)
    .values({
      id: targetId,
      projectId,
      url: args.url,
      status: "verified",
      verifiedAt: args.now,
      createdAt: args.now,
    })
    .run();
  return { projectId, targetId };
}

function makeProviderMock(opts: {
  spawnResult?: SpawnedVps;
  statusSequence: VpsStatus[];
}): {
  provider: VpsProvider;
  spawnCalls: SpawnVpsArgs[];
  destroyCalls: string[];
} {
  const spawnCalls: SpawnVpsArgs[] = [];
  const destroyCalls: string[] = [];
  let cursor = 0;
  const provider: VpsProvider = {
    async spawnVps(args) {
      spawnCalls.push(args);
      return (
        opts.spawnResult ?? {
          provider_server_id: "srv-cancel",
          ipv4: "10.0.0.50",
        }
      );
    },
    async getVpsStatus(_id) {
      const next = opts.statusSequence[
        Math.min(cursor, opts.statusSequence.length - 1)
      ]!;
      cursor += 1;
      return next;
    },
    async destroyVps(id) {
      destroyCalls.push(id);
    },
  };
  return { provider, spawnCalls, destroyCalls };
}

function noopHandler(): (...args: unknown[]) => Promise<void> {
  return async () => {};
}

interface BuiltApp {
  app: Hono;
  runner: ReturnType<typeof createRunner>;
}

function buildAppWithRunner(opts: {
  db: DB;
  now: () => number;
  vpsProvider: VpsProvider;
}): BuiltApp {
  const fetchImpl = async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ) =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const spawnVpsHandler = createSpawnVpsHandler({
    db: opts.db,
    vpsProvider: opts.vpsProvider,
    signingKey: SIGNING_KEY,
    now: opts.now,
    pollIntervalMs: 1,
    pollTimeoutMs: 5_000,
  });
  const dispatchScanHandler = createDispatchScanHandler({
    db: opts.db,
    signingKey: SIGNING_KEY,
    fetchImpl: fetchImpl as typeof fetch,
    now: opts.now,
    webhookBaseUrl: "https://backend.test",
  });

  const dispatcher: Dispatcher = {
    spawn_vps: spawnVpsHandler,
    dispatch_scan: dispatchScanHandler,
    watchdog_scan: noopHandler() as Dispatcher["watchdog_scan"],
    teardown_vps: noopHandler() as Dispatcher["teardown_vps"],
  };

  const runner = createRunner({
    db: opts.db,
    dispatcher,
    pollIntervalMs: 50,
    now: opts.now,
  });

  const app = new Hono();
  app.route(
    "/api/scans",
    createScansRoutes({
      db: opts.db,
      signingKey: SIGNING_KEY,
      now: opts.now,
    }),
  );

  return { app, runner };
}

// ---------------------------------------------------------------------------
// Test 1 — queued scan can be cancelled; no teardown enqueued (no vps yet)
// ---------------------------------------------------------------------------
test("T065: cancel queued scan → 204, no teardown enqueued, scan_cancelled audit emitted", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const { targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const mock = makeProviderMock({ statusSequence: ["running"] });
  const { app } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  // 1. Start scan → status='queued'.
  const startRes = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId, profile: "recon" }),
  });
  expect(startRes.status).toBe(201);
  const { scan } = (await startRes.json()) as { scan: { id: string } };

  // Sanity — no vps_instance yet, only spawn_vps job pending.
  const vpsBefore = db
    .select()
    .from(vpsInstancesTable)
    .where(eq(vpsInstancesTable.scanId, scan.id))
    .all();
  expect(vpsBefore).toHaveLength(0);

  // 2. Cancel.
  const cancelRes = await app.request(`/api/scans/${scan.id}/cancel`, {
    method: "POST",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(cancelRes.status).toBe(204);

  // 3. scan.status='cancelled', completedAt set.
  const scanRow = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, scan.id))
    .get();
  expect(scanRow!.status).toBe("cancelled");
  expect(scanRow!.completedAt).not.toBeNull();

  // 4. NO teardown_vps job (none enqueued because no live vps_instance exists).
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(0);

  // 5. scan_cancelled audit emitted once.
  const cancelAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_cancelled"))
    .all();
  expect(cancelAudits).toHaveLength(1);
  expect(cancelAudits[0]!.scanId).toBe(scan.id);

  // 6. Audit chain integrity.
  const chain = verifyChain(db, SIGNING_KEY);
  expect(chain.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 2 — running scan: teardown_vps job inserted for the live vps_instance
// ---------------------------------------------------------------------------
test("T065: cancel running scan → 204, teardown_vps enqueued for alive vps_instance", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const { targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const mock = makeProviderMock({
    spawnResult: { provider_server_id: "srv-77", ipv4: "10.0.0.77" },
    statusSequence: ["running"],
  });
  const { app, runner } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  const startRes = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId, profile: "standard" }),
  });
  const { scan } = (await startRes.json()) as { scan: { id: string } };

  // tick → spawn_vps runs → vps_instance.status='alive', scan.status='running'.
  await runner.tick();
  const vpsRow = db
    .select()
    .from(vpsInstancesTable)
    .where(eq(vpsInstancesTable.scanId, scan.id))
    .get();
  expect(vpsRow).not.toBeUndefined();
  expect(vpsRow!.status).toBe("alive");
  const scanRunning = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, scan.id))
    .get();
  expect(scanRunning!.status).toBe("running");

  // Cancel running scan.
  const cancelRes = await app.request(`/api/scans/${scan.id}/cancel`, {
    method: "POST",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(cancelRes.status).toBe(204);

  const scanRow = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, scan.id))
    .get();
  expect(scanRow!.status).toBe("cancelled");

  // teardown_vps job inserted, payload references the vps_instance.
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(1);
  const payload = JSON.parse(teardownJobs[0]!.payloadJson) as {
    type: string;
    vps_instance_id: string;
    reason: string;
  };
  expect(payload.type).toBe("teardown_vps");
  expect(payload.vps_instance_id).toBe(vpsRow!.id);
  expect(payload.reason).toBe("cancelled");
  expect(teardownJobs[0]!.status).toBe("pending");

  // scan_cancelled audit emitted.
  const cancelAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_cancelled"))
    .all();
  expect(cancelAudits).toHaveLength(1);

  const chain = verifyChain(db, SIGNING_KEY);
  expect(chain.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3 — cancel on completed scan → 409 scan_terminal, row untouched
// ---------------------------------------------------------------------------
test("T065: cancel completed scan → 409 scan_terminal, scan untouched", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const { targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const mock = makeProviderMock({ statusSequence: ["running"] });
  const { app } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  const startRes = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId, profile: "recon" }),
  });
  const { scan } = (await startRes.json()) as { scan: { id: string } };

  // Force terminal status.
  const completedTs = clock.now();
  db.update(scansTable)
    .set({ status: "completed", completedAt: completedTs })
    .where(eq(scansTable.id, scan.id))
    .run();

  const cancelRes = await app.request(`/api/scans/${scan.id}/cancel`, {
    method: "POST",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(cancelRes.status).toBe(409);
  const body = (await cancelRes.json()) as { error: string };
  expect(body.error).toBe("scan_terminal");

  // Scan row preserved exactly as left.
  const scanAfter = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, scan.id))
    .get();
  expect(scanAfter!.status).toBe("completed");
  expect(scanAfter!.completedAt).toBe(completedTs);

  // No scan_cancelled audit on rejection.
  const cancelAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_cancelled"))
    .all();
  expect(cancelAudits).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 4 — second cancel call after a successful cancel → 409 idempotent reject
// ---------------------------------------------------------------------------
test("T065: cancel already-cancelled scan → 409 scan_terminal (idempotent reject)", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const { targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const mock = makeProviderMock({ statusSequence: ["running"] });
  const { app } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  const startRes = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId, profile: "recon" }),
  });
  const { scan } = (await startRes.json()) as { scan: { id: string } };

  // First cancel → 204.
  const first = await app.request(`/api/scans/${scan.id}/cancel`, {
    method: "POST",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(first.status).toBe(204);

  // Second cancel → 409.
  const second = await app.request(`/api/scans/${scan.id}/cancel`, {
    method: "POST",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(second.status).toBe(409);
  const body = (await second.json()) as { error: string };
  expect(body.error).toBe("scan_terminal");

  // Exactly one scan_cancelled audit total (not two).
  const cancelAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_cancelled"))
    .all();
  expect(cancelAudits).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Test 5 — cancel failed scan → 409
// ---------------------------------------------------------------------------
test("T065: cancel failed scan → 409 scan_terminal", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const { targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const mock = makeProviderMock({ statusSequence: ["running"] });
  const { app } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  const startRes = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId, profile: "recon" }),
  });
  const { scan } = (await startRes.json()) as { scan: { id: string } };

  db.update(scansTable)
    .set({
      status: "failed",
      failureReason: "vps_unhealthy",
      completedAt: clock.now(),
    })
    .where(eq(scansTable.id, scan.id))
    .run();

  const cancelRes = await app.request(`/api/scans/${scan.id}/cancel`, {
    method: "POST",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(cancelRes.status).toBe(409);
});

// ---------------------------------------------------------------------------
// Test 6 — foreign user → 404, scan untouched
// ---------------------------------------------------------------------------
test("T065: foreign user cancel attempt → 404 (hide existence), scan untouched", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const bob = bakeUser(db, { email: "bob@example.com", now: clock.now() });
  const { targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://alice.test",
    now: clock.now(),
  });
  const mock = makeProviderMock({ statusSequence: ["running"] });
  const { app } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  const startRes = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId, profile: "recon" }),
  });
  const { scan } = (await startRes.json()) as { scan: { id: string } };

  // Bob tries to cancel Alice's scan.
  const res = await app.request(`/api/scans/${scan.id}/cancel`, {
    method: "POST",
    headers: { Cookie: bob.cookieHeader },
  });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not_found");

  // Scan untouched.
  const scanAfter = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, scan.id))
    .get();
  expect(scanAfter!.status).toBe("queued");

  // No scan_cancelled audit.
  const cancelAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_cancelled"))
    .all();
  expect(cancelAudits).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 7 — direct cancelScan() service call surface (404 for unknown id)
// ---------------------------------------------------------------------------
test("T065: cancelScan() service — unknown scanId → {ok:false, code:404}", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });

  const result = await cancelScan(
    db,
    { userId: alice.userId, scanId: ulid(clock.now()) },
    { signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(404);
    expect(result.reason).toBe("not_found");
  }
});

// ---------------------------------------------------------------------------
// Test 8 — direct cancelScan() service call surface (happy path payload)
// ---------------------------------------------------------------------------
test("T065: cancelScan() service — happy path returns {cancelled:true, teardown_enqueued:false} for queued scan", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const { targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const mock = makeProviderMock({ statusSequence: ["running"] });
  const { app } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  const startRes = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId, profile: "recon" }),
  });
  const { scan } = (await startRes.json()) as { scan: { id: string } };

  const result = await cancelScan(
    db,
    { userId: alice.userId, scanId: scan.id },
    { signingKey: SIGNING_KEY, now: clock.now },
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.cancelled).toBe(true);
    expect(result.value.teardown_enqueued).toBe(false);
  }
});
