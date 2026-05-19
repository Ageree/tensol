/**
 * VPS provider abstract interfaces.
 *
 * Two surfaces live here:
 *
 *   1. Legacy `VpsProvider` (T037 — Hetzner-era, sync `spawn/destroy/getStatus`).
 *      Consumed by `./hetzner.ts`. Will be retired alongside the Hetzner
 *      backend (Constitution «УДАЛИ + СОЗДАЙ»).
 *
 *   2. `CloudProvider` (T021 — 002-blackbox-mvp). Async-operation-aware
 *      surface for Yandex Cloud Compute (per research.md §R4). Yandex's REST
 *      API returns long-running `Operation` objects that must be polled until
 *      `done: true` — hence the explicit `pollOperation` method and the
 *      richer status enum (`provisioning` / `running` / `stopping` /
 *      `stopped` / `error`).
 *
 * Both interfaces coexist until the legacy Hetzner path is fully removed in
 * a later phase. Concrete `CloudProvider` implementations: `./yandex.ts`
 * (real) and `./fake-provider.ts` (deterministic in-memory, default test
 * fixture per Constitution VI).
 */

// ---------------------------------------------------------------------------
// Legacy (T037, Hetzner). Kept verbatim so `./hetzner.ts` still compiles.
// ---------------------------------------------------------------------------

export type SpawnVpsArgs = {
  /** Scan ULID — used as a stable name suffix on the provider side. */
  scanId: string;
  /** HMAC key the spawned vps-agent uses to sign webhook callbacks. */
  signKey: string;
};

export type SpawnedVps = {
  /** Opaque provider-side server identifier (Hetzner: numeric, but string here). */
  provider_server_id: string;
  /** Public IPv4 the agent will reach back from. */
  ipv4: string;
};

export type VpsStatus =
  | "initializing"
  | "running"
  | "stopped"
  | "destroyed"
  | "unknown";

export type VpsProvider = {
  spawnVps(args: SpawnVpsArgs): Promise<SpawnedVps>;
  getVpsStatus(provider_server_id: string): Promise<VpsStatus>;
  /**
   * Idempotent: must resolve (no throw) if the server is already gone (404).
   * Caller (scan runner) is responsible for retry-with-backoff on 5xx.
   */
  destroyVps(provider_server_id: string): Promise<void>;
};

// ---------------------------------------------------------------------------
// T021 — CloudProvider (002-blackbox-mvp, Yandex-shaped async ops).
// Per research.md §R4: Yandex compute returns `Operation` objects; callers
// poll `GET /operations/{id}` until `done: true`. Status enum mirrors Yandex
// instance lifecycle (`PROVISIONING` / `RUNNING` / `STOPPING` / `STOPPED` /
// `ERROR`), lowercased to match repository convention.
// ---------------------------------------------------------------------------

/** Argument bag for `CloudProvider.spawnVm`. */
export type SpawnVmInput = {
  /**
   * Scan-order ULID. Used both as the idempotency-key value (Yandex
   * dedupes within a 24h window) and as the VM name suffix.
   */
  scanId: string;
  /**
   * Cloud-init script body (raw bash or `#cloud-config` YAML). The provider
   * does not parse or validate this — it is passed verbatim to the
   * cloud-vendor `user_data` field. Per research.md §R11, the script is
   * unit-tested separately at the renderer layer.
   */
  userData: string;
  /**
   * Optional vendor-side labels / metadata. Yandex accepts up to 64
   * key/value pairs per instance. Used by the orphan-cleanup cron
   * (research R10) to locate Tensol-owned VMs.
   */
  metadata?: Record<string, string>;
};

/**
 * Synchronous return shape from `spawnVm`. The VM is NOT yet running at
 * this point — `operationId` lets the caller poll for the running state.
 * `publicIp` may be undefined until the operation resolves.
 */
export type SpawnVmResult = {
  /** Provider-side instance identifier (Yandex compute UUID). */
  instanceId: string;
  /**
   * Async operation handle. Caller polls via `pollOperation(operationId)`
   * until `done: true`. Undefined only if the provider returned a fully
   * synchronous result (uncommon, fake-provider may do this for tests).
   */
  operationId?: string;
  /** Public IPv4. Populated post-`running` transition; undefined earlier. */
  publicIp?: string;
};

/** Status read by `CloudProvider.getStatus`. */
export type VmStatus = {
  instanceId: string;
  status:
    | "provisioning"
    | "running"
    | "stopping"
    | "stopped"
    | "error";
  publicIp?: string;
  /** Populated only when `status === "error"`. */
  errorMessage?: string;
};

/**
 * Result of polling a long-running operation.
 *
 * `done: false` means the operation is still pending — caller backs off
 * and re-polls (research R4: exponential 1→2→4→max 8 seconds, 10-minute
 * ceiling). `done: true` with `error` populated means the operation
 * terminated unsuccessfully; with `result` populated means success.
 */
export type OperationResult = {
  operationId: string;
  done: boolean;
  /** Set only when `done && error` — structured Yandex error message. */
  error?: string;
  /**
   * Set only when `done && !error`. Discriminated by op kind:
   *   - spawn → `SpawnVmResult`
   *   - teardown → `{ teardownComplete: true }`
   */
  result?: SpawnVmResult | { teardownComplete: true };
};

/**
 * Provider-agnostic abstraction over the ephemeral-VM lifecycle.
 *
 * Concrete impls:
 *   - `./yandex.ts` — real Yandex Cloud Compute, gated behind
 *     `TENSOL_TEST_REAL_YANDEX=1` per Constitution VI.
 *   - `./fake-provider.ts` — deterministic in-memory, default test fixture.
 */
export type CloudProvider = {
  /**
   * Provision a new VM. Returns immediately with the instance id + an
   * operation handle to poll. Yandex-side idempotency is keyed on
   * `input.scanId` (24h dedup window per R4).
   */
  spawnVm(input: SpawnVmInput): Promise<SpawnVmResult>;
  /**
   * Initiate VM teardown. Returns immediately with an optional operation
   * handle; caller polls for completion. Idempotent: tearing down an
   * already-gone instance MUST resolve (no throw).
   */
  teardownVm(instanceId: string): Promise<{ operationId?: string }>;
  /**
   * Read current VM status. MUST throw / reject for unknown instanceIds
   * (caller distinguishes "404 / never existed" from "exists but errored").
   */
  getStatus(instanceId: string): Promise<VmStatus>;
  /**
   * Poll the status of a long-running operation. Unknown operationIds
   * MUST be reported as `{ done: false }` (caller treats as pending and
   * may retry, or may eventually time out per R4's 10-minute ceiling).
   */
  pollOperation(operationId: string): Promise<OperationResult>;
};
