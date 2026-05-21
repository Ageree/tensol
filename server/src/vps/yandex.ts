/**
 * T043 — Real `CloudProvider` implementation against Yandex Cloud Compute.
 *
 * Per research §R4 (REST endpoints + async-operation pattern) and §R5
 * (IAM token caching). Wires together two pre-shipped helpers:
 *   - `getIamToken()` (T040 — `./yandex-iam.ts`)
 *   - `pollOperation()` (T041 — `./yandex-operations.ts`)
 *
 * The factory `createYandexCloudProvider(opts)` returns a `CloudProvider`
 * conforming object. All collaborators (`fetcher`, `getToken`, `pollOp`,
 * config) are dependency-injected so that integration tests (T046) can
 * stand up a deterministic in-memory Yandex without touching real
 * cloud endpoints.
 *
 * Constitution alignment:
 *   - I — does not touch `external/decepticon/`.
 *   - VI — no real-network calls in default test runs; production code uses
 *     the injected `fetcher` so tests stay offline.
 *   - VII — file aimed at ≤ 350 LOC (plan §"Yandex provider").
 *   - IX — no Zod here; the input contract is the `CloudProvider`
 *     TypeScript interface (this module is NOT a route handler).
 */

import { getIamToken } from "./yandex-iam";
import { pollOperation, type Operation } from "./yandex-operations";
import type {
  CloudProvider,
  OperationResult,
  SpawnVmInput,
  SpawnVmResult,
  VmInstanceSummary,
  VmStatus,
} from "./provider";

const COMPUTE_BASE_URL = "https://compute.api.cloud.yandex.net/compute/v1";

/**
 * Yandex Cloud Compute label keys/values must match `[a-z0-9_-]*`.
 * Lowercase + replace invalid chars with `_`. Both key AND value are
 * sanitised because Yandex enforces the same regex on both sides.
 *
 * Production bug (2026-05-21): ULIDs are Crockford-base32 (UPPERCASE) and
 * were passed raw via `labels: input.metadata ?? {}`, causing every
 * `instances.create` POST to return HTTP 400 with:
 *   "Labels: invalid label value \"01KS...\""
 * which silently broke every real scan in production.
 */
export function sanitizeLabels(
  input: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const keyClean = k.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const valClean = v.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    out[keyClean] = valClean;
  }
  return out;
}

/**
 * VM hardware / network shape. All fields are optional in the factory
 * input — missing values fall back to env vars and finally to safe MVP
 * defaults below (plan.md §"Yandex provider").
 */
export type YandexProviderConfig = {
  /** Yandex folder the VM is created in. Required (no safe default). */
  folderId: string;
  /** Availability zone, e.g. `ru-central1-a`. Default: `ru-central1-a`. */
  zoneId: string;
  /** Platform id (CPU generation), e.g. `standard-v3`. Default: `standard-v3`. */
  platformId: string;
  /** vCPU count. Default: 2. */
  cores: number;
  /** Memory in GiB. Default: 4. */
  memoryGB: number;
  /**
   * Boot disk image id (Ubuntu 22.04 LTS by default).
   * TODO: confirm the canonical Ubuntu 22.04 LTS image id from the Yandex
   * Cloud public catalog, or wire it via env (`YANDEX_BOOT_DISK_IMAGE_ID`).
   * The placeholder below is the well-known `standard-images` family id.
   */
  bootDiskImageId: string;
  /** Boot disk size in GiB. Default: 30. */
  bootDiskSizeGB: number;
  /** Network/subnet the primary NIC attaches to. */
  networkInterfaceSpec: {
    networkId: string;
    subnetId: string;
  };
  /**
   * SSH public key, format `ssh-rsa AAA…` or `ssh-ed25519 AAA…`. Injected
   * as `metadata.ssh-keys` so the cloud-init image grants Tensol operators
   * break-glass shell access. Empty string disables SSH-key injection.
   */
  sshPublicKey: string;
};

