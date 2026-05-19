/**
 * T022 — Deterministic in-memory `CloudProvider` for tests.
 *
 * Constitution VI (NON-NEGOTIABLE): real cloud providers (Yandex) are gated
 * behind `TENSOL_TEST_REAL_YANDEX=1`; this fake is the default test fixture
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
  VmStatus,
} from "./provider";

type InstanceState = {
  instanceId: string;
  status: VmStatus["status"];
  publicIp?: string;
  index: number;
};

type PendingOp =
  | { kind: "spawn"; instanceId: string }
  | { kind: "teardown"; instanceId: string };

export class FakeCloudProvider implements CloudProvider {
  #counter = 0;
  #opCounter = 0;
  #instances = new Map<string, InstanceState>();
  #pendingOps = new Map<string, PendingOp>();
  #completedOps = new Map<string, OperationResult>();

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

  /** Test-only: clear all internal state. Not part of `CloudProvider`. */
  reset(): void {
    this.#counter = 0;
    this.#opCounter = 0;
    this.#instances.clear();
    this.#pendingOps.clear();
    this.#completedOps.clear();
  }
}
