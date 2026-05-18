/**
 * T041 — Integration tests for `/api/scans/*` routes (full lifecycle).
 *
 * The scan lifecycle stitches together five subsystems landed in earlier
 * tasks:
 *   - scans service (T039) — startScan / getScan / listScans
 *   - jobs runner (T036) + handlers (T040) — spawn_vps, dispatch_scan
 *   - VPS provider abstraction (T037) — fully mocked here
 *   - signed audit log (T014/T015) — verifyChain after every flow
 *   - auth middleware (T023) — owner-scoped CRUD
 *
 * Test strategy:
 *   1. Spin up a `:memory:` SQLite per test (migrations applied).
 *   2. Bake user + project + verified target directly via Drizzle (skip
 *      magic-link / verify ceremony — T026 + T034 already cover those).
 *   3. Build the Hono app with `createScansRoutes`; mount a runner whose
 *      handlers receive mocked `VpsProvider` + `fetchImpl` so we never
 *      hit real Hetzner / network.
 *   4. Drive scenarios with `runner.tick()` (deterministic, no poll loop).
 *
 * Webhook callback note (T044 not yet shipped):
 *   The "real" terminal transition (running → completed + findings insert)
 *   is the scan-progress webhook. Until T044 ships we simulate the webhook
 *   side-effect inline — UPDATE scans.status='completed' + emit a
 *   scan_completed audit. This is sufficient to validate the timeline view
 *   without prematurely coupling this test to T044's body shape.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";

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
  findings as findingsTable,
} from "../../src/db/schema.ts";
import { createClock } from "../../src/lib/time.ts";
import { ulid } from "../../src/lib/ids.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { emitSignedAudit } from "../../src/audit/emit.ts";
import { SESSION_COOKIE_NAME } from "../../src/auth/session.ts";
import { createScansRoutes } from "../../src/routes/scans.ts";
import { createRunner, type Dispatcher } from "../../src/jobs/runner.ts";
import { createSpawnVpsHandler } from "../../src/jobs/handlers/spawn-vps.ts";
import { createDispatchScanHandler } from "../../src/jobs/handlers/dispatch-scan.ts";
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
      name: "Test Project",
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

/** Build a `VpsProvider` that returns canned answers — no Hetzner calls. */
function makeProviderMock(opts: {
  spawnResult?: SpawnedVps;
  statusSequence: VpsStatus[];
}): {
  provider: VpsProvider;
  spawnCalls: SpawnVpsArgs[];
  statusCalls: string[];
  destroyCalls: string[];
} {
  const spawnCalls: SpawnVpsArgs[] = [];
  const statusCalls: string[] = [];
  const destroyCalls: string[] = [];
  let cursor = 0;
  const provider: VpsProvider = {
    async spawnVps(args) {
      spawnCalls.push(args);
      return (
        opts.spawnResult ?? {
          provider_server_id: "srv-test",
          ipv4: "10.0.0.1",
        }
      );
    },
    async getVpsStatus(id) {
      statusCalls.push(id);
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
  return { provider, spawnCalls, statusCalls, destroyCalls };
}

/** A no-op handler used as the default for job types we don't exercise. */
function noopHandler(): (...args: unknown[]) => Promise<void> {
  return async () => {};
}

interface BuiltApp {
  app: Hono;
  runner: ReturnType<typeof createRunner>;
  fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
}

function buildAppWithRunner(opts: {
  db: DB;
  now: () => number;
  vpsProvider: VpsProvider;
  fetchImpl?: typeof fetch;
}): BuiltApp {
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl =
    opts.fetchImpl ??
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

  return { app, runner, fetchCalls };
}

/** Simulate the T044 webhook side-effect — transition scan to completed,
 *  insert a finding row, emit scan_completed audit. */
async function simulateWebhookCompletion(
  db: DB,
  args: {
    scanId: string;
    targetId: string;
    projectId: string;
    userId: string;
    now: number;
  },
): Promise<void> {
  db.update(scansTable)
    .set({ status: "completed", completedAt: args.now })
    .where(eq(scansTable.id, args.scanId))
    .run();
  const findingId = ulid(args.now);
  db.insert(findingsTable)
    .values({
      id: findingId,
      scanId: args.scanId,
      severity: "medium",
      title: "Reflected XSS in search",
      bodyMd: "Sanitisation missing on `q` parameter.",
      evidenceJson: null,
      createdAt: args.now,
      dedupKey: `${args.scanId}:xss`,
    })
    .run();
  await emitSignedAudit(
    db,
    {
      event: "scan_completed",
      outcome: "success",
      ts: args.now,
      user_id: args.userId,
      project_id: args.projectId,
      target_id: args.targetId,
      scan_id: args.scanId,
      metadata: { findings: 1 },
    },
    { key: SIGNING_KEY },
  );
}

// ---------------------------------------------------------------------------
// Test 1 — full lifecycle: start → spawn → dispatch → webhook → completed
// ---------------------------------------------------------------------------
test("T041: full scan lifecycle — start → running → callback → completed → audit timeline", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const { projectId, targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });

  const mock = makeProviderMock({
    spawnResult: { provider_server_id: "srv-42", ipv4: "10.0.0.42" },
    statusSequence: ["initializing", "running"],
  });
  const { app, runner, fetchCalls } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  // 1. POST /api/scans → 201, scan queued, spawn_vps job pending.
  const startRes = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId, profile: "recon" }),
  });
  expect(startRes.status).toBe(201);
  const startBody = (await startRes.json()) as {
    scan: { id: string; status: string; profile: string };
  };
  expect(startBody.scan.status).toBe("queued");
  expect(startBody.scan.profile).toBe("recon");
  const scanId = startBody.scan.id;

  // spawn_vps job should be pending.
  const pendingJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "spawn_vps"))
    .all();
  expect(pendingJobs).toHaveLength(1);
  expect(pendingJobs[0]!.status).toBe("pending");

  // 2. tick() → spawn_vps handler runs. VPS provisioned, scan → running,
  //    dispatch_scan job inserted.
  const claimedSpawn = await runner.tick();
  expect(claimedSpawn).not.toBeNull();
  expect(claimedSpawn!.type).toBe("spawn_vps");
  expect(mock.spawnCalls).toHaveLength(1);

  const vpsRow = db
    .select()
    .from(vpsInstancesTable)
    .where(eq(vpsInstancesTable.scanId, scanId))
    .get();
  expect(vpsRow).not.toBeUndefined();
  expect(vpsRow!.status).toBe("alive");
  expect(vpsRow!.ipv4).toBe("10.0.0.42");

  const scanAfterSpawn = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, scanId))
    .get();
  expect(scanAfterSpawn!.status).toBe("running");

  const dispatchJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "dispatch_scan"))
    .all();
  expect(dispatchJobs).toHaveLength(1);

  // 3. tick() → dispatch_scan handler runs. fetch POST issued, audit emitted.
  const claimedDispatch = await runner.tick();
  expect(claimedDispatch).not.toBeNull();
  expect(claimedDispatch!.type).toBe("dispatch_scan");
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]!.url).toBe("https://10.0.0.42/scan");

  // 4. GET /api/scans/:id → status='running'.
  const getRunning = await app.request(`/api/scans/${scanId}`, {
    headers: { Cookie: alice.cookieHeader },
  });
  expect(getRunning.status).toBe(200);
  const getRunningBody = (await getRunning.json()) as {
    scan: { id: string; status: string };
  };
  expect(getRunningBody.scan.status).toBe("running");

  // 5. Simulate T044 webhook callback → scan completed + finding inserted.
  await simulateWebhookCompletion(db, {
    scanId,
    targetId,
    projectId,
    userId: alice.userId,
    now: clock.now(),
  });

  const getCompleted = await app.request(`/api/scans/${scanId}`, {
    headers: { Cookie: alice.cookieHeader },
  });
  expect(getCompleted.status).toBe(200);
  const getCompletedBody = (await getCompleted.json()) as {
    scan: { id: string; status: string };
  };
  expect(getCompletedBody.scan.status).toBe("completed");

  // 6. GET /api/scans/:id/audit → timeline contains all events.
  const auditRes = await app.request(`/api/scans/${scanId}/audit`, {
    headers: { Cookie: alice.cookieHeader },
  });
  expect(auditRes.status).toBe(200);
  const auditBody = (await auditRes.json()) as {
    events: Array<{ event: string; outcome: string }>;
  };
  const eventNames = auditBody.events.map((e) => e.event);
  expect(eventNames).toContain("scan_started");
  expect(eventNames).toContain("vps_provisioned");
  expect(eventNames).toContain("decepticon_invoked");
  expect(eventNames).toContain("scan_completed");
  // Timeline ordered chronologically.
  const startedIdx = eventNames.indexOf("scan_started");
  const provisionedIdx = eventNames.indexOf("vps_provisioned");
  const invokedIdx = eventNames.indexOf("decepticon_invoked");
  const completedIdx = eventNames.indexOf("scan_completed");
  expect(startedIdx).toBeLessThan(provisionedIdx);
  expect(provisionedIdx).toBeLessThan(invokedIdx);
  expect(invokedIdx).toBeLessThan(completedIdx);

  // 7. Audit chain is intact.
  const chain = verifyChain(db, SIGNING_KEY);
  expect(chain.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 2 — GET /api/scans — list scoped to caller
// ---------------------------------------------------------------------------
test("T041: GET /api/scans returns only caller's scans", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const bob = bakeUser(db, { email: "bob@example.com", now: clock.now() });
  const aliceTarget = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://alice.test",
    now: clock.now(),
  });
  const mock = makeProviderMock({
    statusSequence: ["running"],
  });
  const { app } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  // Alice starts two scans.
  for (let i = 0; i < 2; i++) {
    const res = await app.request("/api/scans", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({
        target_id: aliceTarget.targetId,
        profile: "recon",
      }),
    });
    expect(res.status).toBe(201);
  }

  // Alice sees 2.
  const aliceList = await app.request("/api/scans", {
    headers: { Cookie: alice.cookieHeader },
  });
  expect(aliceList.status).toBe(200);
  const aliceBody = (await aliceList.json()) as {
    scans: Array<{ id: string }>;
  };
  expect(aliceBody.scans).toHaveLength(2);

  // Bob sees 0.
  const bobList = await app.request("/api/scans", {
    headers: { Cookie: bob.cookieHeader },
  });
  expect(bobList.status).toBe(200);
  const bobBody = (await bobList.json()) as { scans: ReadonlyArray<unknown> };
  expect(bobBody.scans).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 3 — GET /api/scans/:id ownership — foreign user → 404
