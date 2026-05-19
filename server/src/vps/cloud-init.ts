/**
 * T044 — cloud-init userdata generator for per-scan ephemeral Yandex VM.
 *
 * Per `specs/002-blackbox-mvp/plan.md` §"vps-agent contract" and the
 * canonical env list in `vps-agent/.env.example`, this module renders a
 * single bash script that the cloud-init agent on a freshly-spawned Yandex
 * Compute VM executes once on first boot. The output is base64-free plain
 * text — Yandex Compute passes it through verbatim via the VM metadata
 * key `user-data` (see `server/src/vps/yandex.ts`).
 *
 * Responsibilities of the script:
 *   1. Install Docker (idempotent — no-op if present in the base image).
 *   2. Pull the vps-agent image (and the Decepticon image, if separately
 *      pulled — current Decepticon stack pulls itself on first compose-up).
 *   3. Export the full TENSOL_* + AWS_* env contract that vps-agent reads
 *      at startup (`vps-agent/src/agent.ts → readRequiredEnv`) and during
 *      Decepticon dispatch (`decepticon-runner.ts → buildEnv`).
 *   4. Run vps-agent with `/var/run/docker.sock` mounted so that
 *      `docker compose up` inside the agent can spawn Decepticon's stack.
 *   5. Publish the agent port for inbound `/scan` from the backend.
 *
 * Security:
 *   - All caller-supplied values are POSIX-shell-escaped via single-quote
 *     wrapping (see `shEsc`). This defends against injection through
 *     scan IDs / secrets / bucket names that contain quotes or shell
 *     metacharacters. The escape strategy is the standard
 *     `'` → `'\''` rewrite which works under `sh`, `bash`, and `dash`.
 *
 * Determinism:
 *   - No timestamps, no randomness, no env-reads inside the renderer.
 *     Same args → byte-identical output. This is contractually relied on
 *     by `cloud-init.test.ts`.
 *
 * Not in scope:
 *   - HMAC signing of the webhook (vps-agent does that at runtime using
 *     TENSOL_WEBHOOK_SECRET).
 *   - Decepticon configuration: per Constitution I, Decepticon is
 *     configured purely through env vars. The bucket/prefix/AWS keys are
 *     exported so the Decepticon container inherits them when
 *     vps-agent's `buildEnv` forwards `process.env`.
 */

/**
 * Inputs for `buildCloudInit`. Mirrors the runtime contract documented in
 * `vps-agent/.env.example`. All fields are required except `vpsAgentImage`
 * and `agentPort`, which have sensible defaults.
 */
export interface BuildCloudInitArgs {
  /** ULID-shaped scan identifier (single scan per VM). */
  scanId: string;
  /** Backend webhook receiver, e.g. `https://api.tensol.run/v1`. */
  backendUrl: string;
  /** 32-byte hex/base64 HMAC secret shared with the backend (per-scan). */
  webhookSecret: string;
  /** Yandex Object Storage bucket name for evidence uploads. */
  evidenceBucket: string;
  /** Per-scan S3 key prefix, e.g. `evidence/`. */
  evidencePrefix: string;
  /** Yandex static-access-key ID, scoped to the per-scan SA. */
  awsAccessKeyId: string;
  /** Yandex static-access-key secret. */
  awsSecretAccessKey: string;
  /**
   * S3-compatible endpoint URL, e.g. `https://storage.yandexcloud.net`.
   * Named `AWS_ENDPOINT` per `vps-agent/.env.example` (not
   * `AWS_ENDPOINT_URL` — the contract picks the shorter form).
   */
  awsEndpoint: string;
  /** Yandex region, e.g. `ru-central1`. */
  awsRegion: string;
  /** 32-byte HMAC sign key for vps-agent → backend webhook signing. */
  signKey: string;
  /** Decepticon image reference (pinned digest preferred). */
  decepticonImage: string;
  /** vps-agent image reference. Defaults to `ghcr.io/tensol/vps-agent:latest`. */
  vpsAgentImage?: string;
  /** Port the vps-agent Hono server binds to. Defaults to 8080. */
  agentPort?: number;
}

/**
 * POSIX-safe single-quote escape. Wraps the value in single quotes and
 * rewrites embedded single quotes as `'\''` (close-quote, escaped-quote,
 * open-quote). Works under `sh`, `bash`, and `dash`.
 */
