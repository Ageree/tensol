/**
 * decepticon-runner — wraps `docker compose up` for the Decepticon stack on
 * the VPS agent. Translates a `POST /scan` payload (scanId/targetUrl/profile)
 * into Decepticon env vars, runs compose with `--abort-on-container-exit`,
 * and resolves with a terminal status (`done` | `failed`) plus whatever
 * findings the agent wrote to `/workspace/findings/`.
 *
 * Terminal signals (in priority order):
 *   1. `docker compose` process exits           → done if 0 else failed/exit-code
 *   2. Wallclock `timeoutMs` exceeded           → failed/timeout_exceeded, compose killed
 *
 * Findings are collected best-effort on BOTH the success and failure paths
 * so that partial scan results aren't lost when compose crashes mid-run.
 *
 * Design notes:
 * - Pure-ish: all side-effecting deps (`spawn`, `collectFindings`, `now`,
 *   `sleep`) are injectable so tests never touch real docker or Bun.spawn.
 * - Profile is a literal pass-through env var — any internal mapping
 *   (recon → smaller agent pool, max → wider toolbelt) is Decepticon's job,
 *   not ours.
 * - We never throw on a docker failure; the result envelope always carries
 *   a status + failure_reason so the caller (T072 webhook poster) can
 *   relay either outcome through one code path.
 */

import {
  collectFindings as defaultCollectFindings,
  type CollectedFinding,
  type CollectionResult,
} from "./findings-collector.ts";

export type ScanProfile = "recon" | "standard" | "max";

export type RunScanArgs = {
  scanId: string;
  targetUrl: string;
  profile: ScanProfile;
  findingsDir: string;
  composeFile: string;
  timeoutMs?: number;
};

export type RunScanResult = {
  status: "done" | "failed";
  failure_reason: string | null;
  findings: CollectedFinding[];
  usage: { tokens: number; usd_cents: number } | null;
};

export type SpawnOpts = {
  env?: Record<string, string>;
};

export type SpawnImpl = (
  cmd: string[],
  opts?: SpawnOpts
) => {
  exited: Promise<number>;
  kill: () => void;
};

export type RunDecepticonDeps = {
  spawn?: SpawnImpl;
  collectFindings?: (
    opts: { dir: string }
  ) => Promise<CollectionResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1h

/**
 * Default spawn wrapper around `Bun.spawn`. Kept tiny so the test surface
 * doesn't have to mock Bun.spawn itself — tests inject a different
 * `SpawnImpl` and never reach this code path.
 */
function defaultSpawn(cmd: string[], opts?: SpawnOpts): ReturnType<SpawnImpl> {
  // We delegate to the Bun runtime; only invoked in production runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bun = (globalThis as any).Bun;
  if (!bun || typeof bun.spawn !== "function") {
    throw new Error("Bun.spawn is not available in this runtime");
  }
  const proc = bun.spawn(cmd, {
    env: { ...process.env, ...(opts?.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: proc.exited as Promise<number>,
    kill: () => {
      try {
        proc.kill();
      } catch {
        // Ignore — process may already be terminated.
      }
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildEnv(args: RunScanArgs): Record<string, string> {
  return {
    TENSOL_SCAN_ID: args.scanId,
    DECEPTICON_TARGET_URL: args.targetUrl,
    DECEPTICON_PROFILE: args.profile,
    DECEPTICON_FINDINGS_DIR: args.findingsDir,
  };
}

function buildCmd(args: RunScanArgs): string[] {
  return [
    "docker",
    "compose",
    "-f",
    args.composeFile,
    "up",
    "--abort-on-container-exit",
  ];
}

/**
 * Best-effort findings collection that never throws. If the findings dir
 * is missing or unreadable (common when compose crashed before mounting
 * anything), we treat it as "no findings yet" and let the caller decide
 * what to do with the failure_reason.
 */
async function collectSafe(
  collect: (opts: { dir: string }) => Promise<CollectionResult>,
  dir: string
): Promise<CollectedFinding[]> {
  try {
    const { findings } = await collect({ dir });
    return findings;
  } catch {
    return [];
  }
}

type TimeoutOutcome = { kind: "timeout" };
type ExitOutcome = { kind: "exit"; code: number };

export async function runDecepticonScan(
  args: RunScanArgs,
  deps: RunDecepticonDeps = {}
): Promise<RunScanResult> {
  const spawn = deps.spawn ?? defaultSpawn;
  const collect = deps.collectFindings ?? defaultCollectFindings;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const cmd = buildCmd(args);
  const env = buildEnv(args);
  const proc = spawn(cmd, { env });

  const exitPromise: Promise<ExitOutcome> = proc.exited.then((code) => ({
    kind: "exit",
    code,
  }));
  const timeoutPromise: Promise<TimeoutOutcome> = sleep(timeoutMs).then(() => ({
    kind: "timeout",
  }));

  const outcome = await Promise.race([exitPromise, timeoutPromise]);

  if (outcome.kind === "timeout") {
    proc.kill();
    // Give the kill signal a tick to land so any flushed findings are
    // visible before we collect; but don't block the runner forever.
    await sleep(0);
    const findings = await collectSafe(collect, args.findingsDir);
    return {
      status: "failed",
      failure_reason: "timeout_exceeded",
      findings,
      usage: null,
    };
  }

  // Compose has exited on its own.
  const findings = await collectSafe(collect, args.findingsDir);
  if (outcome.code === 0) {
    return {
      status: "done",
      failure_reason: null,
      findings,
      usage: null,
    };
  }
  return {
    status: "failed",
    failure_reason: `docker_exit_${outcome.code}`,
    findings,
    usage: null,
  };
}
