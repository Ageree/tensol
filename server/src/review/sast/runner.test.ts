/**
 * Tests for the SAST runner abstraction (TDD-first).
 *
 * Covers:
 *   - FakeSastRunner returns its canned findings (and is mutation-safe).
 *   - CompositeSastRunner concatenates all children and swallows a thrower.
 *   - createCliSastRunner: skips spawn when the binary is absent; normalizes a
 *     canned opengrep SARIF when present; tolerates non-JSON stdout.
 *   - T035: opengrep passes --config when rulesDir is set.
 *   - T035: osv-scanner degrades to [] when absent; normalizes its SARIF.
 *   - T035: kingfisher degrades to [] when absent; normalizes its JSON output.
 *
 * Everything is deterministic — spawn + which are injected, no real OS access.
 */
import { test, expect, describe } from "bun:test";
import type { RawFinding } from "../types.ts";
import {
  FakeSastRunner,
  CompositeSastRunner,
  createCliSastRunner,
  type SastRunner,
  type SpawnResult,
} from "./runner.ts";

const fA: RawFinding = {
  ruleId: "rule.a",
  source: "sast",
  filePath: "src/a.ts",
  startLine: 10,
  message: "A finding",
};
const fB: RawFinding = {
  ruleId: "rule.b",
  source: "secrets",
  filePath: "src/b.ts",
  startLine: 20,
  message: "B finding",
};

/** A canonical opengrep SARIF doc with a single result. */
const OPENGREP_SARIF = JSON.stringify({
  version: "2.1.0",
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  runs: [
    {
      tool: {
        driver: {
          name: "opengrep",
          rules: [{ id: "javascript.lang.security.audit.sqli" }],
        },
      },
      results: [
        {
          ruleId: "javascript.lang.security.audit.sqli",
          message: { text: "Possible SQL injection." },
          level: "error",
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/db.ts" },
                region: { startLine: 42, endLine: 42 },
              },
            },
          ],
        },
      ],
    },
  ],
});

describe("FakeSastRunner", () => {
  test("returns the canned findings", async () => {
    const r = new FakeSastRunner("fake", [fA, fB]);
    expect(r.name).toBe("fake");
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([fA, fB]);
  });

  test("is immutable to external mutation of the source array", async () => {
    const src = [fA];
    const r = new FakeSastRunner("fake", src);
    src.push(fB); // mutate after construction
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([fA]); // snapshot, not the live array
  });

  test("returns a fresh array each call (callers can't mutate internal state)", async () => {
    const r = new FakeSastRunner("fake", [fA]);
    const first = await r.run({ repoDir: "/repo" });
    first.push(fB);
    const second = await r.run({ repoDir: "/repo" });
    expect(second).toEqual([fA]);
  });
});

describe("CompositeSastRunner", () => {
  test("concatenates findings from all children", async () => {
    const c = new CompositeSastRunner([
      new FakeSastRunner("one", [fA]),
      new FakeSastRunner("two", [fB]),
    ]);
    expect(c.name).toBe("composite");
    const out = await c.run({ repoDir: "/repo" });
    expect(out).toEqual([fA, fB]);
  });

  test("swallows a throwing child (contributes []) and keeps the rest", async () => {
    const thrower: SastRunner = {
      name: "boom",
      run: async () => {
        throw new Error("scanner exploded");
      },
    };
    const c = new CompositeSastRunner([
      new FakeSastRunner("one", [fA]),
      thrower,
      new FakeSastRunner("two", [fB]),
    ]);
    const out = await c.run({ repoDir: "/repo" });
    expect(out).toEqual([fA, fB]);
  });

  test("empty composite yields []", async () => {
    const c = new CompositeSastRunner([]);
    const out = await c.run({ repoDir: "/repo" });
    expect(out).toEqual([]);
  });
});

