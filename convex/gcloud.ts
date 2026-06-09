"use node";

import { createHash, createSign, randomBytes } from "node:crypto";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  buildAgentDispatchBody,
  buildStartupScript,
  requiredEnvAny,
  signAgentDispatchBody,
  type DispatchMaterial,
} from "./lib/gcloudProvisioning";

const COMPUTE_BASE_URL = "https://compute.googleapis.com/compute/v1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const COMPUTE_SCOPE = "https://www.googleapis.com/auth/compute";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

function b64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function scanIdToUuid(scanId: string): string {
  const hash = createHash("sha256").update(scanId).digest();
  const b = Array.from(hash.slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function getGcpAccessToken() {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GCP_SERVICE_ACCOUNT_JSON or GCP_ACCESS_TOKEN is required");
  const sa = JSON.parse(raw) as ServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: COMPUTE_SCOPE,
      aud: sa.token_uri ?? OAUTH_TOKEN_URL,
      exp: now + 3600,
      iat: now,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(sa.private_key).toString("base64url")}`;
  const res = await fetch(sa.token_uri ?? OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`gcp oauth token failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("gcp oauth response lacked access_token");
  return body.access_token;
}

function gcpConfig() {
  const projectId = process.env.GCP_PROJECT_ID ?? "";
  if (!projectId) throw new Error("GCP_PROJECT_ID is required");
  const zone = process.env.GCP_ZONE ?? "europe-west1-b";
  return {
    projectId,
    zone,
    machineType: process.env.GCP_MACHINE_TYPE ?? "e2-small",
    bootDiskImage:
      process.env.GCP_BOOT_DISK_IMAGE ??
      "projects/debian-cloud/global/images/family/debian-12",
    bootDiskSizeGB: Number.parseInt(process.env.GCP_BOOT_DISK_SIZE_GB ?? "30", 10),
    networkName: process.env.GCP_NETWORK_NAME ?? "default",
    subnetName: process.env.GCP_SUBNET_NAME ?? "default",
  };
}

function zoneToRegion(zone: string) {
  return zone.replace(/-[a-z]$/, "");
}

function startupScript(scanId: string, signKey: string) {
  return buildStartupScript({ scanId, signKey });
}

async function insertGcpInstance(scanId: string, signKey: string) {
  const cfg = gcpConfig();
  const token = await getGcpAccessToken();
  const region = zoneToRegion(cfg.zone);
  const name = `sthrip-scan-${scanId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`.slice(0, 63);
  const body = {
    name,
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
        accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT", networkTier: "PREMIUM" }],
      },
    ],
    metadata: { items: [{ key: "startup-script", value: startupScript(scanId, signKey) }] },
    labels: { app: "sthrip", scan_id: scanId.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63) },
    scheduling: { preemptible: false },
  };
  const url = `${COMPUTE_BASE_URL}/projects/${cfg.projectId}/zones/${cfg.zone}/instances?requestId=${scanIdToUuid(scanId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gcp instances.insert failed: HTTP ${res.status} ${await res.text()}`);
  const op = (await res.json()) as { name?: string };
  return { instanceName: name, operationId: op.name, zone: cfg.zone };
}

async function getGcpInstancePublicIp(instanceName: string, zone: string) {
  const cfg = gcpConfig();
  const token = await getGcpAccessToken();
  const url = `${COMPUTE_BASE_URL}/projects/${cfg.projectId}/zones/${zone}/instances/${instanceName}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`gcp instances.get failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    networkInterfaces?: Array<{
      accessConfigs?: Array<{ natIP?: string }>;
    }>;
  };
  return body.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
}

async function waitForGcpInstancePublicIp(instanceName: string, zone: string) {
  const deadline = Date.now() + Number.parseInt(process.env.GCP_AGENT_WAIT_MS ?? "480000", 10);
  const intervalMs = Number.parseInt(process.env.GCP_AGENT_POLL_MS ?? "5000", 10);
  let lastError = "missing public IP";
  while (Date.now() < deadline) {
    try {
      const publicIp = await getGcpInstancePublicIp(instanceName, zone);
      if (publicIp) return publicIp;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`gcp instance public IP did not become available: ${lastError}`);
}

async function dispatchAgentScan(args: {
  publicIp: string;
  signKey: string;
  scanId: string;
  material: DispatchMaterial;
}) {
  const siteUrl = requiredEnvAny(process.env, "CONVEX_SITE_URL", "PUBLIC_CONVEX_SITE_URL");
  const evidenceBucket = requiredEnvAny(process.env, "TENSOL_EVIDENCE_BUCKET", "EVIDENCE_BUCKET");
  const port = Number.parseInt(process.env.VPS_AGENT_PORT ?? "8080", 10);
  const body = buildAgentDispatchBody({
    siteUrl,
    evidenceBucket,
    scanId: args.scanId,
    material: args.material,
  });
  const rawBody = JSON.stringify(body);
  const signature = signAgentDispatchBody(args.signKey, rawBody);
  const url = `http://${args.publicIp}:${port}/scan`;
  const deadline = Date.now() + Number.parseInt(process.env.GCP_AGENT_WAIT_MS ?? "480000", 10);
  const intervalMs = Number.parseInt(process.env.GCP_AGENT_POLL_MS ?? "5000", 10);
  let lastError = "agent not reached";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tensol-Signature": signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(Number.parseInt(process.env.GCP_AGENT_PROBE_TIMEOUT_MS ?? "8000", 10)),
      });
      if (res.ok) return;
      throw new Error(`agent dispatch failed: HTTP ${res.status} ${await res.text()}`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`vps-agent dispatch timed out: ${lastError}`);
}

