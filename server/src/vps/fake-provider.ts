/**
 * T022 — Deterministic in-memory `CloudProvider` for tests.
 *
 * Constitution VI (NON-NEGOTIABLE): the real cloud provider (GCP) is never
 * exercised in tests; this fake is the default test fixture
 * for every unit / integration test that touches the VM lifecycle.
 *
 * Design choices:
 *   - **No global state.** All counters and maps live on the instance, so
 *     parallel `bun test` workers cannot leak ids between suites.
 *   - **Deterministic ids.** `fake-vm-1`, `fake-vm-2`, … per-instance.
 *     `fake-op-spawn-1`, `fake-op-tear-1`, … per-instance.
 *   - **Synthetic IP scheme.** `10.0.0.<n>` where `<n>` is the VM index.
 *   - **Immediate poll resolution.** `pollOperation` flips state on first
 *     call (no artificial latency); tests that need a "still pending" state
 *     should construct that scenario via never-spawned op ids.
 *   - **No `Math.random`, no `Date.now()`** in id generation — every input
 *     produces the same outputs.
 *
 * Per Constitution IX (Zod at boundaries): not a route handler, no Zod
 * here — interface contract enforced by TypeScript.
 */

import type {
  CloudProvider,
  OperationResult,
  SpawnVmInput,
  SpawnVmResult,
  VmInstanceSummary,
  VmStatus,
} from "./provider";

type InstanceState = {
  instanceId: string;
  status: VmStatus["status"];
  publicIp?: string;
  index: number;
  /** Optional human-meaningful name (for orphan-cleanup tests). */
  name?: string;
  /** Optional unix-ms creation time (for orphan-cleanup tests). */
  createdAt?: number;
  /** Optional folder id (for orphan-cleanup tests). */
  folderId?: string;
};

type PendingOp =
  | { kind: "spawn"; instanceId: string }
  | { kind: "teardown"; instanceId: string };

/** Test-only seed payload for `seedInstance`. */
export type FakeSeedInstance = {
  readonly id: string;
  readonly name: string;
  /** Unix milliseconds. */
  readonly createdAt: number;
  readonly status?: VmStatus["status"];
};

export class FakeCloudProvider implements CloudProvider {
  #counter = 0;
  #opCounter = 0;
  #instances = new Map<string, InstanceState>();
  #pendingOps = new Map<string, PendingOp>();
  #completedOps = new Map<string, OperationResult>();
  /** Folder → set of instance ids (test-only, for `listInstances`). */
  #folderIndex = new Map<string, Set<string>>();

  async spawnVm(_input: SpawnVmInput): Promise<SpawnVmResult> {
    const nextCounter = this.#counter + 1;
    const instanceId = `fake-vm-${nextCounter}`;
    const opId = `fake-op-spawn-${this.#opCounter + 1}`;

    const instance: InstanceState = {
      instanceId,
      status: "provisioning",
      index: nextCounter,
    };

    // Immutable-style "update" of internal maps (we create-or-replace, never
    // mutate the InstanceState object once a poll has resolved it).
    this.#instances.set(instanceId, instance);
    this.#pendingOps.set(opId, { kind: "spawn", instanceId });

    this.#counter = nextCounter;
    this.#opCounter += 1;

    return { instanceId, operationId: opId };
  }

  async teardownVm(instanceId: string): Promise<{ operationId?: string }> {
    const current = this.#instances.get(instanceId);
    if (!current) {
      // Idempotent on unknown / already-gone instance per CloudProvider contract.
      return {};
    }
    if (current.status === "stopped") {
      // Already torn down — idempotent no-op.
      return {};
    }

    const opId = `fake-op-tear-${this.#opCounter + 1}`;
    this.#opCounter += 1;

    // Transition to "stopping" (new state object — no mutation of `current`).
    const stopping: InstanceState = { ...current, status: "stopping" };
    this.#instances.set(instanceId, stopping);
    this.#pendingOps.set(opId, { kind: "teardown", instanceId });

    // For seeded instances (which carry a folder), remove from folder index
    // immediately so `listInstances` reflects the teardown intent. Production
    // GCP behaves the same — a DELETE call removes the row from the
    // list endpoint even though the operation is still in flight.
    if (current.folderId) {
      const ids = this.#folderIndex.get(current.folderId);
      if (ids) {
        ids.delete(instanceId);
        if (ids.size === 0) this.#folderIndex.delete(current.folderId);
        else this.#folderIndex.set(current.folderId, ids);
      }
    }

    return { operationId: opId };
  }