// ---------------------------------------------------------------------------
test("T041: GET /api/scans/:id by foreign user → 404 (hide existence)", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const bob = bakeUser(db, { email: "bob@example.com", now: clock.now() });
  const aliceTarget = bakeVerifiedTarget(db, {
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
    body: JSON.stringify({
      target_id: aliceTarget.targetId,
      profile: "recon",
    }),
  });
  const { scan } = (await startRes.json()) as { scan: { id: string } };

  // Bob attempts to read Alice's scan.
  const res = await app.request(`/api/scans/${scan.id}`, {
    headers: { Cookie: bob.cookieHeader },
  });
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// Test 4 — POST /api/scans/:id/cancel — happy path
// ---------------------------------------------------------------------------
test("T041: POST /api/scans/:id/cancel — queued → cancelled + teardown enqueued", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const { targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });

  const mock = makeProviderMock({
    spawnResult: { provider_server_id: "srv-99", ipv4: "10.0.0.99" },
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
    body: JSON.stringify({ target_id: targetId, profile: "recon" }),
  });
  const { scan } = (await startRes.json()) as { scan: { id: string } };

  // tick once so a vps_instance exists → cancel should enqueue teardown_vps.
  await runner.tick();

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

  const teardownRows = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownRows).toHaveLength(1);
  const payload = JSON.parse(teardownRows[0]!.payloadJson) as {
    type: string;
    vps_instance_id: string;
    reason: string;
  };
  expect(payload.type).toBe("teardown_vps");
  expect(payload.reason).toBe("cancelled");

  // scan_cancelled audit emitted.
  const cancelAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_cancelled"))
    .all();
  expect(cancelAudits).toHaveLength(1);

  // Chain still verifies.
  const chain = verifyChain(db, SIGNING_KEY);
  expect(chain.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 5 — Cancel on a terminal scan → 409
// ---------------------------------------------------------------------------
test("T041: POST /api/scans/:id/cancel on completed scan → 409 scan_terminal", async () => {
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

  // Forcibly move to completed.
  db.update(scansTable)
    .set({ status: "completed", completedAt: clock.now() })
    .where(eq(scansTable.id, scan.id))
    .run();

  const cancelRes = await app.request(`/api/scans/${scan.id}/cancel`, {
    method: "POST",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(cancelRes.status).toBe(409);
  const body = (await cancelRes.json()) as { error: string };
  expect(body.error).toBe("scan_terminal");
});

// ---------------------------------------------------------------------------
// Test 6 — Unauthenticated → 401
// ---------------------------------------------------------------------------
test("T041: GET /api/scans without cookie → 401", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const mock = makeProviderMock({ statusSequence: ["running"] });
  const { app } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });
  const res = await app.request("/api/scans");
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Test 7 — POST /api/scans with bad body → 400
// ---------------------------------------------------------------------------
test("T041: POST /api/scans with missing profile → 400", async () => {
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

  const res = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId }),
  });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// Test 8 — POST /api/scans on unverified target → 403
