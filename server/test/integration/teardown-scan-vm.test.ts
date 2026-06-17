/**
 * T059 — Integration test for `teardown_scan_vm` job handler (T058).
 *
 * What this pins down (per task brief):
 *   1. HAPPY PATH — handler calls provider.teardownVm(vpsInstanceId), polls
 *      the operation to completion (or returns immediately if no operationId),
 *      and emits a signed `vm_teardown` audit row. The scan_orders row is
 *      NOT mutated — teardown is reactive after an already-terminal order
 *      (cancelled/completed/failed). The linked vps_instances row is marked
 *      destroyed for operator diagnostics. The jobs row stays as-is (the
 *      runner flips status='done' on handler success).
 *   2. IDEMPOTENT 404 — provider.teardownVm returns `{operationId: undefined}`
 *      (per gcp.ts:160-162, 404 is treated as "already-gone"). The handler
 *      still emits the `vm_teardown` audit (with metadata flagging the
 *      already-gone case) and returns normally. No throw.
 *   3. RE-RUN NO-OP — invoking the handler a second time, when an earlier
 *      `vm_teardown` audit row already exists for this vps_instance_id, is a
 *      no-op: no second provider call, no duplicate audit row. (This is the
 *      "called twice" idempotency guard — the runner can enqueue teardown
 *      from multiple paths.)
 *   4. TRANSIENT RETRY — provider.teardownVm throws "RATE_LIMIT" twice, then
 *      succeeds on the 3rd attempt → still ends with a single `vm_teardown`
 *      audit row.
 *   5. PERMANENT FAILURE — provider.teardownVm always throws a non-transient
 *      error → handler does NOT throw (records the failure internally),
 *      enqueues a `retry_telegram_notification` operator-alert job. NO
 *      `vm_teardown` audit emitted on the failure path (the audit semantically
 *      means "VM is gone"; if we failed to confirm teardown, we did not
 *      achieve that state). scan_orders row is NOT mutated (already terminal).
 *
 * Why a fake provider is used: Constitution VI mandates the fake as default
 * test fixture. We use FakeCloudProvider for the happy + re-run paths, and
 * small failing stubs for the 404 / retry / permanent-failure paths.
 *
 * Schema notes:
 *   - `vm_teardown` IS a member of BLACKBOX_AUDIT_EVENTS (audit/emit.ts:88) —
 *     no substitution needed.
 *   - Re-run idempotency is detected by scanning audit_log for a prior
 *     `vm_teardown` row carrying the same `vps_instance_id` in metadata.
 *
 * Migrations: bundles both 0000 + 0010 via readdirSync().sort().
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  auditLog,
  jobs,
  scanOrders,
  scans,
  users,
  vpsInstances,
} from "../../src/db/schema.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { FakeCloudProvider } from "../../src/vps/fake-provider.ts";
import {
  createTeardownScanVmHandler,
  type TeardownScanVmJobPayload,
} from "../../src/jobs/handlers/teardown-scan-vm.ts";
import type { CloudProvider } from "../../src/vps/provider.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

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

const TEST_AUDIT_KEY = "test-audit-signing-key-teardown-scan-vm";

const FIXED_USER_ID = "01H0USER00000000000000000T";
const FIXED_ORDER_ID = "01H0ORD000000000000000000T";
const FIXED_SCAN_ID = "01H0SCAN00000000000000000T";
const FIXED_JOB_ID = "01H0JOB000000000000000000T";
const FIXED_VPS_ROW_ID = "01H0VPS000000000000000000T";

const DOMAIN = "example.test";
const VPS_INSTANCE_ID = "fake-vm-1";
const VPS_ZONE = "ru-central1-a";

/**
 * Seed an order that has already reached a terminal state (cancelled),
 * with a VPS instance attached. Teardown is reactive — the order was
 * advanced by some other actor (user cancel, scan completion, watchdog
 * timeout); the teardown handler's job is purely to clean up the VM.
 */
