/**
 * T045 — teardown_vps handler tests.
 *
 * The handler is built via `createTeardownVpsHandler({ db, vpsProvider,
 * signingKey, now })`. Provider is fully mocked (no Hetzner / network).
 *
 * Coverage targets (per T045 brief):
 *   1. HAPPY PATH — vps_instance status='alive' → destroyVps called with
 *      provider_server_id; row updated status='destroyed' + destroyed_at;
 *      vps_destroyed audit row emitted with reason metadata.
 *   2. IDEMPOTENT on already 'destroyed' — no provider call, no audit
 *      duplicate.
 *   3. MISSING vps_instance row — defensive no-op (no throw).
 *   4. PROVIDER throws (5xx) → propagate so runner retries; status is left
 *      at 'tearing_down' for the next retry.
 *   5. IDEMPOTENT entry on 'tearing_down' status (mid-retry) — proceeds and
 *      finishes at 'destroyed' + audit emitted.
 *   6. Audit chain remains intact after happy path.
 *   7. Different reasons (`completed`/`failed`/`cancelled`) preserved in
 *      audit metadata.
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
  projects,
  scans,
  targets,
  users,
  vpsInstances,
} from "../../db/schema.ts";
import { verifyChain } from "../../audit/verify-chain.ts";
import { createTeardownVpsHandler } from "./teardown-vps.ts";
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

const TEST_SIGNING_KEY = "test-audit-signing-key-teardown-vps";

const FIXED_USER_ID = "01H0USER00000000000000000A";
const FIXED_PROJECT_ID = "01H0PROJ00000000000000000A";
const FIXED_TARGET_ID = "01H0TGT0000000000000000000A";
const FIXED_SCAN_ID = "01H0SCAN00000000000000000A";
const FIXED_VPS_ID = "01H0VPS000000000000000000A";
const FIXED_PROVIDER_SERVER_ID = "srv-teardown-1";

function seedScanAndVps(
  db: DB,
  vpsStatus: "provisioning" | "alive" | "tearing_down" | "destroyed",
  destroyedAt: number | null = null,
): void {
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
      status: "running",
      startedAt: ts,
    })
    .run();
  db.insert(vpsInstances)
    .values({
      id: FIXED_VPS_ID,
      scanId: FIXED_SCAN_ID,
      provider: "hetzner",
      providerServerId: FIXED_PROVIDER_SERVER_ID,
      ipv4: "10.0.0.42",
      status: vpsStatus,
      signKey: "deadbeef".repeat(8),
      createdAt: ts,
      destroyedAt,
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
  destroyThrows?: Error;
}): ProviderMock {
  const spawnCalls: SpawnVpsArgs[] = [];
  const statusCalls: string[] = [];
  const destroyCalls: string[] = [];
  const provider: VpsProvider = {
    async spawnVps(args): Promise<SpawnedVps> {
      spawnCalls.push(args);
      return { provider_server_id: "srv-1", ipv4: "1.2.3.4" };
    },
    async getVpsStatus(id): Promise<VpsStatus> {
      statusCalls.push(id);
      return "running";
    },
    async destroyVps(id) {
      destroyCalls.push(id);
      if (opts.destroyThrows) throw opts.destroyThrows;
    },
  };
  return { provider, spawnCalls, statusCalls, destroyCalls };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-teardown-vps-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — HAPPY PATH
// ---------------------------------------------------------------------------
test("happy path: destroys vps, updates row to 'destroyed', emits audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScanAndVps(db, "alive");

  const mock = makeProviderMock({});

  let clock = 2_000_000_000_000;
  const handler = createTeardownVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
    now: () => clock++,
  });

  await handler(
    {
      type: "teardown_vps",
      vps_instance_id: FIXED_VPS_ID,
      reason: "completed",
    },
    { jobId: "01H0JOB00000000000000000AA", attempts: 1 },
  );

  // Provider was called with the provider_server_id, not vps_instance.id.
  expect(mock.destroyCalls).toEqual([FIXED_PROVIDER_SERVER_ID]);

  // vps_instances row updated.
  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.id, FIXED_VPS_ID))
    .get();
  expect(vpsRow!.status).toBe("destroyed");
  expect(vpsRow!.destroyedAt).not.toBeNull();
  expect(typeof vpsRow!.destroyedAt).toBe("number");

  // Audit row emitted.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vps_destroyed"))
    .all();
  expect(auditRows).toHaveLength(1);
  const a = auditRows[0]!;
  expect(a.outcome).toBe("success");
  expect(a.scanId).toBe(FIXED_SCAN_ID);
  expect(a.vpsInstanceId).toBe(FIXED_VPS_ID);
  const meta = JSON.parse(a.metadataJson) as Record<string, unknown>;
  expect(meta.reason).toBe("completed");
  expect(meta.provider_server_id).toBe(FIXED_PROVIDER_SERVER_ID);
  // SECURITY: sign_key MUST NOT leak.
  expect("sign_key" in meta).toBe(false);
  expect("signKey" in meta).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 2 — Idempotent on already-destroyed
// ---------------------------------------------------------------------------
test("no-op when vps_instance is already 'destroyed' (no provider call, no audit dup)", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScanAndVps(db, "destroyed", 1_699_999_999_000);

  const mock = makeProviderMock({});
  const handler = createTeardownVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
  });

  await handler(
    {
      type: "teardown_vps",
      vps_instance_id: FIXED_VPS_ID,
      reason: "completed",
    },
    { jobId: "j", attempts: 1 },
  );

  // Provider not called.
  expect(mock.destroyCalls).toHaveLength(0);

  // No audit row emitted.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vps_destroyed"))
    .all();
  expect(auditRows).toHaveLength(0);

  // Row unchanged.
  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.id, FIXED_VPS_ID))
    .get();
  expect(vpsRow!.status).toBe("destroyed");
  expect(vpsRow!.destroyedAt).toBe(1_699_999_999_000);
});

// ---------------------------------------------------------------------------
// Test 3 — Missing vps_instance row (defensive)
// ---------------------------------------------------------------------------
test("no-op when vps_instance does not exist (defensive — no throw)", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  // Seed scan only, no vps_instances row.
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
      status: "running",
      startedAt: ts,
    })
    .run();

  const mock = makeProviderMock({});
  const handler = createTeardownVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
  });

  // Must not throw.
  await handler(
    {
      type: "teardown_vps",
      vps_instance_id: "01H0MISSING0000000000000AA",
      reason: "completed",
    },
    { jobId: "j", attempts: 1 },
  );

  expect(mock.destroyCalls).toHaveLength(0);
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vps_destroyed"))
    .all();
  expect(auditRows).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 4 — provider.destroyVps throws → propagate; status stuck at 'tearing_down'
// ---------------------------------------------------------------------------
test("provider failure propagates; status left at 'tearing_down' for retry", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScanAndVps(db, "alive");

  const mock = makeProviderMock({
    destroyThrows: new Error("Hetzner 503"),
  });

  const handler = createTeardownVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
  });

  let threw: Error | null = null;
  try {
    await handler(
      {
        type: "teardown_vps",
        vps_instance_id: FIXED_VPS_ID,
        reason: "completed",
      },
      { jobId: "j", attempts: 1 },
    );
  } catch (err) {
    threw = err as Error;
  }
  expect(threw).not.toBeNull();
  expect(threw!.message).toContain("Hetzner 503");

  // Row mid-transition: 'tearing_down', no destroyed_at, no audit.
  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.id, FIXED_VPS_ID))
    .get();
  expect(vpsRow!.status).toBe("tearing_down");
  expect(vpsRow!.destroyedAt).toBeNull();

  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vps_destroyed"))
    .all();
  expect(auditRows).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 5 — Retry from 'tearing_down' state
// ---------------------------------------------------------------------------
test("proceeds from 'tearing_down' state on retry, completes destroy + audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScanAndVps(db, "tearing_down");

  const mock = makeProviderMock({});
  const handler = createTeardownVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
  });

  await handler(
    {
      type: "teardown_vps",
      vps_instance_id: FIXED_VPS_ID,
      reason: "failed",
    },
    { jobId: "j", attempts: 2 },
  );

  expect(mock.destroyCalls).toEqual([FIXED_PROVIDER_SERVER_ID]);

  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.id, FIXED_VPS_ID))
    .get();
  expect(vpsRow!.status).toBe("destroyed");
  expect(vpsRow!.destroyedAt).not.toBeNull();

  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vps_destroyed"))
    .all();
  expect(auditRows).toHaveLength(1);
  const meta = JSON.parse(auditRows[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.reason).toBe("failed");
});

// ---------------------------------------------------------------------------
// Test 6 — Audit chain intact after happy path
// ---------------------------------------------------------------------------
test("audit chain verifies after happy-path emission", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedScanAndVps(db, "alive");

  const mock = makeProviderMock({});
  const handler = createTeardownVpsHandler({
    db,
    vpsProvider: mock.provider,
    signingKey: TEST_SIGNING_KEY,
  });

  await handler(
    {
      type: "teardown_vps",
      vps_instance_id: FIXED_VPS_ID,
      reason: "cancelled",
    },
    { jobId: "j", attempts: 1 },
  );

  const result = verifyChain(db, TEST_SIGNING_KEY);
  expect(result.ok).toBe(true);
  expect(result.rows).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Test 7 — Different reasons preserved in audit metadata
// ---------------------------------------------------------------------------
test("reason metadata is preserved verbatim ('completed'|'failed'|'cancelled')", async () => {
  for (const reason of ["completed", "failed", "cancelled"] as const) {
    const db = createDb(":memory:");
    applyMigrations(db);
    seedScanAndVps(db, "alive");

    const mock = makeProviderMock({});
    const handler = createTeardownVpsHandler({
      db,
      vpsProvider: mock.provider,
      signingKey: TEST_SIGNING_KEY,
    });

    await handler(
      {
        type: "teardown_vps",
        vps_instance_id: FIXED_VPS_ID,
        reason,
      },
      { jobId: "j", attempts: 1 },
    );

    const auditRows = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, "vps_destroyed"))
      .all();
    expect(auditRows).toHaveLength(1);
    const meta = JSON.parse(auditRows[0]!.metadataJson) as Record<
      string,
      unknown
    >;
    expect(meta.reason).toBe(reason);
  }
});
