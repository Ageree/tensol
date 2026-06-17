/**
 * GCP Compute Engine `CloudProvider` implementation.
 *
 * Factory + DI, raw fetch + REST API, no SDK.
 * Auth via `google-auth-library` reading the SA JSON at
 * `GOOGLE_APPLICATION_CREDENTIALS` (e.g. `server/.gcp/tensol-vm-spawner.json`).
 *
 * Lessons carried over from GCP migration era (memory 2026-05-21):
 *  - sanitizeLabels: GCP labels match `[a-z0-9_-]*` like GCP; ULIDs are
 *    uppercase Crockford-base32 and must be lowercased or `instances.insert`
 *    returns HTTP 400.
 *  - instance name regex: GCP requires lowercase letters, digits, hyphens,
 *    must start with a letter, max 63 chars — same shape as GCP.
 *  - Idempotency: GCP uses `requestId` query param (UUID v4) — we derive a
 *    deterministic UUID from scanId via SHA-256 truncation so retries dedup.
 *
 * GCP-specific differences from GCP:
 *  - Endpoint: https://compute.googleapis.com/compute/v1
 *  - URL is project+zone-scoped: /projects/{proj}/zones/{zone}/instances
 *  - Operations live on the zone too: /projects/{proj}/zones/{zone}/operations/{op}
 *  - Status enum: PROVISIONING / STAGING / RUNNING / STOPPING / TERMINATED
 *  - Public IPv4: networkInterfaces[0].accessConfigs[0].natIP
 *  - Auth: OAuth2 bearer from SA JSON (cleaner than GCP's IAM JWT exchange)
 */

import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

import type {
  CloudProvider,
  OperationResult,
  SpawnVmInput,
  SpawnVmResult,
  VmInstanceSummary,
  VmStatus,
} from "./provider";

const COMPUTE_BASE_URL = "https://compute.googleapis.com/compute/v1";
const DEFAULT_OAUTH_SCOPE = "https://www.googleapis.com/auth/compute";
const DEFAULT_VM_SERVICE_ACCOUNT_SCOPES = [
  "https://www.googleapis.com/auth/devstorage.read_write",
];
const DEFAULT_OP_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OP_POLL_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * GCP label keys/values must match `[a-z0-9_-]*` (and key must start with a
 * letter, but `_` prefix is fine for values). We lowercase and replace
 * invalid chars — same defensive sanitization the now-removed GCP provider used.
 */
export function sanitizeLabels(
  input: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const keyClean = k.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const valClean = v.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    out[keyClean] = valClean.slice(0, 63);
  }
  return out;
}

export type GcpProviderConfig = {
  /** Project id (e.g. tensol-scanners). */
  projectId: string;
  /** Zone, e.g. europe-west1-b. */
  zone: string;
  /** Machine type id, e.g. e2-standard-2 (2 vCPU / 8 GiB). */
  machineType: string;
  /** Full source-image URL or family path. */
  bootDiskImage: string;
  /** Boot disk size in GiB. */
  bootDiskSizeGB: number;
  /** Network name (default: "default"). */
  networkName: string;
  /** Subnet name (default: "default"). */
  subnetName: string;
  /** Optional ssh-keys metadata value, format `tensol:ssh-ed25519 AAA…`. */
  sshPublicKey: string;
  /**
   * Whether `spawnVm` should idempotently ensure the agent-ingress firewall
   * rule exists before provisioning (follow-up #2). Default true. Set false
   * for operators who manage firewalls out-of-band (Terraform, etc.).
   */
  ensureAgentFirewall: boolean;
  /** Firewall rule name for the server→vps-agent ingress. */
  agentFirewallName: string;
  /** TCP port the vps-agent binds — opened by the firewall rule. */
  agentFirewallPort: number;
  /** Source CIDR ranges allowed to reach the agent port. */
  agentFirewallSourceRanges: readonly string[];
  /** Service account email attached to scanner VMs. Empty = Compute default. */
  vmServiceAccountEmail: string;
  /** OAuth scopes exposed through scanner VM metadata tokens. */
  vmServiceAccountScopes: readonly string[];
};

export type CreateGcpProviderOpts = {
  config?: Partial<GcpProviderConfig>;
  /** Override `globalThis.fetch` for tests. */
  fetcher?: typeof fetch;
  /** Override the access-token source. Defaults to google-auth-library. */
  getToken?: () => Promise<string>;
};