describe("createCliSastRunner", () => {
  test("name reflects the tool", () => {
    const r = createCliSastRunner({ tool: "opengrep" });
    expect(r.name).toBe("opengrep");
  });

  test("returns [] without spawning when the binary is not installed", async () => {
    let spawnCalls = 0;
    const spawnImpl = async (): Promise<SpawnResult> => {
      spawnCalls += 1;
      return { exitCode: 0, stdout: OPENGREP_SARIF, stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "opengrep",
      spawnImpl,
      whichImpl: async () => false,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([]);
    expect(spawnCalls).toBe(0); // never spawned
  });

  test("normalizes opengrep SARIF stdout into RawFindings when installed", async () => {
    const calls: string[][] = [];
    const spawnImpl = async (cmd: string[]): Promise<SpawnResult> => {
      calls.push(cmd);
      return { exitCode: 1, stdout: OPENGREP_SARIF, stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "opengrep",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });

    // argv carries the SARIF-to-stdout flags for opengrep.
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["opengrep", "scan", "--sarif", "-q", "/repo"]);

    // One result → one finding, attributed to the "sast" source by default.
    expect(out.length).toBe(1);
    expect(out[0]!.ruleId).toBe("javascript.lang.security.audit.sqli");
    expect(out[0]!.source).toBe("sast");
    expect(out[0]!.filePath).toBe("src/db.ts");
    expect(out[0]!.startLine).toBe(42);
    expect(out[0]!.message).toBe("Possible SQL injection.");
  });

  test("uses the provided source override for trivy", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout: OPENGREP_SARIF,
      stderr: "",
    });
    const r = createCliSastRunner({
      tool: "trivy",
      source: "sca",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out.length).toBe(1);
    expect(out[0]!.source).toBe("sca");
  });

  test("tolerates non-JSON stdout (returns [])", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout: "scanning... done. (not json)\n",
      stderr: "",
    });
    const r = createCliSastRunner({
      tool: "gitleaks",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([]);
  });

  test("empty stdout yields [] (no parse attempt)", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const r = createCliSastRunner({
      tool: "opengrep",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([]);
  });

  test("uses the correct gitleaks argv", async () => {
    const calls: string[][] = [];
    const spawnImpl = async (cmd: string[]): Promise<SpawnResult> => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "gitleaks",
      spawnImpl,
      whichImpl: async () => true,
    });
    await r.run({ repoDir: "/repo" });
    expect(calls[0]).toEqual([
      "gitleaks",
      "detect",
      "--report-format",
      "sarif",
      "--report-path",
      "/dev/stdout",
      "--no-banner",
      "-s",
      "/repo",
    ]);
  });

  test("returns [] when spawn itself throws", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => {
      throw new Error("ENOENT");
    };
    const r = createCliSastRunner({
      tool: "opengrep",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T035 — rulesDir injection for opengrep
// ---------------------------------------------------------------------------

describe("createCliSastRunner — opengrep rulesDir", () => {
  test("passes --config <rulesDir> when rulesDir is non-empty", async () => {
    const calls: string[][] = [];
    const spawnImpl = async (cmd: string[]): Promise<SpawnResult> => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "opengrep",
      rulesDir: "/opt/opengrep-rules",
      spawnImpl,
      whichImpl: async () => true,
    });
    await r.run({ repoDir: "/repo" });
    expect(calls.length).toBe(1);
    // Must include --config <rulesDir> in argv
    expect(calls[0]).toContain("--config");
    expect(calls[0]).toContain("/opt/opengrep-rules");
  });

  test("omits --config when rulesDir is empty string", async () => {
    const calls: string[][] = [];
    const spawnImpl = async (cmd: string[]): Promise<SpawnResult> => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "opengrep",
      rulesDir: "",
      spawnImpl,
      whichImpl: async () => true,
    });
    await r.run({ repoDir: "/repo" });
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toContain("--config");
  });

  test("omits --config when rulesDir is not passed", async () => {
    const calls: string[][] = [];
    const spawnImpl = async (cmd: string[]): Promise<SpawnResult> => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "opengrep",
      spawnImpl,
      whichImpl: async () => true,
    });
    await r.run({ repoDir: "/repo" });
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toContain("--config");
  });
});

// ---------------------------------------------------------------------------
// T035 — OSV-Scanner sidecar
// ---------------------------------------------------------------------------

/** Canonical OSV-Scanner SARIF output (single dep vuln result). */
const OSV_SARIF = JSON.stringify({
  version: "2.1.0",
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  runs: [
    {
      tool: {
        driver: {
          name: "osv-scanner",
          rules: [{ id: "CVE-2021-44228", properties: { "security-severity": "10.0" } }],
        },
      },
      results: [
        {
          ruleId: "CVE-2021-44228",
          message: { text: "log4j-core is vulnerable to CVE-2021-44228." },
          level: "error",
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "pom.xml" },
                region: { startLine: 12 },
              },
            },
          ],
        },
      ],
    },
  ],
});