async function deleteGcpInstance(instanceName: string, zone: string, requestKey: string) {
  const cfg = gcpConfig();
  const token = await getGcpAccessToken();
  const url = `${COMPUTE_BASE_URL}/projects/${cfg.projectId}/zones/${zone}/instances/${instanceName}?requestId=${scanIdToUuid(requestKey)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return { operationId: "already-deleted" };
  if (!res.ok) throw new Error(`gcp instances.delete failed: HTTP ${res.status} ${await res.text()}`);
  const op = (await res.json()) as { name?: string };
  return { operationId: op.name };
}

export const provisionScanVm = internalAction({
  args: { scanId: v.id("scans") },
  handler: async (ctx, args) => {
    const signKey = randomBytes(32).toString("hex");
    const dryRun =
      process.env.GCP_DRY_RUN !== "false" &&
      (!process.env.GCP_PROJECT_ID || (!process.env.GCP_SERVICE_ACCOUNT_JSON && !process.env.GCP_ACCESS_TOKEN));
    try {
      if (dryRun) {
        await ctx.runMutation(internal.ops.markVmRunning, {
          scanId: args.scanId,
          provider: "dry_run",
          providerServerId: `dry-${args.scanId}`,
          publicIp: "127.0.0.1",
          signKey,
        });
        await ctx.scheduler.runAfter(1500, internal.gcloud.completeDryRunScan, { scanId: args.scanId });
        return null;
      }
      const material = await ctx.runQuery(internal.ops.getScanDispatchMaterial, {
        scanId: args.scanId,
      });
      const result = await insertGcpInstance(args.scanId, signKey);
      const running = await ctx.runMutation(internal.ops.markVmRunning, {
        scanId: args.scanId,
        provider: "gcp",
        providerServerId: result.instanceName,
        zone: result.zone,
        operationId: result.operationId,
        signKey,
      });
      if (running.status !== "running") return null;
      const publicIp = await waitForGcpInstancePublicIp(result.instanceName, result.zone);
      await ctx.runMutation(internal.ops.markVmPublicIp, {
        scanId: args.scanId,
        publicIp,
      });
      await dispatchAgentScan({
        publicIp,
        signKey,
        scanId: args.scanId,
        material,
      });
      return null;
    } catch (err) {
      await ctx.runMutation(internal.ops.failScan, {
        scanId: args.scanId,
        reason: err instanceof Error ? err.message : "gcp_provision_failed",
      });
      await ctx.runAction(internal.gcloud.teardownScanVm, { scanId: args.scanId });
      return null;
    }
  },
});

export const completeDryRunScan = internalAction({
  args: { scanId: v.id("scans") },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.ops.completeScan, {
      scanId: args.scanId,
      findings: [
        {
          external_id: "convex-dry-run-finding",
          severity: "informational",
          title: "Convex dry-run scan completed",
          body_md:
            "The Convex backend executed the scan lifecycle without GCP credentials. Configure GCP_PROJECT_ID and GCP_SERVICE_ACCOUNT_JSON to provision a real Compute Engine VM.",
          confidence: "verified",
          cwe: [],
          mitre: [],
          evidence_keys: [],
        },
      ],
      usageTokens: 0,
      usageUsdCents: 0,
    });
    await ctx.runMutation(internal.ops.markVpsDestroyed, { scanId: args.scanId });
    return null;
  },
});

export const teardownScanVm = internalAction({
  args: { scanId: v.id("scans") },
  handler: async (ctx, args) => {
    const teardown = await ctx.runMutation(internal.ops.beginVpsTeardown, {
      scanId: args.scanId,
    });
    if (!teardown || teardown.status === "already_destroyed") return null;
    try {
      if (teardown.provider === "gcp") {
        if (!teardown.zone) throw new Error("GCP VPS record is missing zone");
        await deleteGcpInstance(
          teardown.providerServerId,
          teardown.zone,
          `${args.scanId}:delete`,
        );
      }
      await ctx.runMutation(internal.ops.markVpsDestroyed, {
        scanId: args.scanId,
      });
    } catch (err) {
      await ctx.runMutation(internal.ops.markVpsTeardownFailed, {
        scanId: args.scanId,
        reason: err instanceof Error ? err.message : "gcp_teardown_failed",
      });
    }
    return null;
  },
});
