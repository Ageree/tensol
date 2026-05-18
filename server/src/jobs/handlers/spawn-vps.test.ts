/**
 * T040 — spawn_vps handler tests.
 *
 * The handler is built via `createSpawnVpsHandler({ vpsProvider, signingKey,
 * now, pollIntervalMs, pollTimeoutMs })`. Provider is fully mocked (no
 * Hetzner / network), polling intervals are sub-millisecond so tests are
 * fast.
 *
 * Coverage targets (per T040 brief):
 *   1. HAPPY PATH — provider.spawnVps called with a freshly-generated
 *      signKey; getVpsStatus polled until 'running'; vps_instances row
 *      INSERTed (status='alive', signKey persisted); scan transitioned to
 *      'running'; dispatch_scan job enqueued; vps_provisioned audit row
 *      emitted; **sign_key MUST NOT leak into audit metadata**.
 *   2. SCAN NOT QUEUED — handler is a no-op (does not call provider).
 *   3. POLL TIMEOUT — getVpsStatus never returns 'running' within
 *      pollTimeoutMs → handler throws (runner will retry).
 *   4. PROVIDER spawnVps FAILS — error propagates (runner will retry).
 *   5. AUDIT CHAIN INTACT after a happy run.
 *
 * Schema notes (surprises from db/schema.ts):
 *   - vps_instances.status enum = 'provisioning'|'alive'|'tearing_down'|
 *     'destroyed'. Spec mentions "alive" → after polling reports running we
 *     set status='alive'.
 *   - vps_instances.provider is REQUIRED ('hetzner' only at this time).
 *   - scans table has NO vps_instance_id column — the relationship is via
 *     vps_instances.scan_id UNIQUE. So "transition scan to running" only
 *     touches scans.status.
 *   - signKey is 64 hex chars (32 random bytes) — stored on the row, never
 *     emitted into audit metadata.
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
import { eq } from "drizzle-orm";

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
import { createSpawnVpsHandler } from "./spawn-vps.ts";
import type {
  SpawnVpsArgs,
  SpawnedVps,
  VpsProvider,
  VpsStatus,
} from "../../vps/provider.ts";

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

const TEST_SIGNING_KEY = "test-audit-signing-key-spawn-vps";

const FIXED_USER_ID = "01H0USER00000000000000000A";
const FIXED_PROJECT_ID = "01H0PROJ00000000000000000A";
const FIXED_TARGET_ID = "01H0TGT0000000000000000000A";
const FIXED_SCAN_ID = "01H0SCAN00000000000000000A";

function seedQueuedScan(db: DB): void {
  const ts = 1_700_000_000_000;
  db.insert(users)
    .values({ id: FIXED_USER_ID, email: "u@x.test", createdAt: ts })
    .run();
  db.insert(projects)
    .values({
      id: FIXED_PROJECT_ID,
      userId: FIXED_USER_ID,
      name: "P",
      createdAt: ts,
    })
    .run();
  db.insert(targets)
    .values({
      id: FIXED_TARGET_ID,
      projectId: FIXED_PROJECT_ID,
      url: "https://example.test",
      status: "verified",
      verifiedAt: ts,
      createdAt: ts,
    })
    .run();
  db.insert(scans)
    .values({
      id: FIXED_SCAN_ID,
      userId: FIXED_USER_ID,
      targetId: FIXED_TARGET_ID,
      profile: "recon",
      status: "queued",
      startedAt: ts,
    })
    .run();
}

type ProviderMock = {
  provider: VpsProvider;
  spawnCalls: SpawnVpsArgs[];
  statusCalls: string[];
  destroyCalls: string[];
};

function makeProviderMock(opts: {
  spawnResult?: SpawnedVps;
  spawnThrows?: Error;
  statusSequence: VpsStatus[];
}): ProviderMock {
  const spawnCalls: SpawnVpsArgs[] = [];
  const statusCalls: string[] = [];
  const destroyCalls: string[] = [];
  let cursor = 0;
  const provider: VpsProvider = {
    async spawnVps(args) {
      spawnCalls.push(args);
      if (opts.spawnThrows) throw opts.spawnThrows;
      return (
        opts.spawnResult ?? {
          provider_server_id: "srv-1",
          ipv4: "1.2.3.4",
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-spawn-vps-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — HAPPY PATH
// ---------------------------------------------------------------------------
test("happy path: spawns, polls, inserts vps_instance, transitions scan, enqueues dispatch_scan, emits audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedQueuedScan(db);

  const mock = makeProviderMock({
    spawnResult: { provider_server_id: "srv-42", ipv4: "10.0.0.42" },
    statusSequence: ["initializing", "initializing", "running"],
  });

  let clock = 2_000_000_000_000;
  const handler = createSpawnVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => clock++,
    pollIntervalMs: 1,
    pollTimeoutMs: 5_000,
  });

  await handler(
    { type: "spawn_vps", scan_id: FIXED_SCAN_ID },
    { jobId: "01H0JOB00000000000000000AA", attempts: 1 },
  );

  // Provider was called.
  expect(mock.spawnCalls).toHaveLength(1);
  const spawnArg = mock.spawnCalls[0]!;
  expect(spawnArg.scanId).toBe(FIXED_SCAN_ID);
  // signKey is 64 hex chars from 32 random bytes.
  expect(spawnArg.signKey).toMatch(/^[0-9a-f]{64}$/);

  // Polled three times.
  expect(mock.statusCalls.length).toBe(3);
  expect(mock.statusCalls.every((id) => id === "srv-42")).toBe(true);

  // vps_instances row inserted.
  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.scanId, FIXED_SCAN_ID))
    .get();
  expect(vpsRow).not.toBeUndefined();
  expect(vpsRow!.provider).toBe("hetzner");
  expect(vpsRow!.providerServerId).toBe("srv-42");
  expect(vpsRow!.ipv4).toBe("10.0.0.42");
  expect(vpsRow!.status).toBe("alive");
  expect(vpsRow!.signKey).toBe(spawnArg.signKey);

  // Scan transitioned to running.
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, FIXED_SCAN_ID))
    .get();
  expect(scanRow!.status).toBe("running");

  // dispatch_scan job enqueued.
  const dispatchRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "dispatch_scan"))
    .all();
  expect(dispatchRows).toHaveLength(1);
  const payload = JSON.parse(dispatchRows[0]!.payloadJson) as {
    type: string;
    scan_id: string;
    vps_instance_id: string;
  };
  expect(payload.type).toBe("dispatch_scan");
  expect(payload.scan_id).toBe(FIXED_SCAN_ID);
  expect(payload.vps_instance_id).toBe(vpsRow!.id);
  expect(dispatchRows[0]!.status).toBe("pending");

  // Audit row emitted.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vps_provisioned"))
    .all();
  expect(auditRows).toHaveLength(1);
  const a = auditRows[0]!;
  expect(a.outcome).toBe("success");
  expect(a.scanId).toBe(FIXED_SCAN_ID);
  expect(a.vpsInstanceId).toBe(vpsRow!.id);
  const meta = JSON.parse(a.metadataJson) as Record<string, unknown>;
  expect(meta.provider_server_id).toBe("srv-42");
  expect(meta.ipv4).toBe("10.0.0.42");
  // SECURITY: sign_key MUST NOT leak.
  const metaStr = JSON.stringify(meta);
  expect(metaStr.includes(spawnArg.signKey)).toBe(false);
  expect("sign_key" in meta).toBe(false);
  expect("signKey" in meta).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 2 — Scan not 'queued' → no-op
// ---------------------------------------------------------------------------
test("no-op when scan is not in 'queued' status", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedQueuedScan(db);
  // Mutate to cancelled.
  db.update(scans)
    .set({ status: "cancelled" })
    .where(eq(scans.id, FIXED_SCAN_ID))
    .run();

  const mock = makeProviderMock({ statusSequence: ["running"] });
  const handler = createSpawnVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
  });

  await handler(
    { type: "spawn_vps", scan_id: FIXED_SCAN_ID },
    { jobId: "j", attempts: 1 },
  );

  expect(mock.spawnCalls).toHaveLength(0);
  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.scanId, FIXED_SCAN_ID))
    .get();
  expect(vpsRow).toBeUndefined();
  const dispatchRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "dispatch_scan"))
    .all();
  expect(dispatchRows).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 3 — Poll timeout → throw
// ---------------------------------------------------------------------------
test("polling times out and throws when VPS never reaches 'running'", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedQueuedScan(db);

  const mock = makeProviderMock({
    spawnResult: { provider_server_id: "srv-stuck", ipv4: "9.9.9.9" },
    statusSequence: ["initializing"],
  });

  const handler = createSpawnVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    pollIntervalMs: 5,
    pollTimeoutMs: 30,
  });

  let threw = false;
  try {
    await handler(
      { type: "spawn_vps", scan_id: FIXED_SCAN_ID },
      { jobId: "j", attempts: 1 },
    );
  } catch (err) {
    threw = true;
    expect((err as Error).message).toMatch(/timeout|did not become/i);
  }
  expect(threw).toBe(true);

  // No vps_instance / dispatch_scan persisted on timeout.
  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.scanId, FIXED_SCAN_ID))
    .get();
  expect(vpsRow).toBeUndefined();
  const dispatchRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "dispatch_scan"))
    .all();
  expect(dispatchRows).toHaveLength(0);

  // Scan still queued.
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, FIXED_SCAN_ID))
    .get();
  expect(scanRow!.status).toBe("queued");
});

// ---------------------------------------------------------------------------
// Test 4 — provider.spawnVps fails → propagate
// ---------------------------------------------------------------------------
test("spawnVps failure propagates so runner can retry", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedQueuedScan(db);

  const mock = makeProviderMock({
    spawnThrows: new Error("Hetzner 500"),
    statusSequence: ["running"],
  });

  const handler = createSpawnVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    pollIntervalMs: 1,
    pollTimeoutMs: 100,
  });

  let threw: Error | null = null;
  try {
    await handler(
      { type: "spawn_vps", scan_id: FIXED_SCAN_ID },
      { jobId: "j", attempts: 1 },
    );
  } catch (err) {
    threw = err as Error;
  }
  expect(threw).not.toBeNull();
  expect(threw!.message).toContain("Hetzner 500");

  // Nothing persisted — handler failed before any DB write.
  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.scanId, FIXED_SCAN_ID))
    .get();
  expect(vpsRow).toBeUndefined();
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, FIXED_SCAN_ID))
    .get();
  expect(scanRow!.status).toBe("queued");
});

// ---------------------------------------------------------------------------
// Test 5 — audit chain remains intact after happy path
// ---------------------------------------------------------------------------
test("audit chain verifies after happy-path emission", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedQueuedScan(db);

  const mock = makeProviderMock({
    spawnResult: { provider_server_id: "srv-chain", ipv4: "5.5.5.5" },
    statusSequence: ["running"],
  });

  const handler = createSpawnVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
  });

  await handler(
    { type: "spawn_vps", scan_id: FIXED_SCAN_ID },
    { jobId: "j", attempts: 1 },
  );

  const result = verifyChain(db, TEST_SIGNING_KEY);
  expect(result.ok).toBe(true);
  expect(result.rows).toBeGreaterThanOrEqual(1);
});
