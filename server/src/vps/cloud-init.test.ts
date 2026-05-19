/**
 * T045 — cloud-init.test.ts
 *
 * Tests for the per-scan Yandex VM bootstrap script generator
 * (`buildCloudInit`). The script is plugged into the VM's
 * `metadata["user-data"]` field at spawn time (see T043 → yandex.ts).
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
  awsAccessKeyId: "YCAJEtestaccesskeyABCDEFG",
  awsSecretAccessKey: "ycSecretKey-test-1234567",
  awsEndpoint: "https://storage.yandexcloud.net",
  awsRegion: "ru-central1",
  signKey: "hex-sign-key-abc123",
  decepticonImage: "ghcr.io/purpleailab/decepticon:latest",
  vpsAgentImage: "ghcr.io/tensol/vps-agent:1.0.0",
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

  test("substitutes all AWS_* env vars for S3 evidence upload", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).toMatch(/export AWS_ACCESS_KEY_ID=/);
    expect(out).toMatch(/export AWS_SECRET_ACCESS_KEY=/);
    expect(out).toMatch(/export AWS_ENDPOINT=/);
    expect(out).toMatch(/export AWS_REGION=/);
    expect(out).toContain("YCAJEtestaccesskeyABCDEFG");
    expect(out).toContain("ycSecretKey-test-1234567");
    expect(out).toContain("https://storage.yandexcloud.net");
    expect(out).toContain("ru-central1");
  });

  test("does NOT leave any unsubstituted Mustache-style placeholders", () => {
    const out = buildCloudInit(STABLE_ARGS);
    expect(out).not.toMatch(/\{\{[A-Z_][A-Za-z0-9_]*\}\}/);
  });

  test("only bash expansions in the template are an explicit allow-list", () => {
    // The template may LEGITIMATELY use ${VAR} for bash expansion at runtime
    // (e.g. a heredoc that the VM evaluates). Any other ${...} sequence is
    // a leaked template placeholder.
    const out = buildCloudInit(STABLE_ARGS);
    const ALLOW = new Set<string>([
      // No runtime bash expansions are needed: all values are baked at
      // build time via single-quoted `export VAR='value'` lines. If this
      // changes, add the var name here AND document why in cloud-init.ts.
    ]);
    const matches = Array.from(out.matchAll(/\$\{([A-Z_][A-Za-z0-9_]*)\}/g));
    const leaked = matches
      .map((m) => m[1])
      .filter((v): v is string => typeof v === "string" && !ALLOW.has(v));
    expect(leaked).toEqual([]);
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
});
