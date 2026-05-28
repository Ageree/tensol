/**
 * T124 — Integration test for the `cleanup_orphan_vms` cron task (T123).
 *
 * Per research §R10: belt-and-braces cron that deletes VMs in the test +
 * prod folders whose names match `tensol-test-*` / `tensol-scan-*` AND
 * exceed the per-prefix grace window (30 min for tests / 120 min for prod).
 * When the run deletes >0 VMs, the operator gets a Telegram alert — that
 * is the "silent leakage is impossible" guarantee.
 *
 * What this pins down:
 *   1. HAPPY PATH — 3 eligible orphans (2 tensol-test-* old + 1 tensol-scan-*
 *      old) + 2 fresh + 1 unrelated-prefix → 3 deleted, 3 remain, alert
 *      fires exactly once with the 3 ids.
 *   2. NO ORPHANS — every instance is fresh or has an unrelated prefix → 0
 *      deleted, deps.sendAlert NEVER called.
 *   3. PARTIAL FAILURE — provider.teardownVm throws for one specific
 *      instance → that id appears in `errors`, the other deletes succeed,
 *      alert STILL fires (deletions happened).
 *   4. PER-PREFIX MIN-AGE — a `tensol-test-*` and a `tensol-scan-*`
 *      instance both 60-min-old: only the test-prefixed one is deleted
 *      (test grace = 30 min; prod grace = 120 min).
 *   5. EMPTY FOLDER LIST — deps.folderIds=[] → 0 deleted, no alert, no
 *      provider call.
 *
 * Test fixture: we extend `FakeCloudProvider` via its new `seedInstance`
 * helper (the extension shipped in T123) so each test stands up its own
 * deterministic in-memory provider — no real cloud, no global state.
 */
import { expect, test } from "bun:test";

import { FakeCloudProvider } from "../../src/vps/fake-provider.ts";
import { createCleanupOrphanVmsTask } from "../../src/jobs/handlers/cleanup-orphan-vms.ts";

const TEST_FOLDER = "folder-test-001";
const PROD_FOLDER = "folder-prod-001";
const TEST_MIN_AGE_MS = 30 * 60 * 1000;
const PROD_MIN_AGE_MS = 120 * 60 * 1000;
const NOW = 1_700_000_000_000;

/**
 * Build a fresh task wired to a fresh provider + an in-memory "sent" log
 * for the Telegram alert. Returns both so each test can assert on alerts.
 */
function makeTask(opts: {
  folderIds?: string[];
  teardownFailures?: Set<string>;
} = {}) {
  const provider = new FakeCloudProvider();
  const alerts: string[] = [];

  // Optional: simulate teardown failures by wrapping the provider's
  // teardownVm. We *do not* mutate the FakeCloudProvider class itself —
  // the wrapper is a per-test concern. Keeps the fake provider's general
  // contract intact (Constitution VI: deterministic test fixture).
  const failingIds = opts.teardownFailures ?? new Set<string>();
  const wrappedProvider = {
    listInstances: provider.listInstances.bind(provider),
    teardownVm: async (id: string) => {
      if (failingIds.has(id)) {
        throw new Error(`simulated teardown failure for ${id}`);
      }
      return provider.teardownVm(id);
    },
  };

  const task = createCleanupOrphanVmsTask({
    provider: wrappedProvider,
    folderIds: opts.folderIds ?? [TEST_FOLDER, PROD_FOLDER],
    namePrefixes: ["tensol-test-", "tensol-scan-"],
    minAgeMs: {
      "tensol-test-": TEST_MIN_AGE_MS,
      "tensol-scan-": PROD_MIN_AGE_MS,
    },
    sendAlert: async (text: string) => {
      alerts.push(text);
    },
  });

  return { task, provider, alerts };
}

