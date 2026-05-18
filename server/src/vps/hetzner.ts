/**
 * T037 — Hetzner Cloud VPS provider.
 *
 * Implements `VpsProvider` against the Hetzner Cloud API (v1):
 *   - POST   /v1/servers      → spawn
 *   - GET    /v1/servers/:id  → status poll
 *   - DELETE /v1/servers/:id  → destroy (idempotent on 404)
 *
 * The HTTP client is injected via `fetchImpl` so tests can mock without
 * touching `mock.module` or hitting the network. Configuration (api token,
 * location, image, ssh key, vps-agent image, webhook base URL) is supplied
 * by the caller — never read from `process.env` here. The runtime wires it
 * from `config.ts` at composition time.
 *
 * Cloud-init format: a bare bash script (with `#!/bin/bash` shebang).
 * Hetzner accepts this as `user_data` and cloud-init recognises the shebang
 * and runs the body verbatim during first boot. We pick bash over YAML
 * `#cloud-config` because the only thing we need is a 4-step linear runbook
 * (install docker → pull image → run container → open firewall) and bash
 * is the most ergonomic for that shape.
 */

import type {
  SpawnVpsArgs,
  SpawnedVps,
  VpsProvider,
  VpsStatus,
} from "./provider";

const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";
const VPS_AGENT_PORT = 8080;

export type HetznerOpts = {
  apiToken: string;
  location: string;
  serverType: string;
  image: string;
  sshKeyName: string;
  vpsAgentImage: string;
  webhookBaseUrl: string;
  /** Optional override for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
};

type HetznerServerStatus =
  | "initializing"
  | "starting"
  | "running"
  | "stopping"
  | "off"
  | "deleting"
  | "migrating"
  | "rebuilding"
  | "unknown";

function mapStatus(raw: string | undefined): VpsStatus {
  switch (raw) {
    case "initializing":
    case "starting":
    case "rebuilding":
    case "migrating":
      return "initializing";
    case "running":
      return "running";
    case "stopping":
    case "off":
      return "stopped";
    case "deleting":
      return "destroyed";
    default:
      return "unknown";
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}

export function buildCloudInit(args: {
  vpsAgentImage: string;
  webhookBaseUrl: string;
  signKey: string;
  scanId: string;
}): string {
  const { vpsAgentImage, webhookBaseUrl, signKey, scanId } = args;
  // Bash script. Variables expanded by the local cloud-init shell on the VPS.
  // We intentionally use single-line VAR=VALUE for env vars so test assertions
  // can `.toContain("TENSOL_WEBHOOK_BASE_URL=https://...")` verbatim.
  return `#!/bin/bash
set -euo pipefail

# Tensol vps-agent bootstrap (T037 cloud-init)
# Triggered by Hetzner on first boot.

# 1. Install Docker engine.
curl -fsSL https://get.docker.com | sh

# 2. Pull the vps-agent image.
docker pull ${vpsAgentImage}

# 3. Open firewall for inbound vps-agent callback port.
if command -v ufw >/dev/null 2>&1; then
  ufw allow ${VPS_AGENT_PORT}/tcp || true
fi
iptables -I INPUT -p tcp --dport ${VPS_AGENT_PORT} -j ACCEPT || true

# 4. Run the vps-agent container.
TENSOL_WEBHOOK_BASE_URL=${webhookBaseUrl}
TENSOL_SIGN_KEY=${signKey}
TENSOL_SCAN_ID=${scanId}

docker run -d \\
  --name tensol-vps-agent \\
  --restart unless-stopped \\
  -p ${VPS_AGENT_PORT}:${VPS_AGENT_PORT} \\
  -e TENSOL_WEBHOOK_BASE_URL="\${TENSOL_WEBHOOK_BASE_URL}" \\
  -e TENSOL_SIGN_KEY="\${TENSOL_SIGN_KEY}" \\
  -e TENSOL_SCAN_ID="\${TENSOL_SCAN_ID}" \\
  ${vpsAgentImage}
`;
}

export function createHetznerProvider(opts: HetznerOpts): VpsProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${opts.apiToken}`,
    "Content-Type": "application/json",
  });

  async function spawnVps(args: SpawnVpsArgs): Promise<SpawnedVps> {
    const userData = buildCloudInit({
      vpsAgentImage: opts.vpsAgentImage,
      webhookBaseUrl: opts.webhookBaseUrl,
      signKey: args.signKey,
      scanId: args.scanId,
    });

    const body = {
      name: `tensol-scan-${args.scanId.toLowerCase()}`,
      server_type: opts.serverType,
      image: opts.image,
      location: opts.location,
      ssh_keys: [opts.sshKeyName],
      user_data: userData,
      start_after_create: true,
    };

    const res = await fetchImpl(`${HETZNER_API_BASE}/servers`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new Error(
        `Hetzner spawnVps failed: HTTP ${res.status} ${res.statusText} :: ${detail}`,
      );
    }

    const json = (await res.json()) as {
      server?: {
        id?: number | string;
        public_net?: { ipv4?: { ip?: string } };
      };
    };
    const server = json.server;
    const id = server?.id;
    const ipv4 = server?.public_net?.ipv4?.ip;
    if (id === undefined || id === null || !ipv4) {
      throw new Error(
        `Hetzner spawnVps returned malformed response: ${JSON.stringify(json).slice(0, 200)}`,
      );
    }
    return { provider_server_id: String(id), ipv4 };
  }

  async function getVpsStatus(providerServerId: string): Promise<VpsStatus> {
    const res = await fetchImpl(
      `${HETZNER_API_BASE}/servers/${encodeURIComponent(providerServerId)}`,
      { method: "GET", headers: headers() },
    );
    if (res.status === 404) {
      return "destroyed";
    }
    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new Error(
        `Hetzner getVpsStatus failed: HTTP ${res.status} ${res.statusText} :: ${detail}`,
      );
    }
    const json = (await res.json()) as {
      server?: { status?: HetznerServerStatus | string };
    };
    return mapStatus(json.server?.status);
  }

  async function destroyVps(providerServerId: string): Promise<void> {
    const res = await fetchImpl(
      `${HETZNER_API_BASE}/servers/${encodeURIComponent(providerServerId)}`,
      { method: "DELETE", headers: headers() },
    );
    if (res.ok || res.status === 404) {
      // 200/204 = deleted; 404 = already gone — both terminal success.
      return;
    }
    const detail = await readErrorBody(res);
    throw new Error(
      `Hetzner destroyVps failed: HTTP ${res.status} ${res.statusText} :: ${detail}`,
    );
  }

  return { spawnVps, getVpsStatus, destroyVps };
}

export type { VpsProvider, VpsStatus, SpawnVpsArgs, SpawnedVps } from "./provider";
