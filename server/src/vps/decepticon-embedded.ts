/**
 * Decepticon stack assets (T128 Bug #7) embedded at build time and laid
 * onto each ephemeral Yandex VM by `cloud-init.ts`.
 *
 * Three host-side override files live as the source of truth under
 * `infra/decepticon-overrides/`:
 *
 *   - `decepticon-vm-compose.yml` — minimal 5-service Decepticon stack
 *     (postgres / neo4j / litellm / sandbox / langgraph). Dropped at
 *     `/opt/decepticon/docker-compose.yml` on the VM.
 *
 *   - `litellm.yaml` — LiteLLM proxy config routing every Decepticon
 *     model name through `openrouter/qwen/qwen3.7-max`. Dropped at
 *     `/opt/decepticon/config/litellm.yaml`.
 *
 *   - `recon.md` — Decepticon recon-agent prompt with the Tensol Rule 4b
 *     KG_PERSISTENCE override (verifier reads only the KG, so findings
 *     MUST be written there in addition to markdown). Dropped at
 *     `/opt/decepticon/decepticon/agents/prompts/recon.md`.
 *
 * Reading the files at module-load time (rather than via `fetch` or
 * `git clone` at cloud-init time) keeps the contract reproducible and
 * removes the VM's network-egress dependency on github.com.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// import.meta.dirname is Bun-native; equivalent of CommonJS __dirname.
const OVERRIDES_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "infra",
  "decepticon-overrides",
);

/**
 * Read one of the embedded asset files. Crashes loud at import time if a
 * file is missing — that means the host-side source of truth disappeared
 * and shipping a broken cloud-init payload would be worse than refusing
 * to boot.
 */
function readOverride(name: string): string {
  const path = join(OVERRIDES_DIR, name);
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `decepticon-embedded: required override not found at ${path}: ${msg}`,
    );
  }
}

export const DECEPTICON_COMPOSE_YML = readOverride(
  "decepticon-vm-compose.yml",
);
export const DECEPTICON_LITELLM_YAML = readOverride("litellm.yaml");
export const DECEPTICON_RECON_MD = readOverride("recon.md");
