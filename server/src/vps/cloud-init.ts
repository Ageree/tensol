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
 *   4. [T128 Bug #7] Lay down the Decepticon compose stack at
 *      `/opt/decepticon/`: minimal 5-service docker-compose.yml, our
 *      LiteLLM override routing every model through OpenRouter
 *      qwen3.7-max, the Rule 4b KG_PERSISTENCE recon-prompt override,
 *      and a sibling `.env` carrying OPENROUTER_API_KEY +
 *      DB passwords. Symlink to `/opt/tensol/docker-compose.yml` (where
 *      vps-agent's runner expects it).
 *   5. Run vps-agent with `/var/run/docker.sock` mounted so that
 *      `docker compose up` inside the agent can spawn Decepticon's stack.
 *   6. Publish the agent port for inbound `/scan` from the backend.
 *
 * Security:
 *   - All caller-supplied values are POSIX-shell-escaped via single-quote
 *     wrapping (see `shEsc`). This defends against injection through
 *     scan IDs / secrets / bucket names that contain quotes or shell
 *     metacharacters. The escape strategy is the standard
 *     `'` → `'\''` rewrite which works under `sh`, `bash`, and `dash`.
 *   - Embedded payloads (compose / litellm / recon) come from
 *     `infra/decepticon-overrides/` via `decepticon-embedded.ts`. They are
 *     wrapped in `<<'EOF'`-style heredocs (single-quoted delimiter) so
 *     the VM shell does NOT interpolate `$` or backticks inside the
 *     payload — content lands on disk byte-for-byte. The delimiter chosen
 *     (`TENSOL_*_EOF`) is unlikely to collide with any content line.
 *   - `/opt/decepticon/.env` is chmod 600 immediately after creation —
 *     it contains the OpenRouter key and DB passwords in plaintext.
 *
 * Determinism:
 *   - No timestamps, no randomness, no env-reads inside the renderer.
 *     Same args → byte-identical output. This is contractually relied on
 *     by `cloud-init.test.ts`.
 *
 * Not in scope:
 *   - HMAC signing of the webhook (vps-agent does that at runtime using
 *     TENSOL_WEBHOOK_SECRET).
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
  /**
   * OpenRouter API key (sk-or-v1-...). Routed by the embedded LiteLLM
   * config (`infra/decepticon-overrides/litellm.yaml`) to
   * `openrouter/qwen/qwen3.7-max` for every Decepticon model name.
   * REQUIRED — without it the LiteLLM proxy returns 401 on the first call
   * and the entire scan hangs at recon-step-1.
   */
  openrouterApiKey: string;
  /** LiteLLM master key (shared between litellm and langgraph services). */
  litellmMasterKey: string;
  /** Postgres password for the local litellm-backing DB. */
  postgresPassword: string;
  /** Neo4j auth password (KG that the verifier reads). */
  neo4jPassword: string;
  /** vps-agent image reference. Defaults to `ghcr.io/tensol/vps-agent:latest`. */
  vpsAgentImage?: string;
  /** Port the vps-agent Hono server binds to. Defaults to 8080. */
  agentPort?: number;
  /**
   * P1 — OpenRouter model id to drive the Decepticon scan with real tool-using
   * gpt-5.5 (e.g. `"openai/gpt-5.5"`). When set, the embedded LiteLLM config's
   * `openai/*` routes are repointed from the qwen hijack to
   * `openrouter/<model>`, and the Decepticon resolver is pinned to the openai
   * auth path so agents resolve to those (now-real) routes. Omit (default) to
   * keep the cost-safe qwen3.7-max hijack unchanged — output is then byte-
   * identical to before this field existed. gpt-5.5 is ~24× qwen; enable only
   * deliberately (gated by `TENSOL_BLACKBOX_AGENT_ENABLED`).
   */
  blackboxAgentModel?: string;
}

import {
  DECEPTICON_COMPOSE_YML,
  DECEPTICON_LITELLM_YAML,
  DECEPTICON_RECON_MD,
} from "./decepticon-embedded.ts";

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

/** The qwen target the embedded litellm.yaml hijacks every model name to. */
const QWEN_HIJACK_TARGET = "openrouter/qwen/qwen3.7-max";
/** OpenAI route names whose target is repointed when running blackbox on gpt-5.5. */
const OPENAI_ROUTE_NAMES = ["openai/gpt-5.5", "openai/gpt-5.4", "openai/gpt-5-nano"];

/** Escape a string for safe literal use inside a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Repoint the embedded LiteLLM config's `openai/*` routes from the qwen hijack
 * to `openrouter/<model>`, so a Decepticon scan pinned to the openai auth path
 * actually reaches real gpt-5.5. Anchored on each exact `model_name:` block so
 * the anthropic/* and nvidia_nim/* qwen hijacks are left untouched. Pure: returns
 * a new string; the embedded constant is never mutated.
 */
function repointOpenAiRoutesToRealModel(yaml: string, model: string): string {
  const target = `openrouter/${model}`;
  let out = yaml;
  for (const name of OPENAI_ROUTE_NAMES) {
    const re = new RegExp(
      `(- model_name: ${reEscape(name)}\\n\\s+litellm_params:\\n\\s+model: )${reEscape(
        QWEN_HIJACK_TARGET,
      )}`,
    );
    out = out.replace(re, `$1${target}`);
  }
  return out;
}

/**
 * Heredoc delimiters for the embedded Decepticon stack files. The
 * delimiters are chosen to never collide with any line in the payloads
 * (`infra/decepticon-overrides/*`). Tested at module-load time via the
 * `assertNoDelimiterCollision` invariant below.
 */
const COMPOSE_EOF = "TENSOL_DECEPTICON_COMPOSE_EOF";
const LITELLM_EOF = "TENSOL_DECEPTICON_LITELLM_EOF";
const RECON_EOF = "TENSOL_DECEPTICON_RECON_EOF";

function assertNoDelimiterCollision(
  delim: string,
  payload: string,
  label: string,
): void {
  // A heredoc terminator is a line that contains ONLY the delimiter (no
  // surrounding whitespace). Check the payload doesn't already contain
  // such a line — otherwise the script breaks mid-heredoc.
  const re = new RegExp(`^${delim}$`, "m");
  if (re.test(payload)) {
    throw new Error(
      `cloud-init: heredoc delimiter ${delim} collides with content of ${label}. ` +
        `Pick a different delimiter or strip the conflicting line from the source.`,
    );
  }
}

assertNoDelimiterCollision(
  COMPOSE_EOF,
  DECEPTICON_COMPOSE_YML,
  "decepticon-vm-compose.yml",
);
assertNoDelimiterCollision(
  LITELLM_EOF,
  DECEPTICON_LITELLM_YAML,
  "litellm.yaml",
);
assertNoDelimiterCollision(RECON_EOF, DECEPTICON_RECON_MD, "recon.md");

/**
 * Render the cloud-init userdata script. See module docstring for the
 * full contract.
 */
export function buildCloudInit(args: BuildCloudInitArgs): string {
  const vpsAgentImage = args.vpsAgentImage ?? DEFAULT_AGENT_IMAGE;
  const agentPort = args.agentPort ?? DEFAULT_AGENT_PORT;

  // P1 — when a blackbox agent model is set, repoint the openai/* LiteLLM routes
  // to real gpt-5.5 and pin Decepticon to the openai auth path; otherwise keep
  // the cost-safe qwen hijack + anthropic auth path (byte-identical to before).
  const blackboxModel = args.blackboxAgentModel?.trim();
  const litellmYaml = blackboxModel
    ? repointOpenAiRoutesToRealModel(DECEPTICON_LITELLM_YAML, blackboxModel)
    : DECEPTICON_LITELLM_YAML;
  const decepticonAuthEnvLines = blackboxModel
    ? [
        // Pin to the openai auth path so the resolver produces openai/* names →
        // the (now-real) gpt-5.5 routes above. The synthetic key only satisfies
        // Decepticon's _is_real_key gate; the real call goes via litellm →
        // OpenRouter using OPENROUTER_API_KEY (never sent upstream), mirroring
        // the anthropic synthetic-key pattern.
        "DECEPTICON_AUTH_PRIORITY=openai_api",
        "OPENAI_API_KEY=sk-tensol-routes-via-litellm-gpt55",
      ]
    : [
        // [FIX A 2026-05-25] Pin the resolver to a single provider so all tiers
        // resolve to anthropic/* names → litellm hijacks them to qwen3.7-max.
        // Avoids the unauthed nvidia_nim fallback tail that crashed prod scan
        // 01KSF7X1… The synthetic key only satisfies Decepticon's _is_real_key
        // gate; it is never sent upstream. These also feed the compose
        // ${VAR:-default} interpolation for the langgraph container env.
        "DECEPTICON_AUTH_PRIORITY=anthropic_api",
        "ANTHROPIC_API_KEY=sk-ant-tensol-routes-via-litellm-qwen",
      ];

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
    openrouterApiKey: shEsc(args.openrouterApiKey),
    litellmMasterKey: shEsc(args.litellmMasterKey),
    postgresPassword: shEsc(args.postgresPassword),
    neo4jPassword: shEsc(args.neo4jPassword),
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
    `export OPENROUTER_API_KEY=${e.openrouterApiKey}`,
    `export LITELLM_MASTER_KEY=${e.litellmMasterKey}`,
    `export POSTGRES_PASSWORD=${e.postgresPassword}`,
    `export NEO4J_PASSWORD=${e.neo4jPassword}`,
    "",
    "# ─── Install Docker (no-op if base image already has it) ─────────────",
    "command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh",
    "systemctl enable --now docker",
    "",
    "# ─── Pull images explicitly (avoids racing the run step) ─────────────",
    `docker pull ${shEsc(vpsAgentImage)}`,
    `docker pull ${shEsc(args.decepticonImage)}`,
    "",
    "# ─── Lay down Decepticon stack at /opt/decepticon ────────────────────",
    "# [T128 Bug #7] vps-agent's runner does `docker compose -f /opt/tensol/",
    "# docker-compose.yml up` — we drop the stack on disk + symlink. Files",
    "# come from infra/decepticon-overrides/ embedded at build time.",
    "mkdir -p /opt/decepticon/config /opt/decepticon/decepticon/agents/prompts /opt/decepticon/workspace /opt/tensol",
    "",
    `cat > /opt/decepticon/docker-compose.yml <<'${COMPOSE_EOF}'`,
    DECEPTICON_COMPOSE_YML.replace(/\n$/, ""),
    COMPOSE_EOF,
    "",
    `cat > /opt/decepticon/config/litellm.yaml <<'${LITELLM_EOF}'`,
    litellmYaml.replace(/\n$/, ""),
    LITELLM_EOF,
    "",
    `cat > /opt/decepticon/decepticon/agents/prompts/recon.md <<'${RECON_EOF}'`,
    DECEPTICON_RECON_MD.replace(/\n$/, ""),
    RECON_EOF,
    "",
    "# Secrets for the compose stack (single-quoted so $-expansion stays off).",
    "cat > /opt/decepticon/.env <<ENV_EOF",
    "DECEPTICON_VERSION=latest",
    `OPENROUTER_API_KEY=${e.openrouterApiKey}`,
    `LITELLM_MASTER_KEY=${e.litellmMasterKey}`,
    `POSTGRES_PASSWORD=${e.postgresPassword}`,
    `NEO4J_PASSWORD=${e.neo4jPassword}`,
    "DECEPTICON_MODEL_PROFILE=eco",
    "DECEPTICON_ASSISTANT_ID=recon",
    ...decepticonAuthEnvLines,
    "ENV_EOF",
    "chmod 600 /opt/decepticon/.env",
    "",
    "# vps-agent expects compose at /opt/tensol/docker-compose.yml.",
    "ln -sf /opt/decepticon/docker-compose.yml /opt/tensol/docker-compose.yml",
    "",
    "# ─── Open agent port on the local firewall (best-effort) ─────────────",
    "if command -v ufw >/dev/null 2>&1; then",
    `  ufw allow ${agentPort}/tcp || true`,
    "fi",
    `iptables -I INPUT -p tcp --dport ${agentPort} -j ACCEPT || true`,
    "",
    "# ─── Run vps-agent (manages the Decepticon compose stack) ────────────",
    "# --add-host=host.docker.internal:host-gateway lets the agent (on default",
    "# `bridge` network) reach langgraph's :2024 (on compose's `decepticon-net`)",
    "# via the host's docker0 gateway. Compose binds :2024 on 0.0.0.0 (see",
    "# infra/decepticon-overrides/decepticon-vm-compose.yml).",
    "docker run -d \\",
    "  --name tensol-vps-agent \\",
    "  --restart unless-stopped \\",
    `  -p ${agentPort}:${agentPort} \\`,
    "  --add-host=host.docker.internal:host-gateway \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    "  -v /opt/decepticon:/opt/decepticon \\",
    "  -v /opt/tensol:/opt/tensol \\",
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
    "  -e OPENROUTER_API_KEY \\",
    "  -e LITELLM_MASTER_KEY \\",
    "  -e POSTGRES_PASSWORD \\",
    "  -e NEO4J_PASSWORD \\",
    `  -e PORT=${agentPort} \\`,
    "  -e DECEPTICON_LANGGRAPH_URL=http://host.docker.internal:2024 \\",
    `  ${shEsc(vpsAgentImage)}`,
    "",
  ];

  return lines.join("\n");
}
