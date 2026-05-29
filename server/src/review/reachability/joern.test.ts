/**
 * TDD tests for the Joern reachability adapter (T028).
 *
 * Covers:
 *   - FakeJoernClient: returns canned fingerprint→{reachable,evidenceMd} map.
 *   - createJoernClient with missing binary: returns {} without crashing.
 *   - createJoernClient with present binary and successful output: returns
 *     parsed reachability results keyed by fingerprint.
 *   - createJoernClient with binary present but spawn errors: returns {}
 *     gracefully.
 *   - createJoernClient with binary present but malformed output: returns {}.
 *
 * Spawn and which are fully injected — no real OS access.
 */
import { test, expect, describe } from "bun:test";
import type { ReviewFinding } from "../types.ts";
import {
  FakeJoernClient,
  createJoernClient,
  type ReachabilityResult,
  type ReachabilityClient,
  type SpawnResult,
  type SpawnFn,
  type WhichFn,
} from "./joern.ts";

// Minimal ReviewFinding stubs (only fingerprint field is keyed).
function makeFindings(fingerprints: string[]): ReviewFinding[] {
  return fingerprints.map((fp) => ({
    fingerprint: fp,
    filePath: "src/app.ts",
    side: "RIGHT" as const,
    severity: "high" as const,
    cwe: ["CWE-89"],
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    cvssScore: 9.8,
    confidence: "high" as const,
    reachable: false,
    category: "SQL Injection",
    title: "Possible SQL injection",
    rationaleMd: "User input reaches SQL sink without sanitization.",
    source: "llm" as const,
  }));
}

/** A canonical Joern taint-query output with two findings. */
const JOERN_TAINT_OUTPUT = JSON.stringify([
  {
    fingerprint: "fp1",
    reachable: true,
    evidenceMd: "Taint path found: source `req.body.id` → sink `db.query()`",
  },
  {
    fingerprint: "fp2",
    reachable: false,
  },
]);

/** A whichImpl that always reports the binary as present. */
const presentWhich: WhichFn = async () => true;

/** A whichImpl that always reports the binary as absent. */
const absentWhich: WhichFn = async () => false;

/** Make a spawnImpl that returns the given stdout/exitCode. */
function makeSpawn(stdout: string, exitCode = 0): SpawnFn {
  return async (_cmd, _opts): Promise<SpawnResult> => ({
    exitCode,
    stdout,
    stderr: "",
  });
}

// ─── FakeJoernClient ─────────────────────────────────────────────────────────

describe("FakeJoernClient", () => {
  test("returns canned results for known fingerprints", async () => {
    const canned: Record<string, ReachabilityResult> = {
      fp1: { reachable: true, evidenceMd: "Taint path: a→b→c" },
      fp2: { reachable: false },
    };
    const client = new FakeJoernClient(canned);
    const findings = makeFindings(["fp1", "fp2"]);
    const result = await client.analyze({ repoDir: "/repo", findings });

    expect(result["fp1"]).toEqual({ reachable: true, evidenceMd: "Taint path: a→b→c" });
    expect(result["fp2"]).toEqual({ reachable: false });
  });

  test("omits entries for fingerprints not in the canned map", async () => {
    const canned: Record<string, ReachabilityResult> = {
      fp1: { reachable: true },
    };
    const client = new FakeJoernClient(canned);
    const findings = makeFindings(["fp1", "unknown-fp"]);
    const result = await client.analyze({ repoDir: "/repo", findings });

    expect(Object.keys(result)).toEqual(["fp1"]);
    expect(result["unknown-fp"]).toBeUndefined();
  });

  test("returns {} when no findings match the canned map", async () => {
    const client = new FakeJoernClient({ fp1: { reachable: true } });
    const findings = makeFindings(["fp-none"]);
    const result = await client.analyze({ repoDir: "/repo", findings });

    expect(result).toEqual({});
  });

  test("returns {} when findings array is empty", async () => {
    const client = new FakeJoernClient({ fp1: { reachable: true } });
    const result = await client.analyze({ repoDir: "/repo", findings: [] });
    expect(result).toEqual({});
  });

  test("is immutable to external mutation of the canned map after construction", async () => {
    const canned: Record<string, ReachabilityResult> = {
      fp1: { reachable: true },
    };
    const client = new FakeJoernClient(canned);
    // Mutate the original map after construction.
    canned["fp1"] = { reachable: false };

    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });
    // Snapshot taken at construction — not affected by later mutation.
    expect(result["fp1"]!.reachable).toBe(true);
  });

  test("satisfies the ReachabilityClient interface", () => {
    const client: ReachabilityClient = new FakeJoernClient({});
    expect(typeof client.analyze).toBe("function");
  });
});

// ─── createJoernClient — binary absent ───────────────────────────────────────

