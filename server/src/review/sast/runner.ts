/**
 * 003-whitebox — SAST runner abstraction.
 *
 * SAST/secrets/SCA tools (Opengrep, Trivy, Gitleaks) are *candidate generators*,
 * never verdict-makers: they emit {@link RawFinding}s the LLM judge later adjudicates.
 * This module provides:
 *   - {@link SastRunner}: the common interface (a named tool that returns RawFindings).
 *   - {@link FakeSastRunner}: deterministic test double returning canned findings.
 *   - {@link CompositeSastRunner}: fan-out over many runners; a throwing runner
 *     contributes [] rather than failing the whole batch (graceful degradation).
 *   - {@link createCliSastRunner}: wraps a real CLI tool, parsing its SARIF stdout
 *     via {@link normalizeSarif}. If the binary is not installed, returns []
 *     (graceful degradation — a missing scanner must never break a review).
 *
 * Design rationale: `docs/research/2026-05-29-hacktron-whitebox-dossier.md` §SAST.
 * All functions are pure w.r.t. their inputs (no mutation; new arrays returned).
 */
import type { RawFinding, FindingSource } from "../types.ts";
import { normalizeSarif } from "../sarif.ts";

/** A named source of {@link RawFinding}s. */
export interface SastRunner {
  readonly name: string;
  run(args: { repoDir: string; files?: string[] }): Promise<RawFinding[]>;
}

/**
 * Deterministic test double. Returns a defensive copy of the canned findings
 * on every call (callers can never mutate the runner's internal state).
 */
export class FakeSastRunner implements SastRunner {
  readonly name: string;
  readonly #findings: readonly RawFinding[];

  constructor(name: string, findings: RawFinding[]) {
    this.name = name;
    // Freeze a snapshot so external mutation of the passed array can't leak in.
    this.#findings = [...findings];
  }

  async run(_args: { repoDir: string; files?: string[] }): Promise<RawFinding[]> {
    return [...this.#findings];
  }
}

/**
 * Runs every child runner and concatenates their findings. A child that throws
 * (or rejects) contributes [] and is swallowed — one broken scanner must never
 * fail the whole batch.
 */
export class CompositeSastRunner implements SastRunner {
  readonly name = "composite";
  readonly #runners: readonly SastRunner[];

  constructor(runners: SastRunner[]) {
    this.#runners = [...runners];
  }

  async run(args: { repoDir: string; files?: string[] }): Promise<RawFinding[]> {
    const results = await Promise.all(
      this.#runners.map(async (r) => {
        try {
          return await r.run(args);
        } catch {
          // Graceful degradation: a failing runner yields no findings.
          return [] as RawFinding[];
        }
      }),
    );
    return results.flat();
  }
}

/** Result of running an external command. */
export type SpawnResult = { exitCode: number; stdout: string; stderr: string };

/** Injectable process spawner (defaults to {@link defaultSpawn}). */
export type SpawnFn = (
  cmd: string[],
  opts?: { cwd?: string },
) => Promise<SpawnResult>;

/** The CLI tools this module knows how to drive. */
export type SastTool = "opengrep" | "trivy" | "gitleaks" | "osv-scanner" | "kingfisher";

/** Default {@link FindingSource} attributed to each tool's output. */
const TOOL_SOURCE: Record<SastTool, FindingSource> = {
  opengrep: "sast",
  trivy: "sca",
  gitleaks: "secrets",
  "osv-scanner": "sca",
  kingfisher: "secrets",
};

/**
 * Output format: SARIF tools emit JSON SARIF to stdout; Kingfisher emits a
 * custom JSON array. This distinguishes how we parse the output.
 */
type OutputFormat = "sarif" | "kingfisher-json";

const TOOL_OUTPUT_FORMAT: Record<SastTool, OutputFormat> = {
  opengrep: "sarif",
  trivy: "sarif",
  gitleaks: "sarif",
  "osv-scanner": "sarif",
  kingfisher: "kingfisher-json",
};

/**
 * Build the argv that emits SARIF (or JSON for Kingfisher) to stdout for a
 * given tool + repo dir. Kept pure + table-driven so it is trivially
 * unit-testable.
 *
 * @param rulesDir  Optional path to an AikidoSec-MIT/self-authored rules dir
 *                  for opengrep (STHRIP_OPENGREP_RULES_DIR). Ignored by other
 *                  tools.
 */
function buildArgv(
  tool: SastTool,
  bin: string,
  repoDir: string,
  rulesDir?: string,
): string[] {
  switch (tool) {
    case "opengrep": {
      const base = [bin, "scan", "--sarif", "-q"];
      if (rulesDir !== undefined && rulesDir.length > 0) {
        base.push("--config", rulesDir);
      }
      base.push(repoDir);
      return base;
    }
    case "trivy":
      return [bin, "fs", "--format", "sarif", repoDir];
    case "gitleaks":
      return [
        bin,
        "detect",
        "--report-format",
        "sarif",
        "--report-path",
        "/dev/stdout",
        "--no-banner",
        "-s",
        repoDir,
      ];
    case "osv-scanner":
      return [bin, "--format", "sarif", "-r", repoDir];
    case "kingfisher":
      return [bin, "scan", repoDir, "--format", "json"];
  }
}

