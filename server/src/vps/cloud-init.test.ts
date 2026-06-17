/**
 * T045 — cloud-init.test.ts
 *
 * Tests for the per-scan GCP VM bootstrap script generator
 * (`buildCloudInit`). The script is plugged into the VM's
 * `metadata["user-data"]` field at spawn time (see T043 → gcp.ts).
 *
 * Strategy: a mix of structural assertions (presence of shebang, docker
 * commands, env-var names) and an injection-safety test for shell escape.
 * No byte-exact golden file — we want freedom to refactor the layout
 * without churning a fixture.
 *
 * Per Constitution VI: tests use synthetic credentials only.
 */

import { describe, test, expect } from "bun:test";
import { buildCloudInit, type BuildCloudInitArgs } from "./cloud-init.ts";

const STABLE_ARGS: BuildCloudInitArgs = {
  scanId: "01ABCDEF01234567890ABCDEFGH",
  backendUrl: "https://api.tensol.example/v1",
  webhookSecret: "deadbeef-test-secret",
  evidenceBucket: "tensol-test-bucket",
  evidencePrefix: "evidence/",
  signKey: "hex-sign-key-abc123",
  decepticonImage: "ghcr.io/purpleailab/decepticon:latest",
  vpsAgentImage: "ghcr.io/tensol/vps-agent:1.0.0",
  openrouterApiKey: "sk-or-v1-test-fake-key-for-cloud-init-tests",
  litellmMasterKey: "sk-test-litellm-internal",
  postgresPassword: "test-postgres-pw",
  neo4jPassword: "test-neo4j-pw",
};