describe("createCliSastRunner — osv-scanner sidecar", () => {
  test("name is osv-scanner", () => {
    const r = createCliSastRunner({ tool: "osv-scanner" });
    expect(r.name).toBe("osv-scanner");
  });

  test("returns [] without spawning when binary is absent (graceful degradation)", async () => {
    let spawnCalls = 0;
    const spawnImpl = async (): Promise<SpawnResult> => {
      spawnCalls += 1;
      return { exitCode: 0, stdout: OSV_SARIF, stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "osv-scanner",
      spawnImpl,
      whichImpl: async () => false,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([]);
    expect(spawnCalls).toBe(0);
  });

  test("uses correct argv for osv-scanner", async () => {
    const calls: string[][] = [];
    const spawnImpl = async (cmd: string[]): Promise<SpawnResult> => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "osv-scanner",
      spawnImpl,
      whichImpl: async () => true,
    });
    await r.run({ repoDir: "/repo" });
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["osv-scanner", "--format", "sarif", "-r", "/repo"]);
  });

  test("normalizes OSV-Scanner SARIF into RawFindings with source=sca", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout: OSV_SARIF,
      stderr: "",
    });
    const r = createCliSastRunner({
      tool: "osv-scanner",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out.length).toBe(1);
    expect(out[0]!.ruleId).toBe("CVE-2021-44228");
    expect(out[0]!.source).toBe("sca");
    expect(out[0]!.filePath).toBe("pom.xml");
    expect(out[0]!.startLine).toBe(12);
    expect(out[0]!.severity).toBe("critical"); // security-severity 10.0
  });

  test("returns [] and does not throw on spawn error", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => {
      throw new Error("ENOENT");
    };
    const r = createCliSastRunner({
      tool: "osv-scanner",
      spawnImpl,
      whichImpl: async () => true,
    });
    await expect(r.run({ repoDir: "/repo" })).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T035 — Kingfisher sidecar (JSON output, not SARIF)
// ---------------------------------------------------------------------------

/**
 * Canonical Kingfisher JSON output shape.
 * The tool outputs an array of secret findings (one object per finding).
 */
const KINGFISHER_JSON = JSON.stringify([
  {
    rule_id: "aws-access-key-id",
    description: "AWS Access Key ID",
    file: "config/secrets.env",
    start_line: 5,
    end_line: 5,
    matched_text: "AKIAIOSFODNN7EXAMPLE",
  },
  {
    rule_id: "github-pat",
    description: "GitHub Personal Access Token",
    file: "scripts/deploy.sh",
    start_line: 12,
  },
]);

describe("createCliSastRunner — kingfisher sidecar", () => {
  test("name is kingfisher", () => {
    const r = createCliSastRunner({ tool: "kingfisher" });
    expect(r.name).toBe("kingfisher");
  });

  test("returns [] without spawning when binary is absent (graceful degradation)", async () => {
    let spawnCalls = 0;
    const spawnImpl = async (): Promise<SpawnResult> => {
      spawnCalls += 1;
      return { exitCode: 0, stdout: KINGFISHER_JSON, stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "kingfisher",
      spawnImpl,
      whichImpl: async () => false,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([]);
    expect(spawnCalls).toBe(0);
  });

  test("uses correct argv for kingfisher", async () => {
    const calls: string[][] = [];
    const spawnImpl = async (cmd: string[]): Promise<SpawnResult> => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "[]", stderr: "" };
    };
    const r = createCliSastRunner({
      tool: "kingfisher",
      spawnImpl,
      whichImpl: async () => true,
    });
    await r.run({ repoDir: "/repo" });
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["kingfisher", "scan", "/repo", "--format", "json"]);
  });

  test("normalizes Kingfisher JSON into RawFindings with source=secrets", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout: KINGFISHER_JSON,
      stderr: "",
    });
    const r = createCliSastRunner({
      tool: "kingfisher",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out.length).toBe(2);
    expect(out[0]!.ruleId).toBe("aws-access-key-id");
    expect(out[0]!.source).toBe("secrets");
    expect(out[0]!.filePath).toBe("config/secrets.env");
    expect(out[0]!.startLine).toBe(5);
    expect(out[0]!.endLine).toBe(5);
    expect(out[0]!.message).toBe("AWS Access Key ID");
    expect(out[1]!.ruleId).toBe("github-pat");
    expect(out[1]!.filePath).toBe("scripts/deploy.sh");
    expect(out[1]!.startLine).toBe(12);
  });

  test("returns [] on empty JSON array", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });
    const r = createCliSastRunner({
      tool: "kingfisher",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([]);
  });

  test("returns [] on non-JSON output (graceful degradation)", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout: "scanning... not JSON",
      stderr: "",
    });
    const r = createCliSastRunner({
      tool: "kingfisher",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out).toEqual([]);
  });

  test("returns [] and does not throw on spawn error", async () => {
    const spawnImpl = async (): Promise<SpawnResult> => {
      throw new Error("ENOENT");
    };
    const r = createCliSastRunner({
      tool: "kingfisher",
      spawnImpl,
      whichImpl: async () => true,
    });
    await expect(r.run({ repoDir: "/repo" })).resolves.toEqual([]);
  });

  test("tolerates a single finding with missing optional fields", async () => {
    const minimal = JSON.stringify([
      { rule_id: "bare-rule", description: "Some secret", file: "main.py" },
    ]);
    const spawnImpl = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout: minimal,
      stderr: "",
    });
    const r = createCliSastRunner({
      tool: "kingfisher",
      spawnImpl,
      whichImpl: async () => true,
    });
    const out = await r.run({ repoDir: "/repo" });
    expect(out.length).toBe(1);
    expect(out[0]!.ruleId).toBe("bare-rule");
    expect(out[0]!.filePath).toBe("main.py");
    expect(out[0]!.startLine).toBeUndefined();
  });
});