// ───────────────────────────────────────────────────────────────────────────
// Test 1 — HAPPY PATH
// ───────────────────────────────────────────────────────────────────────────
test("happy path: 3 eligible orphans deleted, alert fired, 3 fresh+unrelated left alone", async () => {
  const { task, provider, alerts } = makeTask();

  // Two stale tensol-test-* in the test folder (well past 30 min).
  provider.seedInstance(TEST_FOLDER, {
    id: "inst-test-stale-1",
    name: "tensol-test-aaa",
    createdAt: NOW - 45 * 60 * 1000, // 45 min ago
  });
  provider.seedInstance(TEST_FOLDER, {
    id: "inst-test-stale-2",
    name: "tensol-test-bbb",
    createdAt: NOW - 90 * 60 * 1000, // 90 min ago
  });

  // One stale tensol-scan-* in the prod folder (past 120 min).
  provider.seedInstance(PROD_FOLDER, {
    id: "inst-scan-stale-1",
    name: "tensol-scan-ccc",
    createdAt: NOW - 180 * 60 * 1000, // 180 min ago
  });

  // One FRESH tensol-test-* (under 30 min).
  provider.seedInstance(TEST_FOLDER, {
    id: "inst-test-fresh",
    name: "tensol-test-ddd",
    createdAt: NOW - 10 * 60 * 1000,
  });

  // One FRESH tensol-scan-* (under 120 min).
  provider.seedInstance(PROD_FOLDER, {
    id: "inst-scan-fresh",
    name: "tensol-scan-eee",
    createdAt: NOW - 60 * 60 * 1000,
  });

  // One unrelated-prefix instance (whatever its age, must be ignored).
  provider.seedInstance(PROD_FOLDER, {
    id: "inst-unrelated",
    name: "some-other-vm",
    createdAt: NOW - 999 * 60 * 1000,
  });

  const result = await task.tick(NOW);

  expect(result.deleted.sort()).toEqual(
    ["inst-test-stale-1", "inst-test-stale-2", "inst-scan-stale-1"].sort(),
  );
  expect(result.errors).toEqual([]);
  expect(result.scanned).toBe(6);

  // Exactly one alert, containing all three deleted ids.
  expect(alerts.length).toBe(1);
  expect(alerts[0]).toContain("3 deleted");
  expect(alerts[0]).toContain("inst-test-stale-1");
  expect(alerts[0]).toContain("inst-test-stale-2");
  expect(alerts[0]).toContain("inst-scan-stale-1");

  // The three orphans are gone from the provider's view; the three
  // non-orphans remain.
  const remainingTest = await provider.listInstances(TEST_FOLDER);
  const remainingProd = await provider.listInstances(PROD_FOLDER);
  const remainingIds = [
    ...remainingTest.map((i) => i.id),
    ...remainingProd.map((i) => i.id),
  ].sort();
  expect(remainingIds).toEqual(
    ["inst-test-fresh", "inst-scan-fresh", "inst-unrelated"].sort(),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2 — NO ORPHANS, NO ALERT
// ───────────────────────────────────────────────────────────────────────────
test("no orphans: 0 deleted, sendAlert never called", async () => {
  const { task, provider, alerts } = makeTask();

  // Fresh test instance.
  provider.seedInstance(TEST_FOLDER, {
    id: "inst-fresh-1",
    name: "tensol-test-fff",
    createdAt: NOW - 5 * 60 * 1000,
  });
  // Unrelated prefix in prod folder.
  provider.seedInstance(PROD_FOLDER, {
    id: "inst-other",
    name: "monitoring-server",
    createdAt: NOW - 24 * 60 * 60 * 1000,
  });

  const result = await task.tick(NOW);

  expect(result.deleted).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.scanned).toBe(2);
  expect(alerts.length).toBe(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3 — PARTIAL FAILURE
// ───────────────────────────────────────────────────────────────────────────
test("partial failure: one teardown throws → that id in errors, other deletes succeed, alert still fires", async () => {
  const { task, provider, alerts } = makeTask({
    teardownFailures: new Set(["inst-fail"]),
  });

  provider.seedInstance(TEST_FOLDER, {
    id: "inst-ok-1",
    name: "tensol-test-ok1",
    createdAt: NOW - 45 * 60 * 1000,
  });
  provider.seedInstance(TEST_FOLDER, {
    id: "inst-fail",
    name: "tensol-test-fail",
    createdAt: NOW - 60 * 60 * 1000,
  });
  provider.seedInstance(PROD_FOLDER, {
    id: "inst-ok-2",
    name: "tensol-scan-ok2",
    createdAt: NOW - 180 * 60 * 1000,
  });

  const result = await task.tick(NOW);

  expect(result.deleted.sort()).toEqual(["inst-ok-1", "inst-ok-2"].sort());
  expect(result.errors.length).toBe(1);
  expect(result.errors[0]).toContain("inst-fail");

  // Alert fires (2 deletions > 0).
  expect(alerts.length).toBe(1);
  expect(alerts[0]).toContain("2 deleted");
  expect(alerts[0]).toContain("1 errors");
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4 — PER-PREFIX MIN-AGE
// ───────────────────────────────────────────────────────────────────────────
test("per-prefix min-age: at 60 min old only tensol-test-* eligible (30 min grace), tensol-scan-* spared (120 min grace)", async () => {
  const { task, provider, alerts } = makeTask();

  const sixtyMinOld = NOW - 60 * 60 * 1000;

  provider.seedInstance(TEST_FOLDER, {
    id: "inst-test-60",
    name: "tensol-test-sixty",
    createdAt: sixtyMinOld,
  });
  provider.seedInstance(PROD_FOLDER, {
    id: "inst-scan-60",
    name: "tensol-scan-sixty",
    createdAt: sixtyMinOld,
  });

  const result = await task.tick(NOW);

  expect(result.deleted).toEqual(["inst-test-60"]);
  expect(result.errors).toEqual([]);

  // Alert fires once for the 1 deletion.
  expect(alerts.length).toBe(1);
  expect(alerts[0]).toContain("1 deleted");

  // The 60-min-old scan-prefixed VM still exists.
  const remaining = await provider.listInstances(PROD_FOLDER);
  expect(remaining.map((i) => i.id)).toEqual(["inst-scan-60"]);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5 — EMPTY FOLDER LIST
// ───────────────────────────────────────────────────────────────────────────
test("empty folder list: 0 scanned, 0 deleted, no alert (env not configured)", async () => {
  const { task, alerts } = makeTask({ folderIds: [] });

  const result = await task.tick(NOW);

  expect(result.deleted).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.scanned).toBe(0);
  expect(alerts.length).toBe(0);
});