describe("buildCloudInit", () => {
  test("renders a complete bash script with shebang and strict mode", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out.startsWith("#!/bin/bash\n")).toBe(true);
    expect(out).toMatch(/set -euo pipefail/);
  });

  test("substitutes all TENSOL_* env vars from the .env.example contract", () => {
    const out = buildCloudInit(STABLE_ARGS);
    // The 6 TENSOL_* vars documented in vps-agent/.env.example must all be
    // exported (so `docker run -e VAR` can pass them through).
    expect(out).toMatch(/export TENSOL_SCAN_ID=/);
    expect(out).toMatch(/export TENSOL_SIGN_KEY=/);
    expect(out).toMatch(/export TENSOL_WEBHOOK_BACKEND_URL=/);
    expect(out).toMatch(/export TENSOL_WEBHOOK_SECRET=/);
    expect(out).toMatch(/export TENSOL_EVIDENCE_BUCKET=/);
    expect(out).toMatch(/export TENSOL_EVIDENCE_PREFIX=/);
    // Values reach the script body.
    expect(out).toContain("01ABCDEF01234567890ABCDEFGH");
    expect(out).toContain("hex-sign-key-abc123");
    expect(out).toContain("https://api.tensol.example/v1");
    expect(out).toContain("deadbeef-test-secret");
    expect(out).toContain("tensol-test-bucket");
    expect(out).toContain("evidence/");
  });

  test("does not require AWS_* env vars for GCS evidence upload", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).not.toMatch(/export AWS_ACCESS_KEY_ID=/);
    expect(out).not.toMatch(/export AWS_SECRET_ACCESS_KEY=/);
    expect(out).not.toMatch(/export AWS_ENDPOINT=/);
    expect(out).not.toMatch(/export AWS_REGION=/);
    expect(out).not.toMatch(/-e AWS_ACCESS_KEY_ID/);
    expect(out).not.toMatch(/-e AWS_SECRET_ACCESS_KEY/);
    expect(out).not.toMatch(/-e AWS_ENDPOINT/);
    expect(out).not.toMatch(/-e AWS_REGION/);
  });

  test("does NOT leave any unsubstituted Mustache-style placeholders", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).not.toMatch(/\{\{[A-Z_][A-Za-z0-9_]*\}\}/);
  });

  test("only bash expansions in the bash-script layer are an explicit allow-list", () => {
    // The bash-script layer of the cloud-init MUST NOT carry any
    // unsubstituted ${VAR} placeholders — every caller value is baked at
    // build time via single-quoted `export VAR='value'` lines.
    //
    // However, T128 Bug #7 introduced heredoc-embedded payload files
    // (decepticon-vm-compose.yml, litellm.yaml, recon.md). Those payloads
    // LEGITIMATELY contain `${VAR}` references — docker-compose expands
    // them at `docker compose up` time using `/opt/decepticon/.env`.
    // The single-quoted heredoc delimiter (`<<'TENSOL_*_EOF'`) tells the
    // VM shell NOT to expand them when writing the file, so they reach
    // disk literally and stay correct.
    //
    // To check leaks only in the bash-script layer, strip the heredoc
    // blocks first (delimiter line + content up to the closing delimiter).
    const out = buildCloudInit(STABLE_ARGS);
    const HEREDOC_RE = /<<'(TENSOL_[A-Z_]+_EOF)'[\s\S]*?\n\1\n/g;
    const bashOnly = out.replace(HEREDOC_RE, "");
    const ALLOW = new Set<string>([
      // No runtime bash expansions are needed: all values are baked at
      // build time via single-quoted `export VAR='value'` lines. If this
      // changes, add the var name here AND document why in cloud-init.ts.
    ]);
    const matches = Array.from(bashOnly.matchAll(/\$\{([A-Z_][A-Za-z0-9_]*)\}/g));
    const leaked = matches
      .map((m) => m[1])
      .filter((v): v is string => typeof v === "string" && !ALLOW.has(v));
    expect(leaked).toEqual([]);
  });

  test("[T128 Bug #7] lays down the Decepticon compose stack on disk", () => {
    const out = buildCloudInit(STABLE_ARGS);
    // Heredoc-writes for the three embedded files.
    expect(out).toContain("cat > /opt/decepticon/docker-compose.yml <<'");
    expect(out).toContain("cat > /opt/decepticon/config/litellm.yaml <<'");
    expect(out).toContain(
      "cat > /opt/decepticon/decepticon/agents/prompts/recon.md <<'",
    );
    // Compose YAML actually present in the payload (sniff for our header).
    expect(out).toContain("services:");
    expect(out).toContain("langgraph:");
    // LiteLLM override actually present (sniff for OpenRouter GLM route).
    expect(out).toContain("openrouter/z-ai/glm-5.2");
    // recon.md override actually present (Rule 4b marker).
    expect(out).toContain("TENSOL OVERRIDE");
    // Symlink to where vps-agent's runner expects compose.
    expect(out).toContain(
      "ln -sf /opt/decepticon/docker-compose.yml /opt/tensol/docker-compose.yml",
    );
    expect(out).toContain("ln -sf /opt/decepticon/.env /opt/tensol/.env");
  });

  test("[T128 Bug #7] writes /opt/decepticon/.env with secrets + chmod 600", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).toContain("OPENROUTER_API_KEY=");
    expect(out).toContain("LITELLM_MASTER_KEY=");
    expect(out).toContain("POSTGRES_PASSWORD=");
    expect(out).toContain("NEO4J_PASSWORD=");
    expect(out).toContain("chmod 600 /opt/decepticon/.env");
    // Concrete values from STABLE_ARGS reach the .env writer.
    expect(out).toContain("sk-or-v1-test-fake-key-for-cloud-init-tests");
  });

  test("shell-escapes single-quotes in arguments (injection defence)", () => {
    const out = buildCloudInit({
      ...STABLE_ARGS,
      webhookSecret: "evil'value",
    });
    // The raw, un-escaped value MUST NOT appear inside a single-quoted shell
    // string — that would let an attacker close the quote and inject commands.
    // After POSIX-safe escape ( '  →  '\''  ) the sequence appears as
    // `'evil'\''value'`.
    expect(out).toContain("'evil'\\''value'");
    // And the naive substring is only present as part of the escaped form.
    const naiveIdx = out.indexOf("evil'value");
    expect(naiveIdx).toBe(-1);
  });

  test("docker pull precedes docker run for the vps-agent image", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).toContain("docker pull");
    expect(out).toContain("docker run");
    const pullIdx = out.indexOf("docker pull");
    const runIdx = out.indexOf("docker run");
    expect(pullIdx).toBeLessThan(runIdx);
  });

  test("pre-pulls every Decepticon compose image before starting vps-agent", () => {
    const out = buildCloudInit(STABLE_ARGS);
    const runIdx = out.indexOf("docker run");
    for (const image of [
      "postgres:17-alpine",
      "neo4j:5.24-community",
      "ghcr.io/purpleailab/decepticon-litellm:latest",
      "ghcr.io/purpleailab/decepticon-sandbox:latest",
      "ghcr.io/purpleailab/decepticon-langgraph:latest",
    ]) {
      const pullLine = `docker pull '${image}'`;
      expect(out).toContain(pullLine);
      expect(out.indexOf(pullLine)).toBeLessThan(runIdx);
    }
  });

  test("mounts /var/run/docker.sock so vps-agent can run the Decepticon compose stack", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  test("publishes the vps-agent port (default 8080) for inbound /scan", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).toMatch(/-p\s+8080:8080/);
  });

  test("supports a custom agent port override", () => {
    const out = buildCloudInit({ ...STABLE_ARGS, agentPort: 9090 });
    expect(out).toMatch(/-p\s+9090:9090/);
    expect(out).not.toMatch(/-p\s+8080:8080/);
  });

  test("references the supplied Decepticon image (pre-pulled or env-baked)", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).toContain("ghcr.io/purpleailab/decepticon:latest");
  });

  test("references the supplied vps-agent image", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).toContain("ghcr.io/tensol/vps-agent:1.0.0");
  });

  test("uses an automatic restart policy for the vps-agent container", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).toMatch(/--restart[= ](unless-stopped|on-failure|always)/);
  });

  test("is deterministic — same args produce byte-identical output", () => {
    const a = buildCloudInit(STABLE_ARGS);
    const b = buildCloudInit(STABLE_ARGS);
    expect(a).toBe(b);
  });

  // --- P1: blackbox explicit model override (opt-in) ---

  test("default (no blackboxAgentModel) keeps the GLM hijack + anthropic auth", () => {
    const out = buildCloudInit(STABLE_ARGS);
    // openai/* routes still hijacked to GLM.
    expect(out).toContain("model_name: openai/gpt-5.5");
    expect(out).toContain("openrouter/z-ai/glm-5.2");
    for (const name of [
      "auth/claude-opus-4-7",
      "openrouter/anthropic/claude-opus-4-7",
    ]) {
      const block = new RegExp(
        `- model_name: ${name.replace(/[/.]/g, "\\$&")}\\n\\s+litellm_params:\\n\\s+model: openrouter/z-ai/glm-5\\.2`,
      );
      expect(block.test(out)).toBe(true);
    }
    // Auth path pinned to anthropic (synthetic key), not openai.
    expect(out).toContain("DECEPTICON_AUTH_PRIORITY=anthropic_api");
    expect(out).not.toContain("DECEPTICON_AUTH_PRIORITY=openai_api");
  });

  test("blackboxAgentModel repoints ONLY the openai/* routes to the requested model", () => {
    const out = buildCloudInit({ ...STABLE_ARGS, blackboxAgentModel: "z-ai/glm-5.2" });
    // The three openai routes now point to the real OpenRouter model.
    expect(out).toContain("model: openrouter/z-ai/glm-5.2");
    // …and no longer to the default hijack under an openai model_name. Assert each openai
    // block's target line is the real model (anchored, structural).
    for (const name of ["openai/gpt-5.5", "openai/gpt-5.4", "openai/gpt-5-nano"]) {
      const block = new RegExp(
        `- model_name: ${name.replace(/[.]/g, "\\.")}\\n\\s+litellm_params:\\n\\s+model: openrouter/z-ai/glm-5\\.2`,
      );
      expect(block.test(out)).toBe(true);
    }
    // The anthropic/* and nvidia_nim/* GLM hijacks remain untouched.
    expect(out).toContain("model_name: anthropic/claude-opus-4-7");
    expect(out).toMatch(
      /- model_name: anthropic\/claude-opus-4-7\n\s+litellm_params:\n\s+model: openrouter\/z-ai\/glm-5\.2/,
    );
  });

  test("blackboxAgentModel pins Decepticon to the openai auth path", () => {
    const out = buildCloudInit({ ...STABLE_ARGS, blackboxAgentModel: "z-ai/glm-5.2" });
    expect(out).toContain("DECEPTICON_AUTH_PRIORITY=openai_api");
    expect(out).toContain("OPENAI_API_KEY=sk-tensol-routes-via-litellm-model");
    // The anthropic synthetic-key path is replaced, not duplicated.
    expect(out).not.toContain("DECEPTICON_AUTH_PRIORITY=anthropic_api");
    expect(out).not.toContain("ANTHROPIC_API_KEY=sk-ant-tensol-routes-via-litellm-glm52");
  });

  test("blackbox repoint is still deterministic", () => {
    const args = { ...STABLE_ARGS, blackboxAgentModel: "z-ai/glm-5.2" };
    expect(buildCloudInit(args)).toBe(buildCloudInit(args));
  });
});