/**
 * Factory options. All sub-objects are optional — see field-level docs
 * on `YandexProviderConfig` for fallback chain. Callers in production
 * pass no args; tests inject `fetcher` + `getToken` + `pollOp` for
 * fully-offline operation.
 */
export type CreateYandexProviderOpts = {
  config?: Partial<YandexProviderConfig>;
  /** Override `globalThis.fetch` for tests. Defaults to `fetch`. */
  fetcher?: typeof fetch;
  /** Override the IAM token source for tests. Defaults to T040 helper. */
  getToken?: () => Promise<string>;
  /** Override the operation poller for tests. Defaults to T041 helper. */
  pollOp?: typeof pollOperation;
};

/**
 * Build a `CloudProvider` bound to Yandex Cloud Compute. Pure factory —
 * no side effects until a method is invoked.
 */
export function createYandexCloudProvider(
  opts: CreateYandexProviderOpts = {},
): CloudProvider {
  const fetcher = opts.fetcher ?? fetch;
  const getToken = opts.getToken ?? (() => getIamToken());
  const pollOp = opts.pollOp ?? pollOperation;
  const cfg = resolveConfig(opts.config);

  return {
    async spawnVm(input: SpawnVmInput): Promise<SpawnVmResult> {
      const body = buildInstanceCreateBody(cfg, input);
      const token = await getToken();
      const resp = await fetcher(`${COMPUTE_BASE_URL}/instances`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.scanId,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const detail = await readBodySafe(resp);
        throw new Error(
          `yandex spawnVm: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
        );
      }

      const op = (await resp.json()) as Operation;
      const meta = (op.metadata ?? {}) as { instanceId?: string };
      if (!meta.instanceId) {
        throw new Error(
          "yandex spawnVm: create operation response lacked metadata.instanceId",
        );
      }

      // Block until the create-op is done so callers can rely on
      // `getStatus(instanceId)` returning a populated network interface.
      const final = await pollOp(op.id, { getToken });
      if (final.error) {
        throw new Error(
          `yandex spawnVm op failed: ${JSON.stringify(final.error)}`,
        );
      }

      // Read fresh status to surface the public IPv4 (only attached once
      // the operation completes, per research §R4).
      const status = await readStatus(fetcher, getToken, meta.instanceId);
      const result: SpawnVmResult = {
        instanceId: meta.instanceId,
        operationId: op.id,
      };
      return status.publicIp
        ? { ...result, publicIp: status.publicIp }
        : result;
    },

    async teardownVm(instanceId: string): Promise<{ operationId?: string }> {
      const token = await getToken();
      const resp = await fetcher(
        `${COMPUTE_BASE_URL}/instances/${encodeURIComponent(instanceId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (resp.status === 404) {
        // Idempotent: instance is already gone.
        return {};
      }
      if (!resp.ok) {
        const detail = await readBodySafe(resp);
        throw new Error(
          `yandex teardownVm: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
        );
      }
      const op = (await resp.json()) as Operation;
      // Return the op handle so the caller's reaper job can poll for
      // terminal completion without blocking the inline request.
      return { operationId: op.id };
    },

    async getStatus(instanceId: string): Promise<VmStatus> {
      return readStatus(fetcher, getToken, instanceId);
    },

    async pollOperation(operationId: string): Promise<OperationResult> {
      const op = await pollOp(operationId, { getToken });
      const base: OperationResult = {
        operationId,
        done: op.done,
      };
      const withError = op.error
        ? { ...base, error: op.error.message }
        : base;
      // The provider-agnostic OperationResult is currently typed as
      // `SpawnVmResult | { teardownComplete: true }`. We only attach the
      // structured result for the success path; spawn-vs-teardown
      // discrimination is the caller's job (each call site knows which
      // op kind it submitted).
      if (op.done && !op.error && op.response) {
        return { ...withError, result: op.response as SpawnVmResult };
      }
      return withError;
    },

    async listInstances(folderId: string): Promise<VmInstanceSummary[]> {
      // GET /compute/v1/instances?folderId=<...> per research §R10.
      // Yandex paginates via `pageToken`; we follow the chain until the
      // response omits a `nextPageToken`. Page size is left to Yandex's
      // default (≤ 1000 per page) — orphan folders never approach that.
      const token = await getToken();
      const out: VmInstanceSummary[] = [];
      let pageToken: string | undefined;
      // Safety ceiling so a misconfigured server can't paginate forever.
      const MAX_PAGES = 50;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(`${COMPUTE_BASE_URL}/instances`);
        url.searchParams.set("folderId", folderId);
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        const resp = await fetcher(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
          const detail = await readBodySafe(resp);
          throw new Error(
            `yandex listInstances: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
          );
        }
        const body = (await resp.json()) as {
          instances?: Array<{
            id?: string;
            name?: string;
            createdAt?: string;
          }>;
          nextPageToken?: string;
        };
        const rows = body.instances ?? [];
        for (const r of rows) {
          if (!r.id || !r.name) continue;
          const createdAtMs = parseRfc3339Ms(r.createdAt);
          if (createdAtMs === null) continue;
          out.push({
            id: r.id,
            name: r.name,
            createdAt: createdAtMs,
          });
        }
        if (!body.nextPageToken) break;
        pageToken = body.nextPageToken;
      }
      return out;
    },
  };
}

/**
 * Parse Yandex's RFC3339 `createdAt` string into unix ms. Returns null on
 * malformed input — the caller skips that row rather than abort the sweep.
 * Yandex emits e.g. `2024-01-02T15:04:05.123456789Z`; `new Date()` handles
 * up to millisecond precision, which is enough for the 30-min grace window.
 */
function parseRfc3339Ms(s: string | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Merge user-supplied config with env-var fallbacks and built-in defaults.
 * Throws if `folderId` is unresolvable — every other field has a safe
 * fallback that lets tests construct a provider without env setup.
 */
function resolveConfig(
  override: Partial<YandexProviderConfig> | undefined,
): YandexProviderConfig {
  const folderId =
    override?.folderId ?? process.env.YANDEX_PROD_FOLDER_ID ?? "";
  if (!folderId) {
    throw new Error(
      "yandex provider: folderId is required (YANDEX_PROD_FOLDER_ID env or opts.config.folderId)",
    );
  }
  const networkId =
    override?.networkInterfaceSpec?.networkId ??
    process.env.YANDEX_PROD_NETWORK_ID ??
    "";
  const subnetId =
    override?.networkInterfaceSpec?.subnetId ??
    process.env.YANDEX_PROD_SUBNET_ID ??
    "";

  return {
    folderId,
    zoneId:
      override?.zoneId ??
      process.env.YANDEX_PROD_SUBNET_ZONE ??
      "ru-central1-a",
    platformId: override?.platformId ?? "standard-v3",
    cores: override?.cores ?? 2,
    memoryGB: override?.memoryGB ?? 4,
    bootDiskImageId:
      override?.bootDiskImageId ??
      process.env.YANDEX_BOOT_DISK_IMAGE_ID ??
      // Ubuntu 22.04 LTS placeholder — verify against the live catalog
      // before nightly real-Yandex smoke (TODO above).
      "fd8nl4lp3frl63ds9ssn",
    bootDiskSizeGB: override?.bootDiskSizeGB ?? 30,
    networkInterfaceSpec: { networkId, subnetId },
    sshPublicKey:
      override?.sshPublicKey ?? process.env.YANDEX_PROD_SSH_PUBLIC_KEY ?? "",
  };
}

/**
 * Shape of the `POST /compute/v1/instances` request body
 * (Yandex Compute "Create instance" API — REST surface).
 */
type InstanceCreateBody = {
  folderId: string;
  name: string;
  description: string;
  zoneId: string;
  platformId: string;
  resourcesSpec: { cores: number; memory: number };
  bootDiskSpec: {
    autoDelete: boolean;
    diskSpec: {
      typeId: string;
      size: number;
      imageId: string;
    };
  };
  networkInterfaceSpecs: Array<{
    subnetId: string;
    primaryV4AddressSpec: { oneToOneNatSpec: { ipVersion: "IPV4" } };
  }>;
  metadata: Record<string, string>;
  labels: Record<string, string>;
};

function buildInstanceCreateBody(
  cfg: YandexProviderConfig,
  input: SpawnVmInput,
): InstanceCreateBody {
  // Yandex name regex: `[a-z][-a-z0-9]{1,61}[a-z0-9]`. ULIDs are
  // upper-case Crockford-base32 — lowercase them and prefix with `tensol-`.
  const safeName = `tensol-scan-${input.scanId.toLowerCase()}`.slice(0, 63);
  const sshKeyEntry: Record<string, string> = cfg.sshPublicKey
    ? { "ssh-keys": `tensol:${cfg.sshPublicKey}` }
    : {};

  return {
    folderId: cfg.folderId,
    name: safeName,
    description: `Tensol blackbox scan ${input.scanId}`,
    zoneId: cfg.zoneId,
    platformId: cfg.platformId,
    resourcesSpec: {
      cores: cfg.cores,
      memory: cfg.memoryGB * 1024 * 1024 * 1024,
    },
    bootDiskSpec: {
      autoDelete: true,
      diskSpec: {
        typeId: "network-ssd",
        size: cfg.bootDiskSizeGB * 1024 * 1024 * 1024,
        imageId: cfg.bootDiskImageId,
      },
    },
    networkInterfaceSpecs: [
      {
        subnetId: cfg.networkInterfaceSpec.subnetId,
        primaryV4AddressSpec: { oneToOneNatSpec: { ipVersion: "IPV4" } },
      },
    ],
    metadata: {
      "user-data": input.userData,
      ...sshKeyEntry,
    },
    labels: sanitizeLabels(input.metadata ?? {}),
  };
}

/**
 * Maps Yandex's instance-lifecycle enum to the provider-agnostic
 * `VmStatus['status']` union. Unknown / unmapped values bubble up as
 * `"error"` so the caller can surface them in the UI.
 */
function mapInstanceStatus(yandexStatus: string): VmStatus["status"] {
  const s = (yandexStatus ?? "").toUpperCase();
  if (s === "PROVISIONING" || s === "STARTING" || s === "CREATING") {
    return "provisioning";
  }
  if (s === "RUNNING") return "running";
  if (s === "STOPPING") return "stopping";
  if (s === "STOPPED" || s === "DELETING" || s === "DELETED") return "stopped";
  return "error";
}

/**
 * `GET /compute/v1/instances/{id}` — read instance state + primary IP.
 * Extracted so `spawnVm` can also call it after the create-op resolves.
 */
async function readStatus(
  fetcher: typeof fetch,
  getToken: () => Promise<string>,
  instanceId: string,
): Promise<VmStatus> {
  const token = await getToken();
  const resp = await fetcher(
    `${COMPUTE_BASE_URL}/instances/${encodeURIComponent(instanceId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (resp.status === 404) {
    // Per `CloudProvider.getStatus` JSDoc, unknown ids should throw — but
    // 404 here means "previously existed, now reaped"; we surface as
    // `stopped` so the scan runner's reaper can complete cleanly without
    // distinguishing already-gone vs never-existed.
    return { instanceId, status: "stopped" };
  }
  if (!resp.ok) {
    const detail = await readBodySafe(resp);
    throw new Error(
      `yandex getStatus: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
    );
  }

  const inst = (await resp.json()) as {
    id?: string;
    status?: string;
    networkInterfaces?: Array<{
      primaryV4Address?: {
        address?: string;
        oneToOneNat?: { address?: string };
      };
    }>;
  };

  const status = mapInstanceStatus(inst.status ?? "");
  const nic = inst.networkInterfaces?.[0]?.primaryV4Address;
  const publicIp = nic?.oneToOneNat?.address ?? nic?.address;

  const base: VmStatus = { instanceId, status };
  return publicIp ? { ...base, publicIp } : base;
}

async function readBodySafe(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