// ---------------------------------------------------------------------------
test("T041: POST /api/scans on unverified target → 403 auth_proof_required", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  // Inline unverified target.
  const projectId = ulid(clock.now());
  db.insert(projectsTable)
    .values({
      id: projectId,
      userId: alice.userId,
      name: "P",
      createdAt: clock.now(),
    })
    .run();
  const targetId = ulid(clock.now());
  db.insert(targetsTable)
    .values({
      id: targetId,
      projectId,
      url: "https://unverified.test",
      status: "unverified",
      verifiedAt: null,
      createdAt: clock.now(),
    })
    .run();

  const mock = makeProviderMock({ statusSequence: ["running"] });
  const { app } = buildAppWithRunner({
    db,
    now: clock.now,
    vpsProvider: mock.provider,
  });

  const res = await app.request("/api/scans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ target_id: targetId, profile: "recon" }),
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("auth_proof_required");
});

// ---------------------------------------------------------------------------
// Test 9 — Audit timeline ordering preserved across mixed reads
// ---------------------------------------------------------------------------
test("T041: GET /api/scans/:id/audit ordering matches insertion order", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const { targetId } = bakeVerifiedTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const mock = makeProviderMock({
    spawnResult: { provider_server_id: "srv-1", ipv4: "10.0.0.1" },
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
  await runner.tick();
  await runner.tick();

  // Cross-check raw audit_log ordering by id ASC matches the response.
  const rawEvents = db
    .select({ event: auditLog.event })
    .from(auditLog)
    .where(eq(auditLog.scanId, scan.id))
    .orderBy(asc(auditLog.id))
    .all();

  const res = await app.request(`/api/scans/${scan.id}/audit`, {
    headers: { Cookie: alice.cookieHeader },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    events: Array<{ event: string }>;
  };
  expect(body.events.map((e) => e.event)).toEqual(rawEvents.map((r) => r.event));
});
