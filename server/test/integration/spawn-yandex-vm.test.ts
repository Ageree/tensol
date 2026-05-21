/**
 * T057 — Integration test for `spawn_yandex_vm` job handler (T056).
 *
 * What this pins down (per task brief):
 *   1. HAPPY PATH — handler builds cloud-init, calls provider.spawnVm, polls
 *      operation to completion, persists `vps_instance_id` + `vps_zone` on
 *      the scan_order, flips order status to `running`, inserts a
 *      `scan_events` row with `event_type='vm_ready'`, emits a signed
 *      `vm_ready` audit row. The jobs row stays as-is (the runner is the
 *      one that flips status='done' on handler success — see runner.ts:232).
 *   2. TRANSIENT-RETRY — provider.spawnVm throws "RATE_LIMIT" twice, succeeds
 *      on the 3rd attempt → order still ends in `running` with the
 *      `vm_ready` audit + scan_events row. The handler swallows transient
 *      failures internally up to 3 attempts.
 *   3. PERMANENT-FAILURE — provider.spawnVm always throws → order flips to
 *      `failed`, free-tier quota refunded (`free_quick_consumed_at` ← null),
 *      a `scan_failed` audit row is emitted with metadata referencing the
 *      VM provisioning failure, AND a `retry_telegram_notification` job is
 *      enqueued (the only existing job-type the schema knows that can carry
 *      an operator alert; see schema.ts:483).
 *   4. IDEMPOTENCY — handler is invoked for an order that's no longer in
 *      `vm_provisioning` (already running / cancelled / failed) → no-op:
 *      no provider call, no audit, no state mutation.
 *
 * Why a fake provider (FakeCloudProvider from T022) is used:
 *   Constitution VI mandates the fake as the default test fixture. The fake
 *   does not allow programmatic failure injection, so we wrap it (or replace
 *   it) with a small failing stub for the failure-path tests. The happy +
 *   idempotency paths use the unmodified FakeCloudProvider.
 *
 * Schema notes (surprises encountered):
 *   - `scan_orders.vpsInstanceId` is the column the brief calls
 *     "vps_instance_id on scan_order". It's a TEXT column — the handler
 *     writes the provider's `instanceId` directly (not a fresh ULID).
 *   - `scan_orders.vpsZone` is nullable TEXT — the handler writes the zone
 *     supplied via deps (defaults to `ru-central1-a` for the fake).
 *   - There is NO `vm_provisioning_failed` event type in
 *     BLACKBOX_AUDIT_EVENTS (audit/emit.ts:72-114). The closest is
 *     `scan_failed`; we use it with `outcome='failure'` and a
 *     `reason='vm_spawn_failed'` field in metadata.
 *   - `retry_telegram_notification` is the only `jobs.type` value in
 *     schema.ts:483 that can plausibly carry an operator alert. We piggy-back
 *     on it for the "Telegram alert" requirement; the payload shape is
 *     {type, kind, scan_id, scan_order_id, error}.
 *
 * Migrations: bundles both 0000 (init) and 0010 (blackbox MVP) via
 * `readdirSync(MIGRATIONS_DIR).sort()`, applied as raw SQL through the
 * underlying bun:sqlite handle.
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

import { createDb, type DB } from "../../src/db/client.ts";
import {
  auditLog,
  jobs,
  scanEvents,
  scanOrders,
  scans,
  users,
} from "../../src/db/schema.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { FakeCloudProvider } from "../../src/vps/fake-provider.ts";
import { refundFreeQuickQuota } from "../../src/free-tier/service.ts";
import {
  createSpawnYandexVmHandler,
  type SpawnYandexVmJobPayload,
} from "../../src/jobs/handlers/spawn-yandex-vm.ts";
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

const TEST_AUDIT_KEY = "test-audit-signing-key-spawn-yandex-vm";

const FIXED_USER_ID = "01H0USER00000000000000000B";
const FIXED_ORDER_ID = "01H0ORD000000000000000000B";
const FIXED_SCAN_ID = "01H0SCAN00000000000000000B";
const FIXED_JOB_ID = "01H0JOB000000000000000000B";

const DOMAIN = "example.test";

const CLOUD_INIT_DEPS = {
  backendUrl: "https://api.tensol.run/v1",
  webhookSecret: "test-webhook-secret-32-bytes-hexxx",
  evidenceBucket: "tensol-evidence-test",
  evidencePrefix: "evidence/",
  awsAccessKeyId: "YCAJxxxxxxxxxxxx",
  awsSecretAccessKey: "YCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  awsEndpoint: "https://storage.yandexcloud.net",
  awsRegion: "ru-central1",
  signKey: "a".repeat(64),
  decepticonImage: "ghcr.io/tensol/decepticon@sha256:deadbeef",
  vpsZone: "ru-central1-a",
  openrouterApiKey: "sk-or-v1-test-fake-key-spawn-yandex-vm",
  litellmMasterKey: "sk-test-litellm-internal",
  postgresPassword: "test-postgres-pw",
  neo4jPassword: "test-neo4j-pw",
};

function seedQuickQueuedOrder(db: DB, now: number): void {
  // Consume the free-tier quota up-front to mirror what launchScan would have
  // done — the failure-path test asserts this gets reset to null on refund.
  db.insert(users)
    .values({
      id: FIXED_USER_ID,
      email: "u@x.test",
      createdAt: now,
      freeQuickConsumedAt: now,
      freeQuickConsumedCount: 1,
    })
    .run();

  db.insert(scanOrders)
    .values({
      id: FIXED_ORDER_ID,
      userId: FIXED_USER_ID,
      status: "vm_provisioning",
      tier: "quick",
      primaryDomain: DOMAIN,
      attackSurfaceJson: JSON.stringify([{ hostname: DOMAIN, included: true }]),
      safetyRps: 50,
      dnsVerifyToken: `tensol-verify-${"x".repeat(26)}`,
      dnsVerifiedAt: now,
      dnsCheckAttempts: 1,
      vpsProvider: "yandex",
      paymentKind: "free_quick",
      scanId: FIXED_SCAN_ID,
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
      status: "queued",
      startedAt: now,
    })
    .run();

  db.insert(jobs)
    .values({
      id: FIXED_JOB_ID,
      type: "spawn_yandex_vm",
      payloadJson: JSON.stringify({
        type: "spawn_yandex_vm",
        scan_id: FIXED_SCAN_ID,
        scan_order_id: FIXED_ORDER_ID,
        primary_domain: DOMAIN,
      }),
      status: "running", // mirrors the runner's atomic-claim state at dispatch
      scheduledAt: now,
      attempts: 1,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const BASE_PAYLOAD: SpawnYandexVmJobPayload = {
  scanOrderId: FIXED_ORDER_ID,
  scanId: FIXED_SCAN_ID,
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-spawn-yandex-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1 — HAPPY PATH
// ───────────────────────────────────────────────────────────────────────────
test("happy path: spawnVm + poll → vps_instance_id/vps_zone persisted, order→running, vm_ready audit + scan_events row", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedQuickQueuedOrder(db, ts);

  const provider = new FakeCloudProvider();

  let clock = ts + 1;
  const handler = createSpawnYandexVmHandler({
    db,
    provider,
    auditKey: TEST_AUDIT_KEY,
    refundFreeQuickQuota,
    now: () => clock++,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    ...CLOUD_INIT_DEPS,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // scan_orders row updated.
  const orderRow = db
    .select()
    .from(scanOrders)
    .where(eq(scanOrders.id, FIXED_ORDER_ID))
    .get();
  expect(orderRow).not.toBeUndefined();
  expect(orderRow!.status).toBe("running");
  expect(orderRow!.vpsInstanceId).toBe("fake-vm-1");
  expect(orderRow!.vpsZone).toBe(CLOUD_INIT_DEPS.vpsZone);

  // scans row also flipped to running.
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, FIXED_SCAN_ID))
    .get();
  expect(scanRow!.status).toBe("running");

  // scan_events row inserted with event_type='vm_ready'.
  const events = db
    .select()
    .from(scanEvents)
    .where(eq(scanEvents.scanId, FIXED_SCAN_ID))
    .all();
  expect(events).toHaveLength(1);
  expect(events[0]!.eventType).toBe("vm_ready");
  const evPayload = JSON.parse(events[0]!.payloadJson ?? "{}");
  expect(evPayload.vps_instance_id).toBe("fake-vm-1");
  expect(evPayload.vps_zone).toBe(CLOUD_INIT_DEPS.vpsZone);

  // Audit row emitted.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vm_ready"))
    .all();
  expect(auditRows).toHaveLength(1);
  const a = auditRows[0]!;
  expect(a.outcome).toBe("success");
  expect(a.scanId).toBe(FIXED_SCAN_ID);
  const meta = JSON.parse(a.metadataJson) as Record<string, unknown>;
  expect(meta.scan_order_id).toBe(FIXED_ORDER_ID);
  expect(meta.vps_instance_id).toBe("fake-vm-1");

  // Audit chain still valid.
  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2 — TRANSIENT-RETRY (succeeds on 3rd attempt)
// ───────────────────────────────────────────────────────────────────────────
test("transient retry: spawnVm throws RATE_LIMIT twice then succeeds → order ends in running with vm_ready", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedQuickQueuedOrder(db, ts);

  const fake = new FakeCloudProvider();
  let attempts = 0;
  const provider: CloudProvider = {
    async spawnVm(input) {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("RATE_LIMIT exceeded — retry");
      }
      return fake.spawnVm(input);
    },
    teardownVm: (id) => fake.teardownVm(id),
    getStatus: (id) => fake.getStatus(id),
    pollOperation: (id) => fake.pollOperation(id),
  };

  let clock = ts + 1;
  const handler = createSpawnYandexVmHandler({
    db,
    provider,
    auditKey: TEST_AUDIT_KEY,
    refundFreeQuickQuota,
    now: () => clock++,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    retryBackoffMs: 1,
    ...CLOUD_INIT_DEPS,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  expect(attempts).toBe(3);

  const orderRow = db
    .select()
    .from(scanOrders)
    .where(eq(scanOrders.id, FIXED_ORDER_ID))
    .get();
  expect(orderRow!.status).toBe("running");
  expect(orderRow!.vpsInstanceId).toBe("fake-vm-1");

  const vmReady = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "vm_ready"))
    .all();
  expect(vmReady).toHaveLength(1);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3 — PERMANENT FAILURE after MAX_RETRIES
// ───────────────────────────────────────────────────────────────────────────
test("permanent failure: spawnVm always throws → order=failed, quota refunded, scan_failed audit, retry_telegram_notification enqueued", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedQuickQueuedOrder(db, ts);

  // Confirm seed state: quota IS consumed.
  const userBefore = db.select().from(users).where(eq(users.id, FIXED_USER_ID)).get();
  expect(userBefore!.freeQuickConsumedAt).toBe(ts);
  expect(userBefore!.freeQuickConsumedCount).toBe(1);

  let attempts = 0;
  const provider: CloudProvider = {
    async spawnVm() {
      attempts += 1;
      throw new Error("RATE_LIMIT — out of quota for the day");
    },
    async teardownVm() {
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
  const handler = createSpawnYandexVmHandler({
    db,
    provider,
    auditKey: TEST_AUDIT_KEY,
    refundFreeQuickQuota,
    now: () => clock++,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    retryBackoffMs: 1,
    ...CLOUD_INIT_DEPS,
  });

  // Handler MUST NOT throw — it handles permanent failure internally and
  // returns. The runner records status='done' for the job row, but the
  // domain failure is captured in audit + state.
  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  expect(attempts).toBe(3);

  // Order flipped to failed.
  const orderRow = db
    .select()
    .from(scanOrders)
    .where(eq(scanOrders.id, FIXED_ORDER_ID))
    .get();
  expect(orderRow!.status).toBe("failed");
  expect(orderRow!.failureReason).toBe("vm_spawn_failed");

  // scans row also flipped to failed (mirror state).
  const scanRow = db
    .select()
    .from(scans)
    .where(eq(scans.id, FIXED_SCAN_ID))
    .get();
  expect(scanRow!.status).toBe("failed");
  expect(scanRow!.failureReason).toBe("vm_spawn_failed");

  // Free-tier quota refunded.
  const userAfter = db.select().from(users).where(eq(users.id, FIXED_USER_ID)).get();
  expect(userAfter!.freeQuickConsumedAt).toBeNull();
  expect(userAfter!.freeQuickConsumedCount).toBe(0);

  // scan_failed audit row emitted (closest semantic event in
  // BLACKBOX_AUDIT_EVENTS; metadata carries the vm_spawn_failed reason).
  const failedAudit = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(failedAudit).toHaveLength(1);
  expect(failedAudit[0]!.outcome).toBe("failure");
  expect(failedAudit[0]!.scanId).toBe(FIXED_SCAN_ID);
  const failMeta = JSON.parse(failedAudit[0]!.metadataJson) as Record<string, unknown>;
  expect(failMeta.reason).toBe("vm_spawn_failed");
  expect(failMeta.scan_order_id).toBe(FIXED_ORDER_ID);

  // Refund audit row emitted.
  const refundAudit = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "free_quota_refunded"))
    .all();
  expect(refundAudit).toHaveLength(1);

  // retry_telegram_notification job enqueued (operator alert per pivot doc).
  const telJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "retry_telegram_notification"))
    .all();
  expect(telJobs).toHaveLength(1);
  expect(telJobs[0]!.status).toBe("pending");
  const telPayload = JSON.parse(telJobs[0]!.payloadJson) as Record<string, unknown>;
  expect(telPayload.kind).toBe("operator_alert_vm_spawn_failed");
  expect(telPayload.scan_order_id).toBe(FIXED_ORDER_ID);
  expect(telPayload.scan_id).toBe(FIXED_SCAN_ID);

  // Audit chain still valid.
  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4 — IDEMPOTENCY (order no longer in vm_provisioning)
// ───────────────────────────────────────────────────────────────────────────
test("idempotency: handler is a no-op when order is no longer in vm_provisioning", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedQuickQueuedOrder(db, ts);

  // Mutate the order to 'cancelled' BEFORE the handler runs.
  db.update(scanOrders)
    .set({ status: "cancelled" })
    .where(eq(scanOrders.id, FIXED_ORDER_ID))
    .run();

  let spawnCalls = 0;
  const provider: CloudProvider = {
    async spawnVm() {
      spawnCalls += 1;
      throw new Error("must not be called");
    },
    async teardownVm() {
      return {};
    },
    async getStatus() {
      throw new Error("unreachable");
    },
    async pollOperation(operationId) {
      return { operationId, done: false };
    },
  };

  const handler = createSpawnYandexVmHandler({
    db,
    provider,
    auditKey: TEST_AUDIT_KEY,
    refundFreeQuickQuota,
    now: () => ts + 5,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    ...CLOUD_INIT_DEPS,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // Provider was never called.
  expect(spawnCalls).toBe(0);

  // No audit emitted by this handler invocation.
  const auditRows = db.select().from(auditLog).all();
  expect(auditRows.length).toBe(0);

  // Order status preserved.
  const orderRow = db
    .select()
    .from(scanOrders)
    .where(eq(scanOrders.id, FIXED_ORDER_ID))
    .get();
  expect(orderRow!.status).toBe("cancelled");
  expect(orderRow!.vpsInstanceId).toBeNull();
});
