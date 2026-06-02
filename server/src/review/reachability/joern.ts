/**
 * 004-sthrip-pr-review — Joern reachability adapter (T032).
 *
 * Joern (Apache-2.0) is an EXTERNAL binary invoked out-of-process. It is
 * NEVER npm-linked. This module provides:
 *
 *   - {@link ReachabilityResult}: one finding's taint-analysis outcome.
 *   - {@link ReachabilityClient}: interface every adapter implements.
 *   - {@link FakeJoernClient}: deterministic test double with a canned map.
 *   - {@link createJoernClient}: factory that spawns Joern when the binary
 *     is present; returns `{}` (gracefully degrades) on any error/absence.
 *
 * Graceful-degrade contract (CRITICAL):
 *   - Empty `joernBin` → return `{}` without attempting to check or spawn.
 *   - `whichImpl(bin)` returns false (binary not on PATH / not present) →
 *     return `{}` without spawning.
 *   - Spawn throws → catch, return `{}`.
 *   - Non-zero exit code → return `{}`.
 *   - Stdout empty / non-JSON / unexpected shape → return `{}`.
 *   - Any other error → return `{}`.
 *
 * The caller (`engine.ts` / `verify.ts`) labels findings lower-confidence
 * when this returns `{}` — this module MUST NEVER throw.
 *
 * ## Joern invocation contract
 *
 * The adapter runs a bundled taint-query script:
 *
 *   joern --script scripts/taint-query.sc \
 *         --param repoDir=<dir> \
 *         --param fingerprintsJson=<json-array>
 *
 * The script emits a JSON array to stdout:
 *   [{ fingerprint: string; reachable: boolean; evidenceMd?: string }, ...]
 *
 * Non-conforming output is silently discarded; the adapter degrades to `{}`.
 */

import type { ReviewFinding } from "../types.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Taint-analysis outcome for a single finding. */
export interface ReachabilityResult {
  /** `true` when Joern found a taint path from source to sink. */
  reachable: boolean;
  /** Markdown-formatted evidence / path trace (optional). */
  evidenceMd?: string;
}

/** Common interface for all reachability adapters. */
export interface ReachabilityClient {
  /**
   * Analyse the given findings in `repoDir` and return a map from fingerprint
   * to result. Fingerprints absent from the map were not analysed or degraded.
   * MUST NEVER throw.
   */
  analyze(args: {
    repoDir: string;
    findings: ReviewFinding[];
  }): Promise<Record<string, ReachabilityResult>>;
}

// ─── Fake (test double) ───────────────────────────────────────────────────────

/**
 * Deterministic test double. Constructed with a canned fingerprint→result map;
 * returns only entries whose fingerprint appears in the findings array.
 * Immutable to post-construction mutation of the source map.
 */
export class FakeJoernClient implements ReachabilityClient {
  readonly #canned: Readonly<Record<string, ReachabilityResult>>;

  constructor(canned: Record<string, ReachabilityResult>) {
    // Snapshot at construction — callers mutating their map afterwards are safe.
    this.#canned = Object.freeze({ ...canned });
  }

  async analyze(args: {
    repoDir: string;
    findings: ReviewFinding[];
  }): Promise<Record<string, ReachabilityResult>> {
    const out: Record<string, ReachabilityResult> = {};
    for (const finding of args.findings) {
      const entry = this.#canned[finding.fingerprint];
      if (entry !== undefined) {
        out[finding.fingerprint] = entry;
      }
    }
    return out;
  }
}

// ─── Injectable spawn types ───────────────────────────────────────────────────

/** Result returned by the injectable spawner. */
export type SpawnResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Injectable process spawner (mirrors the pattern in `sast/runner.ts`).
 * Tests substitute a deterministic fake; production uses {@link defaultSpawn}.
 */
export type SpawnFn = (
  cmd: string[],
  opts?: { cwd?: string },
) => Promise<SpawnResult>;