describe("createJoernClient — binary absent", () => {
  test("returns {} without spawning when whichImpl says absent", async () => {
    let spawnCalled = false;
    const trackingSpawn: SpawnFn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: JOERN_TAINT_OUTPUT, stderr: "" };
    };

    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: trackingSpawn,
      whichImpl: absentWhich,
    });

    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });

    expect(result).toEqual({});
    expect(spawnCalled).toBe(false);
  });

  test("returns {} when joernBin is empty string", async () => {
    const client = createJoernClient({
      joernBin: "",
      spawnImpl: makeSpawn(JOERN_TAINT_OUTPUT),
      whichImpl: presentWhich,
    });
    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });
    expect(result).toEqual({});
  });

  test("returns {} when findings array is empty (no reason to spawn)", async () => {
    let spawnCalled = false;
    const trackingSpawn: SpawnFn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: JOERN_TAINT_OUTPUT, stderr: "" };
    };
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: trackingSpawn,
      whichImpl: presentWhich,
    });
    const result = await client.analyze({ repoDir: "/repo", findings: [] });
    expect(result).toEqual({});
    expect(spawnCalled).toBe(false);
  });
});

// ─── createJoernClient — binary present, successful run ──────────────────────

describe("createJoernClient — binary present, successful run", () => {
  test("returns parsed reachability results keyed by fingerprint", async () => {
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: makeSpawn(JOERN_TAINT_OUTPUT),
      whichImpl: presentWhich,
    });
    const findings = makeFindings(["fp1", "fp2"]);
    const result = await client.analyze({ repoDir: "/repo", findings });

    expect(result["fp1"]).toEqual({
      reachable: true,
      evidenceMd: "Taint path found: source `req.body.id` → sink `db.query()`",
    });
    expect(result["fp2"]).toEqual({ reachable: false });
  });

  test("includes only fingerprints present in Joern output (not all findings)", async () => {
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: makeSpawn(JOERN_TAINT_OUTPUT),
      whichImpl: presentWhich,
    });
    const findings = makeFindings(["fp1", "fp2", "fp3"]);
    const result = await client.analyze({ repoDir: "/repo", findings });

    expect(Object.keys(result).sort()).toEqual(["fp1", "fp2"]);
    expect(result["fp3"]).toBeUndefined();
  });

  test("passes the fingerprints and repoDir to the spawn argv", async () => {
    const calls: Array<{ cmd: string[]; cwd: string | undefined }> = [];
    const trackingSpawn: SpawnFn = async (cmd, opts) => {
      calls.push({ cmd, cwd: opts?.cwd });
      return { exitCode: 0, stdout: "[]", stderr: "" };
    };
    const client = createJoernClient({
      joernBin: "/usr/local/bin/joern",
      spawnImpl: trackingSpawn,
      whichImpl: presentWhich,
    });
    await client.analyze({ repoDir: "/my/repo", findings: makeFindings(["fp1"]) });

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.cmd[0]).toBe("/usr/local/bin/joern");
    // Fingerprints JSON should be in the argv.
    expect(call.cmd.join(" ")).toContain("fp1");
    expect(call.cwd).toBe("/my/repo");
  });

  test("non-zero exit code yields {} gracefully", async () => {
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: makeSpawn(JOERN_TAINT_OUTPUT, 1),
      whichImpl: presentWhich,
    });
    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });
    expect(result).toEqual({});
  });

  test("empty Joern output (no findings analysed) yields {}", async () => {
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: makeSpawn("[]"),
      whichImpl: presentWhich,
    });
    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });
    expect(result).toEqual({});
  });
});

// ─── createJoernClient — graceful degrade ────────────────────────────────────

describe("createJoernClient — graceful degrade", () => {
  test("returns {} when spawnImpl throws (e.g. ENOENT)", async () => {
    const throwingSpawn: SpawnFn = async () => {
      throw new Error("ENOENT: spawn error");
    };
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: throwingSpawn,
      whichImpl: presentWhich,
    });

    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });
    expect(result).toEqual({});
  });

  test("returns {} when stdout is not valid JSON", async () => {
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: makeSpawn("not json at all"),
      whichImpl: presentWhich,
    });
    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });
    expect(result).toEqual({});
  });

  test("returns {} when stdout is empty", async () => {
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: makeSpawn(""),
      whichImpl: presentWhich,
    });
    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });
    expect(result).toEqual({});
  });

  test("returns {} when stdout is valid JSON but not an array", async () => {
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: makeSpawn('{"error":"not an array"}'),
      whichImpl: presentWhich,
    });
    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });
    expect(result).toEqual({});
  });

  test("returns {} when whichImpl itself throws", async () => {
    const throwingWhich: WhichFn = async () => {
      throw new Error("which exploded");
    };
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: makeSpawn(JOERN_TAINT_OUTPUT),
      whichImpl: throwingWhich,
    });
    const findings = makeFindings(["fp1"]);
    const result = await client.analyze({ repoDir: "/repo", findings });
    expect(result).toEqual({});
  });

  test("never throws regardless of errors — caller always gets a Record", async () => {
    const alwaysThrow: SpawnFn = async () => {
      throw new Error("catastrophic");
    };
    const client = createJoernClient({
      joernBin: "joern",
      spawnImpl: alwaysThrow,
      whichImpl: presentWhich,
    });

    let threw = false;
    let result: Record<string, ReachabilityResult> = {};
    try {
      result = await client.analyze({ repoDir: "/repo", findings: makeFindings(["fp1"]) });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toEqual({});
  });
});