export function createGcpCloudProvider(
  opts: CreateGcpProviderOpts = {},
): CloudProvider {
  const fetcher = opts.fetcher ?? fetch;
  const cfg = resolveConfig(opts.config);
  const getToken = opts.getToken ?? defaultGetToken;

  // Instance-scoped cache: ensure the agent-ingress firewall rule at most
  // once per provider lifetime (avoids an extra GET per spawn). Kept on the
  // closure — NOT module-level — so test providers don't share state.
  let firewallEnsured = false;

  return {
    async spawnVm(input: SpawnVmInput): Promise<SpawnVmResult> {
      // Follow-up #2: a fresh GCP project has no ingress rule for the
      // vps-agent port, so the server's POST /scan silently times out after
      // 8 minutes. Ensure the rule exists BEFORE provisioning — fail fast
      // with an actionable error if it is missing and we cannot create it.
      if (cfg.ensureAgentFirewall && !firewallEnsured) {
        await ensureFirewallRule({ fetcher, getToken, cfg });
        firewallEnsured = true;
      }

      const body = buildInstanceCreateBody(cfg, input);
      const token = await getToken();
      const requestId = scanIdToUuid(input.scanId);
      const url = `${COMPUTE_BASE_URL}/projects/${cfg.projectId}/zones/${cfg.zone}/instances?requestId=${requestId}`;
      const resp = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const detail = await readBodySafe(resp);
        throw new Error(
          `gcp spawnVm: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
        );
      }
      const op = (await resp.json()) as GcpOperation;
      if (!op.name) {
        throw new Error(
          "gcp spawnVm: insert response lacked operation 'name'",
        );
      }

      const final = await pollGcpOperation({
        fetcher,
        getToken,
        projectId: cfg.projectId,
        zone: cfg.zone,
        operationName: op.name,
      });
      if (final.error) {
        throw new Error(
          `gcp spawnVm op failed: ${JSON.stringify(final.error)}`,
        );
      }

      const status = await readStatus(
        fetcher,
        getToken,
        cfg.projectId,
        cfg.zone,
        body.name,
      );
      const result: SpawnVmResult = {
        instanceId: body.name,
        operationId: op.name,
      };
      return status.publicIp
        ? { ...result, publicIp: status.publicIp }
        : result;
    },

    async teardownVm(
      instanceId: string,
    ): Promise<{ operationId?: string }> {
      const token = await getToken();
      const url = `${COMPUTE_BASE_URL}/projects/${cfg.projectId}/zones/${cfg.zone}/instances/${encodeURIComponent(instanceId)}`;
      const resp = await fetcher(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.status === 404) {
        return {};
      }
      if (!resp.ok) {
        const detail = await readBodySafe(resp);
        throw new Error(
          `gcp teardownVm: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
        );
      }
      const op = (await resp.json()) as GcpOperation;
      return op.name ? { operationId: op.name } : {};
    },

    async getStatus(instanceId: string): Promise<VmStatus> {
      return readStatus(
        fetcher,
        getToken,
        cfg.projectId,
        cfg.zone,
        instanceId,
      );
    },

    async pollOperation(operationId: string): Promise<OperationResult> {
      const token = await getToken();
      const url = `${COMPUTE_BASE_URL}/projects/${cfg.projectId}/zones/${cfg.zone}/operations/${encodeURIComponent(operationId)}`;
      const resp = await fetcher(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.status === 404) {
        return { operationId, done: false };
      }
      if (!resp.ok) {
        const detail = await readBodySafe(resp);
        throw new Error(
          `gcp pollOperation: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
        );
      }
      const op = (await resp.json()) as GcpOperation;
      const done = op.status === "DONE";
      const base: OperationResult = { operationId, done };
      if (done && op.error?.errors?.length) {
        return {
          ...base,
          error: op.error.errors
            .map((e) => `${e.code ?? "?"}: ${e.message ?? "?"}`)
            .join("; "),
        };
      }
      return base;
    },

    async listInstances(_folderId: string): Promise<VmInstanceSummary[]> {
      // GCP has no "folder" concept like GCP — the closest analog is the
      // project. We list all instances in the configured zone of our
      // project. The folderId param is ignored intentionally (kept for
      // interface compatibility with the orphan-cleanup cron).
      void _folderId;
      const token = await getToken();
      const out: VmInstanceSummary[] = [];
      let pageToken: string | undefined;
      const MAX_PAGES = 50;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(
          `${COMPUTE_BASE_URL}/projects/${cfg.projectId}/zones/${cfg.zone}/instances`,
        );
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const resp = await fetcher(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
          const detail = await readBodySafe(resp);
          throw new Error(
            `gcp listInstances: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
          );
        }
        const body = (await resp.json()) as {
          items?: Array<{
            id?: string;
            name?: string;
            creationTimestamp?: string;
          }>;
          nextPageToken?: string;
        };
        for (const r of body.items ?? []) {
          if (!r.id || !r.name) continue;
          const createdAtMs = parseRfc3339Ms(r.creationTimestamp);
          if (createdAtMs === null) continue;
          out.push({ id: r.name, name: r.name, createdAt: createdAtMs });
        }
        if (!body.nextPageToken) break;
        pageToken = body.nextPageToken;
      }
      return out;
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

type GcpOperation = {
  name?: string;
  status?: "PENDING" | "RUNNING" | "DONE";
  targetLink?: string;
  error?: { errors?: Array<{ code?: string; message?: string }> };
};

type InstanceInsertBody = {
  name: string;
  machineType: string;
  disks: Array<{
    boot: boolean;
    autoDelete: boolean;
    initializeParams: {
      diskSizeGb: string;
      sourceImage: string;
    };
  }>;
  networkInterfaces: Array<{
    network: string;
    subnetwork: string;
    accessConfigs: Array<{
      type: "ONE_TO_ONE_NAT";
      name: string;
      networkTier: "PREMIUM" | "STANDARD";
    }>;
  }>;
  metadata: {
    items: Array<{ key: string; value: string }>;
  };
  serviceAccounts: Array<{
    email: string;
    scopes: readonly string[];
  }>;
  labels: Record<string, string>;
  scheduling: { preemptible?: boolean };
};

function buildInstanceCreateBody(
  cfg: GcpProviderConfig,
  input: SpawnVmInput,
): InstanceInsertBody {
  // GCP instance name: `[a-z]([-a-z0-9]{0,61}[a-z0-9])?`, max 63.
  const safeName = `tensol-scan-${input.scanId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`.slice(
    0,
    63,
  );
  const sshKeyItem = cfg.sshPublicKey
    ? [{ key: "ssh-keys", value: `tensol:${cfg.sshPublicKey}` }]
    : [];
  const region = zoneToRegion(cfg.zone);
  return {
    name: safeName,
    machineType: `zones/${cfg.zone}/machineTypes/${cfg.machineType}`,
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          diskSizeGb: String(cfg.bootDiskSizeGB),
          sourceImage: cfg.bootDiskImage,
        },
      },
    ],
    networkInterfaces: [
      {
        network: `global/networks/${cfg.networkName}`,
        subnetwork: `regions/${region}/subnetworks/${cfg.subnetName}`,
        accessConfigs: [
          {
            type: "ONE_TO_ONE_NAT",
            name: "External NAT",
            networkTier: "PREMIUM",
          },
        ],
      },
    ],
    metadata: {
      items: [
        // GCP's google-guest-agent (built into all gcloud-published images)
        // runs the `startup-script` metadata value on first boot. The
        // alternative `user-data` key requires cloud-init, which is NOT
        // installed in the minimal Debian 12 family — so the script would
        // be silently ignored. Discovered 2026-05-22 when vps-agent never
        // bound :8080 (cloud-init missing, no /var/log/cloud-init-output.log).
        { key: "startup-script", value: input.userData },
        ...sshKeyItem,
      ],
    },
    serviceAccounts: [
      {
        email: cfg.vmServiceAccountEmail || "default",
        scopes: cfg.vmServiceAccountScopes,
      },
    ],
    labels: sanitizeLabels(input.metadata ?? {}),
    scheduling: { preemptible: false },
  };
}