/** Injectable binary-existence probe. */
export type WhichFn = (bin: string) => Promise<boolean>;

// ─── Joern output schema ──────────────────────────────────────────────────────

/** One element in the JSON array Joern emits to stdout. */
interface JoernOutputRow {
  fingerprint: string;
  reachable: boolean;
  evidenceMd?: string;
}

/**
 * Safely parse the Joern JSON stdout. Returns `null` on any error so the
 * caller can degrade to `{}`.
 */
function parseJoernOutput(stdout: string): JoernOutputRow[] | null {
  if (!stdout || stdout.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: JoernOutputRow[] = [];
  for (const item of parsed) {
    if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>)["fingerprint"] === "string" &&
      typeof (item as Record<string, unknown>)["reachable"] === "boolean"
    ) {
      const row: JoernOutputRow = {
        fingerprint: (item as Record<string, unknown>)["fingerprint"] as string,
        reachable: (item as Record<string, unknown>)["reachable"] as boolean,
      };
      const evidenceMd = (item as Record<string, unknown>)["evidenceMd"];
      if (typeof evidenceMd === "string") {
        row.evidenceMd = evidenceMd;
      }
      rows.push(row);
    }
  }
  return rows;
}

// ─── Default helpers ──────────────────────────────────────────────────────────

/** Default spawner backed by `Bun.spawn`; collects stdout/stderr to strings. */
async function defaultSpawn(
  cmd: string[],
  opts?: { cwd?: string },
): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, {
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Default `which` probe: zero exit from `which <bin>` means installed. */
async function defaultWhich(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a real {@link ReachabilityClient} that delegates to the Joern binary.
 *
 * @param deps.joernBin   Path (or name) of the `joern` binary. Defaults to
 *                        `"joern"` (resolved via PATH). Pass a full path in CI.
 * @param deps.spawnImpl  Injectable async spawner; defaults to {@link defaultSpawn}.
 * @param deps.whichImpl  Injectable binary-existence probe; defaults to {@link defaultWhich}.
 *
 * The returned client NEVER throws — all error paths return `{}`.
 */
export function createJoernClient(deps?: {
  joernBin?: string;
  spawnImpl?: SpawnFn;
  whichImpl?: WhichFn;
}): ReachabilityClient {
  const joernBin = deps?.joernBin ?? "joern";
  const spawn = deps?.spawnImpl ?? defaultSpawn;
  const which = deps?.whichImpl ?? defaultWhich;

  return {
    async analyze(args: {
      repoDir: string;
      findings: ReviewFinding[];
    }): Promise<Record<string, ReachabilityResult>> {
      // 1. No binary path → degrade immediately.
      if (!joernBin) return {};

      // 2. No findings to analyse → nothing to report.
      if (args.findings.length === 0) return {};

      // 3. Check binary presence; absent → degrade.
      let present: boolean;
      try {
        present = await which(joernBin);
      } catch {
        return {};
      }
      if (!present) return {};

      // 4. Build argv and spawn Joern.
      const fingerprints = args.findings.map((f) => f.fingerprint);
      const cmd = [
        joernBin,
        "--script",
        "scripts/taint-query.sc",
        "--param",
        `repoDir=${args.repoDir}`,
        "--param",
        `fingerprintsJson=${JSON.stringify(fingerprints)}`,
      ];

      let result: SpawnResult;
      try {
        result = await spawn(cmd, { cwd: args.repoDir });
      } catch {
        return {};
      }

      // 5. Non-zero exit code → degrade.
      if (result.exitCode !== 0) return {};

      // 6. Parse and map output rows.
      const rows = parseJoernOutput(result.stdout);
      if (rows === null) return {};

      const out: Record<string, ReachabilityResult> = {};
      for (const row of rows) {
        const entry: ReachabilityResult = { reachable: row.reachable };
        if (row.evidenceMd !== undefined) {
          entry.evidenceMd = row.evidenceMd;
        }
        out[row.fingerprint] = entry;
      }
      return out;
    },
  };
}