  async getStatus(instanceId: string): Promise<VmStatus> {
    const current = this.#instances.get(instanceId);
    if (!current) {
      throw new Error(`FakeCloudProvider: unknown instanceId '${instanceId}'`);
    }
    // Conditionally include `publicIp` to satisfy `exactOptionalPropertyTypes`.
    const base: VmStatus = {
      instanceId: current.instanceId,
      status: current.status,
    };
    return current.publicIp ? { ...base, publicIp: current.publicIp } : base;
  }

  async pollOperation(operationId: string): Promise<OperationResult> {
    // Already-completed op → stable replay (idempotent polling).
    const cached = this.#completedOps.get(operationId);
    if (cached) {
      return cached;
    }

    const pending = this.#pendingOps.get(operationId);
    if (!pending) {
      // Unknown op — per CloudProvider contract: { done: false }, caller may retry.
      return { operationId, done: false };
    }

    const inst = this.#instances.get(pending.instanceId);
    if (!inst) {
      // Defensive: should not happen, but treat as terminal error.
      const errored: OperationResult = {
        operationId,
        done: true,
        error: `instance '${pending.instanceId}' vanished before op resolved`,
      };
      this.#pendingOps.delete(operationId);
      this.#completedOps.set(operationId, errored);
      return errored;
    }

    if (pending.kind === "spawn") {
      const publicIp = `10.0.0.${inst.index}`;
      const running: InstanceState = {
        ...inst,
        status: "running",
        publicIp,
      };
      this.#instances.set(inst.instanceId, running);
      const result: OperationResult = {
        operationId,
        done: true,
        result: {
          instanceId: inst.instanceId,
          operationId,
          publicIp,
        },
      };
      this.#pendingOps.delete(operationId);
      this.#completedOps.set(operationId, result);
      return result;
    }

    // pending.kind === "teardown"
    // Drop publicIp by destructuring (rather than setting to undefined, which
    // violates `exactOptionalPropertyTypes`).
    const { publicIp: _drop, ...rest } = inst;
    const stopped: InstanceState = { ...rest, status: "stopped" };
    this.#instances.set(inst.instanceId, stopped);
    const result: OperationResult = {
      operationId,
      done: true,
      result: { teardownComplete: true },
    };
    this.#pendingOps.delete(operationId);
    this.#completedOps.set(operationId, result);
    return result;
  }

  /**
   * Enumerate seeded instances in a folder. Per `CloudProvider.listInstances`
   * contract: empty array for unknown / empty folders, never throws.
   *
   * Note: ONLY instances added via `seedInstance` are listed — the
   * lifecycle-generated `fake-vm-<n>` instances from `spawnVm` do not
   * have an associated folder and are intentionally excluded. This
   * matches the orphan-cleanup contract: cleanup scans cloud-side state,
   * not internal lifecycle bookkeeping.
   */
  async listInstances(folderId: string): Promise<VmInstanceSummary[]> {
    const ids = this.#folderIndex.get(folderId);
    if (!ids) return [];
    const out: VmInstanceSummary[] = [];
    for (const id of ids) {
      const inst = this.#instances.get(id);
      if (!inst) continue;
      if (inst.name === undefined || inst.createdAt === undefined) continue;
      out.push({ id, name: inst.name, createdAt: inst.createdAt });
    }
    return out;
  }

  /**
   * Test-only: insert a pre-existing instance into the fake's internal state
   * so `listInstances(folderId)` will return it. Used by the orphan-cleanup
   * tests (T124) — production code paths never call this. Not part of
   * `CloudProvider`.
   */
  seedInstance(folderId: string, seed: FakeSeedInstance): void {
    const inst: InstanceState = {
      instanceId: seed.id,
      status: seed.status ?? "running",
      index: this.#counter + 1,
      name: seed.name,
      createdAt: seed.createdAt,
      folderId,
    };
    this.#instances.set(seed.id, inst);
    const ids = this.#folderIndex.get(folderId) ?? new Set<string>();
    ids.add(seed.id);
    this.#folderIndex.set(folderId, ids);
    this.#counter += 1;
  }

  /** Test-only: clear all internal state. Not part of `CloudProvider`. */
  reset(): void {
    this.#counter = 0;
    this.#opCounter = 0;
    this.#instances.clear();
    this.#pendingOps.clear();
    this.#completedOps.clear();
    this.#folderIndex.clear();
  }
}