function seedTerminalOrderWithVm(db: DB, now: number): void {
  db.insert(users)
    .values({
      id: FIXED_USER_ID,
      email: "u@x.test",
      createdAt: now,
    })
    .run();

  db.insert(scanOrders)
    .values({
      id: FIXED_ORDER_ID,
      userId: FIXED_USER_ID,
      status: "cancelled", // already terminal — handler must NOT mutate this
      tier: "quick",
      primaryDomain: DOMAIN,
      attackSurfaceJson: JSON.stringify([{ hostname: DOMAIN, included: true }]),
      safetyRps: 50,
      dnsVerifyToken: `tensol-verify-${"x".repeat(26)}`,
      dnsVerifiedAt: now,
      dnsCheckAttempts: 1,
      vpsProvider: "gcp",
      vpsInstanceId: VPS_INSTANCE_ID,
      vpsZone: VPS_ZONE,
      paymentKind: "free_quick",
      scanId: FIXED_SCAN_ID,
      cancelledAt: now,
      failureReason: "cancelled_pre_start",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(scans)
    .values({
      id: FIXED_SCAN_ID,
      userId: FIXED_USER_ID,
      scanOrderId: FIXED_ORDER_ID,
      profile: "recon",
      status: "cancelled",
      startedAt: now,
      completedAt: now,
    })
    .run();

  db.insert(vpsInstances)
    .values({
      id: FIXED_VPS_ROW_ID,
      scanId: FIXED_SCAN_ID,
      provider: "gcp",
      providerServerId: VPS_INSTANCE_ID,
      ipv4: "203.0.113.10",
      status: "alive",
      signKey: "test-dispatch-sign-key",
      createdAt: now,
    })
    .run();

  db.insert(jobs)
    .values({
      id: FIXED_JOB_ID,
      type: "teardown_scan_vm",
      payloadJson: JSON.stringify({
        type: "teardown_scan_vm",
        scan_id: FIXED_SCAN_ID,
        scan_order_id: FIXED_ORDER_ID,
        vps_instance_id: VPS_INSTANCE_ID,
        vps_zone: VPS_ZONE,
      }),
      status: "running",
      scheduledAt: now,
      attempts: 1,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const BASE_PAYLOAD: TeardownScanVmJobPayload = {
  scanOrderId: FIXED_ORDER_ID,
  scanId: FIXED_SCAN_ID,
  vpsInstanceId: VPS_INSTANCE_ID,
  vpsZone: VPS_ZONE,
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-teardown-gcp-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1 — HAPPY PATH
// ───────────────────────────────────────────────────────────────────────────
test("happy path: teardownVm called → VPS row destroyed, vm_teardown audit emitted, order status unchanged", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedTerminalOrderWithVm(db, ts);

  // Pre-seed the fake's internal state so teardownVm finds the instance.
  const provider = new FakeCloudProvider();
  // Spawn once to create instance "fake-vm-1" in the fake's map.
  await provider.spawnVm({ scanId: FIXED_SCAN_ID, userData: "" });
  // Poll to fully resolve the spawn so subsequent teardown returns an opId.
  const spawnOps = await provider.pollOperation("fake-op-spawn-1");
  expect(spawnOps.done).toBe(true);

  let teardownCalls = 0;
  const wrappedProvider: CloudProvider = {
    spawnVm: (input) => provider.spawnVm(input),
    async teardownVm(id) {
      teardownCalls += 1;
      return provider.teardownVm(id);
    },
    getStatus: (id) => provider.getStatus(id),
    pollOperation: (id) => provider.pollOperation(id),
  };

  let clock = ts + 1;
  const handler = createTeardownScanVmHandler({
    db,
    provider: wrappedProvider,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  expect(teardownCalls).toBe(1);

  // scan_orders row UNCHANGED (still cancelled).
  const orderRow = db
    .select()
    .from(scanOrders)
    .where(eq(scanOrders.id, FIXED_ORDER_ID))
    .get();
  expect(orderRow!.status).toBe("cancelled");
  expect(orderRow!.vpsInstanceId).toBe(VPS_INSTANCE_ID); // preserved

  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.id, FIXED_VPS_ROW_ID))
    .get();
  expect(vpsRow?.status).toBe("destroyed");
  expect(vpsRow?.destroyedAt).toBeGreaterThan(ts);

  // vm_teardown audit row emitted.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vm_teardown"))
    .all();
  expect(auditRows).toHaveLength(1);
  const a = auditRows[0]!;
  expect(a.outcome).toBe("success");
  expect(a.scanId).toBe(FIXED_SCAN_ID);
  expect(a.vpsInstanceId).toBe(VPS_INSTANCE_ID);
  const meta = JSON.parse(a.metadataJson) as Record<string, unknown>;
  expect(meta.scan_order_id).toBe(FIXED_ORDER_ID);
  expect(meta.vps_instance_id).toBe(VPS_INSTANCE_ID);
  expect(meta.vps_zone).toBe(VPS_ZONE);

  // Audit chain still valid.
  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2 — IDEMPOTENT 404 (provider says "already gone")
// ───────────────────────────────────────────────────────────────────────────
test("idempotent 404: provider.teardownVm returns {} (already gone) → vm_teardown audit still emitted, no throw", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedTerminalOrderWithVm(db, ts);

  let teardownCalls = 0;
  const provider: CloudProvider = {
    async spawnVm() {
      throw new Error("must not be called");
    },
    async teardownVm() {
      teardownCalls += 1;
      // GCP provider's documented 404 contract — returns empty object.
      return {};
    },
    async getStatus() {
      throw new Error("unreachable");
    },
    async pollOperation(operationId) {
      // Should not be polled when no operationId returned.
      return { operationId, done: false };
    },
  };

  let clock = ts + 1;
  const handler = createTeardownScanVmHandler({
    db,
    provider,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  expect(teardownCalls).toBe(1);

  // vm_teardown audit still emitted, with already_gone flag in metadata.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vm_teardown"))
    .all();
  expect(auditRows).toHaveLength(1);
  const meta = JSON.parse(auditRows[0]!.metadataJson) as Record<string, unknown>;
  expect(meta.vps_instance_id).toBe(VPS_INSTANCE_ID);
  expect(meta.already_gone).toBe(true);

  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.id, FIXED_VPS_ROW_ID))
    .get();
  expect(vpsRow?.status).toBe("destroyed");
  expect(vpsRow?.destroyedAt).toBeGreaterThan(ts);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3 — RE-RUN NO-OP (already torn down on a prior invocation)
// ───────────────────────────────────────────────────────────────────────────
test("re-run no-op: second invocation with existing vm_teardown audit → no provider call, no duplicate audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedTerminalOrderWithVm(db, ts);

  let teardownCalls = 0;
  const provider: CloudProvider = {
    async spawnVm() {
      throw new Error("must not be called");
    },
    async teardownVm() {
      teardownCalls += 1;
      return {};
    },
    async getStatus() {
      throw new Error("unreachable");
    },
    async pollOperation(operationId) {
      return { operationId, done: false };
    },
  };

  let clock = ts + 1;
  const handler = createTeardownScanVmHandler({
    db,
    provider,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    retryBackoffMs: 1,
  });

  // First invocation — emits vm_teardown.
  await handler(FIXED_JOB_ID, BASE_PAYLOAD);
  expect(teardownCalls).toBe(1);

  // Second invocation — should be a no-op.
  await handler(FIXED_JOB_ID, BASE_PAYLOAD);
  expect(teardownCalls).toBe(1); // still 1 — provider not called twice

  // Still exactly one vm_teardown audit row.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vm_teardown"))
    .all();
  expect(auditRows).toHaveLength(1);

  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.id, FIXED_VPS_ROW_ID))
    .get();
  expect(vpsRow?.status).toBe("destroyed");

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4 — TRANSIENT RETRY (succeeds on 3rd attempt)
// ───────────────────────────────────────────────────────────────────────────
test("transient retry: teardownVm throws RATE_LIMIT twice then succeeds → exactly one vm_teardown audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedTerminalOrderWithVm(db, ts);

  let attempts = 0;
  const provider: CloudProvider = {
    async spawnVm() {
      throw new Error("must not be called");
    },
    async teardownVm() {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("RATE_LIMIT exceeded — retry");
      }
      return {}; // 3rd attempt: success (already-gone style)
    },
    async getStatus() {
      throw new Error("unreachable");
    },
    async pollOperation(operationId) {
      return { operationId, done: false };
    },
  };

  let clock = ts + 1;
  const handler = createTeardownScanVmHandler({
    db,
    provider,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  expect(attempts).toBe(3);

  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vm_teardown"))
    .all();
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0]!.outcome).toBe("success");

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5 — PERMANENT FAILURE after MAX_RETRIES
// ───────────────────────────────────────────────────────────────────────────
test("permanent failure: teardownVm always throws non-transient → no vm_teardown audit, retry_telegram_notification enqueued, scan_order untouched", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedTerminalOrderWithVm(db, ts);

  let attempts = 0;
  const provider: CloudProvider = {
    async spawnVm() {
      throw new Error("must not be called");
    },
    async teardownVm() {
      attempts += 1;
      throw new Error("gcp teardownVm: HTTP 403 forbidden");
    },
    async getStatus() {
      throw new Error("unreachable");
    },
    async pollOperation(operationId) {
      return { operationId, done: false };
    },
  };

  let clock = ts + 1;
  const handler = createTeardownScanVmHandler({
    db,
    provider,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    retryBackoffMs: 1,
  });

  // Handler MUST NOT throw — it records the failure internally.
  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // Non-transient → only one attempt (no retries).
  expect(attempts).toBe(1);

  // NO vm_teardown audit row — we did not achieve "VM is gone".
  const vmTeardown = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vm_teardown"))
    .all();
  expect(vmTeardown).toHaveLength(0);

  // scan_orders untouched (still cancelled).
  const orderRow = db
    .select()
    .from(scanOrders)
    .where(eq(scanOrders.id, FIXED_ORDER_ID))
    .get();
  expect(orderRow!.status).toBe("cancelled");

  const vpsRow = db
    .select()
    .from(vpsInstances)
    .where(eq(vpsInstances.id, FIXED_VPS_ROW_ID))
    .get();
  expect(vpsRow?.status).toBe("alive");
  expect(vpsRow?.destroyedAt).toBeNull();

  // retry_telegram_notification job enqueued (operator alert per pivot doc).
  const telJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "retry_telegram_notification"))
    .all();
  expect(telJobs).toHaveLength(1);
  expect(telJobs[0]!.status).toBe("pending");
  const telPayload = JSON.parse(telJobs[0]!.payloadJson) as Record<
    string,
    unknown
  >;
  expect(telPayload.kind).toBe("operator_alert_vm_teardown_failed");
  expect(telPayload.scan_order_id).toBe(FIXED_ORDER_ID);
  expect(telPayload.vps_instance_id).toBe(VPS_INSTANCE_ID);

  // Audit chain still valid (no audit rows = trivially valid).
  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});
