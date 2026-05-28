/**
 * T023 — Tests for the deterministic in-memory `FakeCloudProvider`.
 *
 * Written before the implementation per Constitution VI (TDD: Red → Green).
 * The fake is the default test fixture for CloudProvider-consuming code;
 * the real GCP provider is never exercised in tests.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { FakeCloudProvider } from "./fake-provider";

describe("FakeCloudProvider — spawnVm", () => {
  let provider: FakeCloudProvider;
  beforeEach(() => {
    provider = new FakeCloudProvider();
  });

  test("returns deterministic instanceId (counter-based, starts at 1)", async () => {
    const r1 = await provider.spawnVm({ scanId: "01J0000000000000000000A001", userData: "#!/bin/bash\necho a" });
    const r2 = await provider.spawnVm({ scanId: "01J0000000000000000000A002", userData: "#!/bin/bash\necho b" });
    expect(r1.instanceId).toBe("fake-vm-1");
    expect(r2.instanceId).toBe("fake-vm-2");
  });

  test("returns an operationId paired with the spawn", async () => {
    const r = await provider.spawnVm({ scanId: "S1", userData: "x" });
    expect(typeof r.operationId).toBe("string");
    expect(r.operationId!.length).toBeGreaterThan(0);
  });

  test("accepts arbitrary userData without parsing it (passes through)", async () => {
    // Both bash and yaml shapes — the fake never inspects content.
    const r1 = await provider.spawnVm({ scanId: "S1", userData: "#!/bin/bash\nrm -rf /" });
    const r2 = await provider.spawnVm({ scanId: "S2", userData: "#cloud-config\nruncmd:\n- ls" });
    expect(r1.instanceId).toBe("fake-vm-1");
    expect(r2.instanceId).toBe("fake-vm-2");
  });

  test("accepts optional metadata without inspecting it", async () => {
    const r = await provider.spawnVm({
      scanId: "S1",
      userData: "x",
      metadata: { owner: "tensol", env: "test" },
    });
    expect(r.instanceId).toBe("fake-vm-1");
  });
});

describe("FakeCloudProvider — getStatus lifecycle", () => {
  let provider: FakeCloudProvider;
  beforeEach(() => {
    provider = new FakeCloudProvider();
  });

  test("immediately after spawn, status is 'provisioning' (no publicIp yet)", async () => {
    const spawn = await provider.spawnVm({ scanId: "S1", userData: "x" });
    const status = await provider.getStatus(spawn.instanceId);
    expect(status.status).toBe("provisioning");
    expect(status.publicIp).toBeUndefined();
    expect(status.instanceId).toBe(spawn.instanceId);
  });

  test("after pollOperation resolves spawn, status flips to 'running' with synthetic publicIp", async () => {
    const spawn = await provider.spawnVm({ scanId: "S1", userData: "x" });
    const op = await provider.pollOperation(spawn.operationId!);
    expect(op.done).toBe(true);
    expect(op.error).toBeUndefined();

    const status = await provider.getStatus(spawn.instanceId);
    expect(status.status).toBe("running");
    expect(status.publicIp).toBeDefined();
    // Synthetic IP must be deterministic — derived from instance index.
    expect(status.publicIp).toMatch(/^10\.0\.0\.\d+$/);
  });

  test("getStatus on unknown instanceId throws", async () => {
    await expect(provider.getStatus("fake-vm-999")).rejects.toThrow();
  });
});

describe("FakeCloudProvider — teardownVm", () => {
  let provider: FakeCloudProvider;
  beforeEach(() => {
    provider = new FakeCloudProvider();
  });

  test("teardownVm transitions running VM through 'stopping' then 'stopped'", async () => {
    const spawn = await provider.spawnVm({ scanId: "S1", userData: "x" });
    await provider.pollOperation(spawn.operationId!); // → running
    const teardown = await provider.teardownVm(spawn.instanceId);
    expect(teardown.operationId).toBeDefined();

    const midStatus = await provider.getStatus(spawn.instanceId);
    expect(midStatus.status).toBe("stopping");

    const op = await provider.pollOperation(teardown.operationId!);
    expect(op.done).toBe(true);
    expect(op.result).toEqual({ teardownComplete: true });

    const finalStatus = await provider.getStatus(spawn.instanceId);
    expect(finalStatus.status).toBe("stopped");
  });

  test("teardownVm on already-stopped VM is idempotent (resolves, no throw)", async () => {
    const spawn = await provider.spawnVm({ scanId: "S1", userData: "x" });
    await provider.pollOperation(spawn.operationId!);
    const t1 = await provider.teardownVm(spawn.instanceId);
    await provider.pollOperation(t1.operationId!);
    // Re-teardown — must not throw.
    await expect(provider.teardownVm(spawn.instanceId)).resolves.toBeDefined();
  });

  test("teardownVm on unknown instanceId is idempotent (resolves, no throw)", async () => {
    await expect(provider.teardownVm("fake-vm-doesnt-exist")).resolves.toBeDefined();
  });
});

describe("FakeCloudProvider — pollOperation", () => {
  let provider: FakeCloudProvider;
  beforeEach(() => {
    provider = new FakeCloudProvider();
  });

  test("unknown operationId returns { done: false } (per CloudProvider contract)", async () => {
    const op = await provider.pollOperation("op-never-existed");
    expect(op.done).toBe(false);
    expect(op.operationId).toBe("op-never-existed");
  });

  test("polling a completed spawn op returns SpawnVmResult", async () => {
    const spawn = await provider.spawnVm({ scanId: "S1", userData: "x" });
    const op = await provider.pollOperation(spawn.operationId!);
    expect(op.done).toBe(true);
    expect(op.result).toMatchObject({ instanceId: spawn.instanceId });
  });

  test("polling the same op twice is idempotent (stable result)", async () => {
    const spawn = await provider.spawnVm({ scanId: "S1", userData: "x" });
    const a = await provider.pollOperation(spawn.operationId!);
    const b = await provider.pollOperation(spawn.operationId!);
    expect(a).toEqual(b);
  });
});

describe("FakeCloudProvider — isolation", () => {
  test("two fakes operate independently (no shared/global state)", async () => {
    const a = new FakeCloudProvider();
    const b = new FakeCloudProvider();
    const ra = await a.spawnVm({ scanId: "S1", userData: "x" });
    const rb = await b.spawnVm({ scanId: "S1", userData: "x" });
    // Both should report fake-vm-1 (counters are per-instance, not global).
    expect(ra.instanceId).toBe("fake-vm-1");
    expect(rb.instanceId).toBe("fake-vm-1");
    // And A should not know about B's instance.
    await expect(a.getStatus(rb.instanceId)).resolves.toMatchObject({
      instanceId: rb.instanceId,
    });
    // Above only passes because both happen to share an id namespace — but
    // verify the two instances are genuinely separate by checking that A
    // has only one tracked VM (introspected via getStatus on a 2nd never-spawned id).
    await expect(a.getStatus("fake-vm-2")).rejects.toThrow();
  });

  test("reset() clears all state — counter restarts, completed ops dropped", async () => {
    const provider = new FakeCloudProvider();
    const r1 = await provider.spawnVm({ scanId: "S1", userData: "x" });
    expect(r1.instanceId).toBe("fake-vm-1");
    // Resolve op so it lands in the completed-ops cache.
    await provider.pollOperation(r1.operationId!);
    const status = await provider.getStatus(r1.instanceId);
    expect(status.status).toBe("running");

    provider.reset();
    // Counter restarts.
    const r2 = await provider.spawnVm({ scanId: "S2", userData: "x" });
    expect(r2.instanceId).toBe("fake-vm-1");
    // Brand-new instance must be 'provisioning' (cached "running" from r1 cleared).
    const status2 = await provider.getStatus(r2.instanceId);
    expect(status2.status).toBe("provisioning");
    expect(status2.publicIp).toBeUndefined();
  });
});