function zoneToRegion(zone: string): string {
  return zone.replace(/-[a-z]$/, "");
}

/**
 * GCP requires the idempotency `requestId` query param to be a UUID v4.
 * Derive deterministically from scanId via SHA-256 so retries dedup.
 */
function scanIdToUuid(scanId: string): string {
  const hash = createHash("sha256").update(scanId).digest();
  const b: number[] = Array.from(hash.slice(0, 16));
  // Set UUID v4 version + variant bits. We just sliced 16 bytes, so b[6]
  // and b[8] are guaranteed present — assert to satisfy noUncheckedIndexedAccess.
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function mapInstanceStatus(gcpStatus: string): VmStatus["status"] {
  const s = (gcpStatus ?? "").toUpperCase();
  if (s === "PROVISIONING" || s === "STAGING") return "provisioning";
  if (s === "RUNNING") return "running";
  if (s === "STOPPING" || s === "SUSPENDING" || s === "REPAIRING")
    return "stopping";
  if (s === "TERMINATED" || s === "SUSPENDED") return "stopped";
  return "error";
}

async function readStatus(
  fetcher: typeof fetch,
  getToken: () => Promise<string>,
  projectId: string,
  zone: string,
  instanceId: string,
): Promise<VmStatus> {
  const token = await getToken();
  const url = `${COMPUTE_BASE_URL}/projects/${projectId}/zones/${zone}/instances/${encodeURIComponent(instanceId)}`;
  const resp = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 404) {
    return { instanceId, status: "stopped" };
  }
  if (!resp.ok) {
    const detail = await readBodySafe(resp);
    throw new Error(
      `gcp getStatus: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
    );
  }
  const inst = (await resp.json()) as {
    status?: string;
    networkInterfaces?: Array<{
      networkIP?: string;
      accessConfigs?: Array<{ natIP?: string }>;
    }>;
  };
  const status = mapInstanceStatus(inst.status ?? "");
  const nic = inst.networkInterfaces?.[0];
  const publicIp = nic?.accessConfigs?.[0]?.natIP;
  const base: VmStatus = { instanceId, status };
  return publicIp ? { ...base, publicIp } : base;
}

async function pollGcpOperation(args: {
  fetcher: typeof fetch;
  getToken: () => Promise<string>;
  projectId: string;
  zone: string;
  operationName: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<GcpOperation> {
  const {
    fetcher,
    getToken,
    projectId,
    zone,
    operationName,
    timeoutMs = DEFAULT_OP_POLL_TIMEOUT_MS,
    intervalMs = DEFAULT_OP_POLL_INTERVAL_MS,
  } = args;
  const url = `${COMPUTE_BASE_URL}/projects/${projectId}/zones/${zone}/operations/${encodeURIComponent(operationName)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await getToken();
    const resp = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const detail = await readBodySafe(resp);
      throw new Error(
        `gcp pollGcpOperation: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
      );
    }
    const op = (await resp.json()) as GcpOperation;
    if (op.status === "DONE") {
      return op;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `gcp pollGcpOperation: TIMEOUT after ${timeoutMs}ms (op=${operationName})`,
  );
}

function parseRfc3339Ms(s: string | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function resolveConfig(
  override: Partial<GcpProviderConfig> | undefined,
): GcpProviderConfig {
  const projectId =
    override?.projectId ?? process.env.GCP_PROJECT_ID ?? "";
  if (!projectId) {
    throw new Error(
      "gcp provider: projectId required (GCP_PROJECT_ID env or opts.config.projectId)",
    );
  }
  const zone =
    override?.zone ?? process.env.GCP_ZONE ?? "europe-west1-b";
  return {
    projectId,
    zone,
    machineType:
      override?.machineType ?? process.env.GCP_MACHINE_TYPE ?? "e2-standard-2",
    bootDiskImage:
      override?.bootDiskImage ??
      process.env.GCP_BOOT_DISK_IMAGE ??
      // Debian 12 Bookworm latest stable (cloud-init pre-installed).
      "projects/debian-cloud/global/images/family/debian-12",
    bootDiskSizeGB:
      override?.bootDiskSizeGB ??
      parseInt(process.env.GCP_BOOT_DISK_SIZE_GB ?? "30", 10),
    networkName:
      override?.networkName ?? process.env.GCP_NETWORK_NAME ?? "default",
    subnetName:
      override?.subnetName ?? process.env.GCP_SUBNET_NAME ?? "default",
    sshPublicKey:
      override?.sshPublicKey ?? process.env.GCP_SSH_PUBLIC_KEY ?? "",
    ensureAgentFirewall:
      override?.ensureAgentFirewall ??
      // Opt-out via env (operators managing firewalls externally).
      process.env.GCP_AGENT_FIREWALL_ENSURE !== "false",
    agentFirewallName:
      override?.agentFirewallName ??
      process.env.GCP_AGENT_FIREWALL_NAME ??
      "allow-tensol-agent-8080",
    agentFirewallPort:
      override?.agentFirewallPort ??
      parseInt(process.env.GCP_AGENT_FIREWALL_PORT ?? "8080", 10),
    agentFirewallSourceRanges:
      override?.agentFirewallSourceRanges ??
      (process.env.GCP_AGENT_FIREWALL_SOURCE_RANGES
        ? process.env.GCP_AGENT_FIREWALL_SOURCE_RANGES.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : ["0.0.0.0/0"]),
    vmServiceAccountEmail:
      override?.vmServiceAccountEmail ??
      process.env.GCP_SCAN_VM_SERVICE_ACCOUNT_EMAIL ??
      "",
    vmServiceAccountScopes:
      override?.vmServiceAccountScopes ??
      (process.env.GCP_SCAN_VM_SERVICE_ACCOUNT_SCOPES
        ? process.env.GCP_SCAN_VM_SERVICE_ACCOUNT_SCOPES.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : DEFAULT_VM_SERVICE_ACCOUNT_SCOPES),
  };
}

/**
 * Follow-up #2 — idempotently ensure the server→vps-agent ingress firewall
 * rule exists before provisioning a VM.
 *
 * Contract (see test/integration/gcp-firewall.test.ts):
 *   - GET 200  → rule exists, return.
 *   - GET 404  → POST create. 200/409 → success; 403 → throw an ACTIONABLE
 *     error naming the rule + the manual `gcloud` command (fail fast rather
 *     than letting the spawn proceed into an 8-minute agent-dispatch
 *     timeout); any other code → throw with the HTTP detail.
 *   - GET 403 / other non-404 → cannot verify (SA lacks
 *     `compute.firewalls.get`), but an operator may have provisioned the
 *     rule out-of-band. Proceed rather than break a working deployment.
 *
 * Firewalls are GLOBAL resources: /projects/{proj}/global/firewalls.
 */
async function ensureFirewallRule(args: {
  fetcher: typeof fetch;
  getToken: () => Promise<string>;
  cfg: GcpProviderConfig;
}): Promise<void> {
  const { fetcher, getToken, cfg } = args;
  const name = cfg.agentFirewallName;
  const base = `${COMPUTE_BASE_URL}/projects/${cfg.projectId}/global/firewalls`;
  const token = await getToken();

  const getResp = await fetcher(`${base}/${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (getResp.ok) {
    await readBodySafe(getResp);
    return;
  }
  if (getResp.status !== 404) {
    // Cannot verify (typically 403: SA lacks compute.firewalls.get). The rule
    // may already exist (operator-managed). Proceed — do not break prod.
    await readBodySafe(getResp);
    return;
  }

  // 404 — create the rule.
  const createBody = {
    name,
    network: `global/networks/${cfg.networkName}`,
    direction: "INGRESS",
    priority: 1000,
    sourceRanges: [...cfg.agentFirewallSourceRanges],
    allowed: [
      { IPProtocol: "tcp", ports: [String(cfg.agentFirewallPort)] },
    ],
    description:
      "Tensol: allow server→vps-agent HMAC callbacks (auto-provisioned by gcp.ts ensureFirewallRule)",
  };
  const createResp = await fetcher(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createBody),
  });
  if (createResp.ok || createResp.status === 409) {
    // 409 = another spawn raced us to create it. Both are success.
    await readBodySafe(createResp);
    return;
  }
  const detail = await readBodySafe(createResp);
  if (createResp.status === 403) {
    const ranges = cfg.agentFirewallSourceRanges.join(",");
    throw new Error(
      `gcp ensureFirewallRule: firewall '${name}' is missing and the ` +
        `service account lacks compute.firewalls.create (HTTP 403). ` +
        `Create it once manually:\n` +
        `  gcloud compute firewall-rules create ${name} ` +
        `--project=${cfg.projectId} --network=${cfg.networkName} ` +
        `--direction=INGRESS --action=ALLOW ` +
        `--rules=tcp:${cfg.agentFirewallPort} --source-ranges=${ranges}\n` +
        `:: ${detail}`,
    );
  }
  throw new Error(
    `gcp ensureFirewallRule: HTTP ${createResp.status} ${createResp.statusText} :: ${detail}`,
  );
}

let _authClient: GoogleAuth | null = null;
async function defaultGetToken(): Promise<string> {
  if (!_authClient) {
    _authClient = new GoogleAuth({
      scopes: [DEFAULT_OAUTH_SCOPE],
    });
  }
  const client = await _authClient.getClient();
  const tokenResp = await client.getAccessToken();
  if (!tokenResp.token) {
    throw new Error(
      "gcp defaultGetToken: empty access token from google-auth-library",
    );
  }
  return tokenResp.token;
}

async function readBodySafe(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