function shEsc(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const DEFAULT_AGENT_IMAGE = "ghcr.io/tensol/vps-agent:latest";
const DEFAULT_AGENT_PORT = 8080;

/**
 * Render the cloud-init userdata script. See module docstring for the
 * full contract.
 */
export function buildCloudInit(args: BuildCloudInitArgs): string {
  const vpsAgentImage = args.vpsAgentImage ?? DEFAULT_AGENT_IMAGE;
  const agentPort = args.agentPort ?? DEFAULT_AGENT_PORT;

  // Pre-escape every caller-supplied value once so the template stays
  // readable. Image refs and the port are NOT escaped — image refs are
  // validated upstream (allowed chars: alnum / `:`, `/`, `.`, `-`, `_`)
  // and the port is a number.
  const e = {
    scanId: shEsc(args.scanId),
    backendUrl: shEsc(args.backendUrl),
    webhookSecret: shEsc(args.webhookSecret),
    evidenceBucket: shEsc(args.evidenceBucket),
    evidencePrefix: shEsc(args.evidencePrefix),
    awsAccessKeyId: shEsc(args.awsAccessKeyId),
    awsSecretAccessKey: shEsc(args.awsSecretAccessKey),
    awsEndpoint: shEsc(args.awsEndpoint),
    awsRegion: shEsc(args.awsRegion),
    signKey: shEsc(args.signKey),
  };

  const lines: string[] = [
    "#!/bin/bash",
    "set -euo pipefail",
    "",
    "# T044 cloud-init: bootstrap an ephemeral per-scan Tensol VM.",
    "# Generated by server/src/vps/cloud-init.ts — do not edit by hand on the VM.",
    "",
    "# ─── Env contract (vps-agent + Decepticon) ───────────────────────────",
    `export TENSOL_SCAN_ID=${e.scanId}`,
    `export TENSOL_SIGN_KEY=${e.signKey}`,
    `export TENSOL_WEBHOOK_BACKEND_URL=${e.backendUrl}`,
    `export TENSOL_WEBHOOK_SECRET=${e.webhookSecret}`,
    `export TENSOL_EVIDENCE_BUCKET=${e.evidenceBucket}`,
    `export TENSOL_EVIDENCE_PREFIX=${e.evidencePrefix}`,
    `export AWS_ACCESS_KEY_ID=${e.awsAccessKeyId}`,
    `export AWS_SECRET_ACCESS_KEY=${e.awsSecretAccessKey}`,
    `export AWS_ENDPOINT=${e.awsEndpoint}`,
    `export AWS_REGION=${e.awsRegion}`,
    "",
    "# ─── Install Docker (no-op if base image already has it) ─────────────",
    "command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh",
    "systemctl enable --now docker",
    "",
    "# ─── Pull images explicitly (avoids racing the run step) ─────────────",
    `docker pull ${shEsc(vpsAgentImage)}`,
    `docker pull ${shEsc(args.decepticonImage)}`,
    "",
    "# ─── Open agent port on the local firewall (best-effort) ─────────────",
    "if command -v ufw >/dev/null 2>&1; then",
    `  ufw allow ${agentPort}/tcp || true`,
    "fi",
    `iptables -I INPUT -p tcp --dport ${agentPort} -j ACCEPT || true`,
    "",
    "# ─── Run vps-agent (manages the Decepticon compose stack) ────────────",
    "docker run -d \\",
    "  --name tensol-vps-agent \\",
    "  --restart unless-stopped \\",
    `  -p ${agentPort}:${agentPort} \\`,
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    "  -e TENSOL_SCAN_ID \\",
    "  -e TENSOL_SIGN_KEY \\",
    "  -e TENSOL_WEBHOOK_BACKEND_URL \\",
    "  -e TENSOL_WEBHOOK_SECRET \\",
    "  -e TENSOL_EVIDENCE_BUCKET \\",
    "  -e TENSOL_EVIDENCE_PREFIX \\",
    "  -e AWS_ACCESS_KEY_ID \\",
    "  -e AWS_SECRET_ACCESS_KEY \\",
    "  -e AWS_ENDPOINT \\",
    "  -e AWS_REGION \\",
    `  -e PORT=${agentPort} \\`,
    `  ${shEsc(vpsAgentImage)}`,
    "",
  ];

  return lines.join("\n");
}