/** Default spawner backed by Bun.spawn; collects stdout/stderr to strings. */
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

/** Default `which` probe: a zero exit code from `which <bin>` means installed. */
async function defaultWhich(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/** Safely parse SARIF JSON; non-JSON / non-object stdout yields no findings. */
function parseSarif(stdout: string, source: FindingSource): RawFinding[] {
  if (!stdout || stdout.trim().length === 0) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    // Tools sometimes emit banners / progress lines on stdout — tolerate it.
    return [];
  }
  try {
    return normalizeSarif(doc, source);
  } catch {
    // A malformed-but-valid-JSON SARIF must not crash the batch.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Kingfisher JSON normalizer.
// ---------------------------------------------------------------------------

/**
 * Normalize Kingfisher's JSON output (array of secret findings) into neutral
 * {@link RawFinding}s. Kingfisher does NOT emit SARIF natively; it outputs a
 * JSON array where each element describes one secret detection.
 *
 * Expected shape (all fields except `rule_id`, `description`, `file` are
 * optional — missing fields are omitted rather than filled with defaults):
 * ```json
 * [{ "rule_id": "...", "description": "...", "file": "...",
 *    "start_line": 5, "end_line": 5, "matched_text": "..." }]
 * ```
 *
 * A non-array, non-JSON, or empty payload returns `[]` without throwing.
 */
function parseKingfisherJson(stdout: string): RawFinding[] {
  if (!stdout || stdout.trim().length === 0) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const findings: RawFinding[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;

    const ruleId = typeof obj["rule_id"] === "string" ? obj["rule_id"] : undefined;
    const description =
      typeof obj["description"] === "string" ? obj["description"] : undefined;
    const file = typeof obj["file"] === "string" ? obj["file"] : undefined;

    // Both ruleId and file are required for a usable finding.
    if (ruleId === undefined || file === undefined) continue;

    const startLine =
      typeof obj["start_line"] === "number" && Number.isFinite(obj["start_line"])
        ? Math.trunc(obj["start_line"] as number)
        : undefined;
    const endLine =
      typeof obj["end_line"] === "number" && Number.isFinite(obj["end_line"])
        ? Math.trunc(obj["end_line"] as number)
        : undefined;
    const snippet =
      typeof obj["matched_text"] === "string" ? obj["matched_text"] : undefined;

    findings.push({
      ruleId,
      source: "secrets",
      filePath: file,
      message: description ?? ruleId,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
    });
  }
  return findings;
}

/**
 * Create a {@link SastRunner} that drives a real CLI tool and normalizes its
 * SARIF (or JSON for Kingfisher) stdout into {@link RawFinding}s.
 *
 * Graceful degradation (NEVER throws to caller):
 *   - If `whichImpl(bin)` is false (tool not installed) → return [] WITHOUT spawning.
 *   - If the spawned tool emits non-JSON stdout → return [].
 *   - If normalization throws → return [].
 *   - OSV-Scanner and Kingfisher are OPTIONAL sidecars: absent binary → [].
 *
 * @param rulesDir  Path to an AikidoSec-MIT/self-authored Opengrep rules
 *                  directory (STHRIP_OPENGREP_RULES_DIR). Non-empty value adds
 *                  `--config <rulesDir>` to the opengrep argv. Ignored for
 *                  all other tools.
 *
 * Determinism: spawn + which are injectable so tests never touch the real OS.
 */
export function createCliSastRunner(args: {
  tool: SastTool;
  source?: FindingSource;
  bin?: string;
  rulesDir?: string;
  spawnImpl?: SpawnFn;
  whichImpl?: (bin: string) => Promise<boolean>;
}): SastRunner {
  const tool = args.tool;
  const bin = args.bin ?? tool;
  const source = args.source ?? TOOL_SOURCE[tool];
  const rulesDir = args.rulesDir;
  const spawn = args.spawnImpl ?? defaultSpawn;
  const which = args.whichImpl ?? defaultWhich;
  const outputFormat = TOOL_OUTPUT_FORMAT[tool];

  return {
    name: tool,
    async run({ repoDir }: { repoDir: string; files?: string[] }): Promise<RawFinding[]> {
      const installed = await which(bin);
      if (!installed) return [];
      let result: SpawnResult;
      try {
        result = await spawn(buildArgv(tool, bin, repoDir, rulesDir), { cwd: repoDir });
      } catch {
        // Spawn failure (e.g. tool crashed) must not break the batch.
        return [];
      }
      if (outputFormat === "kingfisher-json") {
        return parseKingfisherJson(result.stdout);
      }
      return parseSarif(result.stdout, source);
    },
  };
}
