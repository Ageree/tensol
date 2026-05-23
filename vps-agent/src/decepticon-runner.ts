/**
 * decepticon-runner — triggers a Decepticon pentest scan against the
 * locally-running LangGraph Platform server (port 2024) on the ephemeral
 * Tensol scan VM.
 *
 * Flow (matches `external/decepticon/benchmark/harness.py:_invoke_agent`):
 *   1. `docker compose up -d` to start postgres/neo4j/litellm/sandbox/langgraph
 *      (compose has `restart: unless-stopped`, so we DO NOT use
 *      `--abort-on-container-exit`; the langgraph container is a server, not
 *      a one-shot job).
 *   2. Poll `http://127.0.0.1:2024/ok` until the LangGraph runtime is ready
 *      (bounded by `bootTimeoutMs`).
 *   3. `POST /threads` to create a thread.
 *   4. `POST /threads/{thread_id}/runs` with assistant_id derived from
 *      `args.profile` and the engagement input (target URL, workspace path,
 *      kickoff message that loads the recon skill).
 *   5. Poll `GET /threads/{thread_id}/runs/{run_id}` every 10s until terminal
 *      (`success | error | interrupted | cancelled | timeout`).
 *   6. Always: `docker compose down -v --remove-orphans` (best-effort).
 *   7. Always: collect findings from `args.findingsDir`.
 *
 * Terminal mapping:
 *   success                                     → status=done
 *   error|interrupted|cancelled|timeout         → status=failed, reason=langgraph_run_<status>
 *   /ok never returns 200 within bootTimeoutMs  → status=failed, reason=langgraph_boot_timeout
 *   wallclock timeoutMs exceeded                → status=failed, reason=timeout_exceeded
 *                                                 (best-effort cancel POST + compose down)
 *
 * All side-effecting dependencies (`spawn`, `fetcher`, `collectFindings`,
 * `now`, `sleep`) are injectable so tests can drive every branch without
 * touching docker or the network.
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
  /** Wall-clock budget for the entire scan (default 30 min). */
  timeoutMs?: number;
  /** Wall-clock budget for langgraph /ok readiness (default 10 min). */
  bootTimeoutMs?: number;
  /** LangGraph Platform base URL (default http://127.0.0.1:2024). */
  langgraphUrl?: string;
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

export type FetcherImpl = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export type RunDecepticonDeps = {
  spawn?: SpawnImpl;
  fetcher?: FetcherImpl;
  collectFindings?: (
    opts: { dir: string }
  ) => Promise<CollectionResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_BOOT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_LANGGRAPH_URL = "http://127.0.0.1:2024";
const BOOT_POLL_INTERVAL_MS = 5_000;
const RUN_POLL_INTERVAL_MS = 10_000;
const TERMINAL_STATUSES = new Set([
  "success",
  "error",
  "interrupted",
  "cancelled",
  "timeout",
]);

/**
 * Default spawn wrapper around `Bun.spawn`. Tests inject a different
 * `SpawnImpl` and never reach this code path.
 */
function defaultSpawn(cmd: string[], opts?: SpawnOpts): ReturnType<SpawnImpl> {
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
        // Already terminated.
      }
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultNow(): number {
  return Date.now();
}

const defaultFetcher: FetcherImpl = async (input, init) => {
  const res = await fetch(input, init);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
    text: () => res.text(),
  };
};

/**
 * Map Tensol scan profile → Decepticon LangGraph assistant_id.
 *
 * Source of truth: `external/decepticon/langgraph.json`. Valid IDs include
 * `decepticon` (full kill-chain orchestrator), `recon` (autonomous recon
 * sub-agent), `soundwave`, `exploit`, etc.
 *
 * Tensol profiles:
 *   - recon    → only OSINT + surface mapping → `recon`
 *   - standard → full kill-chain              → `decepticon`
 *   - max      → full kill-chain              → `decepticon`
 */
function assistantIdForProfile(profile: ScanProfile): string {
  if (profile === "recon") return "recon";
  return "decepticon";
}

function buildComposeUpCmd(args: RunScanArgs): string[] {
  return ["docker", "compose", "-f", args.composeFile, "up", "-d"];
}

function buildComposeDownCmd(args: RunScanArgs): string[] {
  return [
    "docker",
    "compose",
    "-f",
    args.composeFile,
    "down",
    "-v",
    "--remove-orphans",
  ];
}

function buildEnv(args: RunScanArgs): Record<string, string> {
  return {
    TENSOL_SCAN_ID: args.scanId,
    DECEPTICON_TARGET_URL: args.targetUrl,
    DECEPTICON_PROFILE: args.profile,
    DECEPTICON_FINDINGS_DIR: args.findingsDir,
  };
}

function buildKickoffPrompt(args: RunScanArgs): string {
  return (
    `Pentest target: ${args.targetUrl}. ` +
    `Use load_skill("/skills/recon/SKILL.md"). ` +
    `Write findings to /workspace/findings/${args.scanId}/ ` +
    `as YAML-frontmatter markdown files.`
  );
}

function buildRunInput(args: RunScanArgs): {
  assistant_id: string;
  input: Record<string, unknown>;
  config: Record<string, unknown>;
} {
  const workspace = `/workspace/tensol-${args.scanId}`;
  return {
    assistant_id: assistantIdForProfile(args.profile),
    input: {
      messages: [{ role: "human", content: buildKickoffPrompt(args) }],
      engagement_name: `tensol-${args.scanId}`,
      workspace_path: workspace,
      target_url: args.targetUrl,
    },
    config: {
      configurable: { workspace },
      recursion_limit: 400,
    },
  };
}

/**
 * Best-effort findings collection that never throws.
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

/**
 * Best-effort `docker compose down` — used in both success and failure
 * paths to release the ephemeral VM resources. Swallows errors because
 * the scan envelope must always be returned to the server.
 */
async function composeDown(
  spawn: SpawnImpl,
  args: RunScanArgs
): Promise<void> {
  try {
    const proc = spawn(buildComposeDownCmd(args), { env: buildEnv(args) });
    await proc.exited;
  } catch {
    // Compose may already be down; nothing to do.
  }
}

/**
 * Poll `<langgraphUrl>/ok` until 200 or boot budget exhausted.
 *
 * Returns `true` on ready, `false` on timeout. Treats any non-200 / network
 * error as "not yet ready" — that mirrors langgraph's startup behaviour
 * where the HTTP listener binds before agents finish loading.
 */
async function waitForLanggraph(
  baseUrl: string,
  budgetMs: number,
  fetcher: FetcherImpl,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<boolean> {
  const deadline = now() + budgetMs;
  while (now() < deadline) {
    try {
      const res = await fetcher(`${baseUrl}/ok`, { method: "GET" });
      if (res.ok) return true;
    } catch {
      // Connection refused or similar → still booting.
    }
    await sleep(BOOT_POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * Create a thread on the LangGraph server.
 */
async function createThread(
  baseUrl: string,
  fetcher: FetcherImpl
): Promise<string> {
  const res = await fetcher(`${baseUrl}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`thread create failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { thread_id?: string };
  if (!body.thread_id || typeof body.thread_id !== "string") {
    throw new Error("thread create response missing thread_id");
  }
  return body.thread_id;
}

/**
 * Submit a run on a thread and return the run_id.
 */
async function createRun(
  baseUrl: string,
  threadId: string,
  payload: Record<string, unknown>,
  fetcher: FetcherImpl
): Promise<string> {
  const res = await fetcher(`${baseUrl}/threads/${threadId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`run create failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { run_id?: string };
  if (!body.run_id || typeof body.run_id !== "string") {
    throw new Error("run create response missing run_id");
  }
  return body.run_id;
}

type RunPollOutcome =
  | { kind: "terminal"; status: string; error?: string }
  | { kind: "wallclock" };

/**
 * Poll the run status until terminal or wallclock deadline.
 *
 * Network errors during polling are tolerated (transient langgraph hiccups
 * shouldn't fail the scan); only the wallclock budget can abort.
 */
async function pollRun(
  baseUrl: string,
  threadId: string,
  runId: string,
  deadline: number,
  fetcher: FetcherImpl,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<RunPollOutcome> {
  while (now() < deadline) {
    try {
      const res = await fetcher(
        `${baseUrl}/threads/${threadId}/runs/${runId}`,
        { method: "GET" }
      );
      if (res.ok) {
        const body = (await res.json()) as {
          status?: unknown;
          error?: unknown;
        };
        const status = typeof body.status === "string" ? body.status : null;
        if (status !== null && TERMINAL_STATUSES.has(status)) {
          // For error/timeout/interrupted statuses, the top-level `error`
          // field of the run object is often null. The real error message
          // lives in the latest checkpoint's state on the thread itself.
          // GET /threads/{tid}/state returns the merged state including any
          // `__error__` field that langgraph nodes set on uncaught exceptions.
          let errorDetail: string | undefined;
          if (status !== "success") {
            errorDetail = await tryExtractError(
              baseUrl,
              threadId,
              fetcher,
              body
            );
          }
          return errorDetail
            ? { kind: "terminal", status, error: errorDetail }
            : { kind: "terminal", status };
        }
      }
    } catch {
      // Transient — keep polling.
    }
    await sleep(RUN_POLL_INTERVAL_MS);
  }
  return { kind: "wallclock" };
}

/**
 * Multi-source error extraction:
 *   1. Run object's top-level `error` field (rarely populated by langgraph).
 *   2. Thread state's `__error__` / latest `values` (where node exceptions land).
 *   3. Stream endpoint `/runs/{rid}/stream` final event (last-resort, slow).
 * Returns up to 500 chars or undefined if no error detail found anywhere.
 */
async function tryExtractError(
  baseUrl: string,
  threadId: string,
  fetcher: FetcherImpl,
  runBody: { error?: unknown }
): Promise<string | undefined> {
  // Source 1: run body's error field.
  if (runBody.error !== undefined && runBody.error !== null) {
    try {
      const s =
        typeof runBody.error === "string"
          ? runBody.error
          : JSON.stringify(runBody.error);
      if (s && s !== "null" && s !== "{}") return s.slice(0, 500);
    } catch {
      // fall through
    }
  }
  // Source 2: thread state.
  try {
    const stateRes = await fetcher(`${baseUrl}/threads/${threadId}/state`, {
      method: "GET",
    });
    if (stateRes.ok) {
      const state = (await stateRes.json()) as {
        values?: Record<string, unknown> | null;
        tasks?: Array<{ error?: unknown; name?: unknown }> | null;
      };
      // 2a — task-level errors (langgraph populates `tasks[*].error` on
      // node exceptions).
      const tasks = state.tasks ?? [];
      const failedTask = tasks.find(
        (t) => t && t.error !== undefined && t.error !== null
      );
      if (failedTask?.error !== undefined && failedTask.error !== null) {
        const name =
          typeof failedTask.name === "string" ? failedTask.name : "?";
        const detail =
          typeof failedTask.error === "string"
            ? failedTask.error
            : JSON.stringify(failedTask.error);
        return `task=${name}: ${detail}`.slice(0, 500);
      }
      // 2b — explicit __error__ key on values.
      const values = state.values ?? {};
      const errKey = (values as Record<string, unknown>).__error__;
      if (errKey !== undefined && errKey !== null) {
        const s =
          typeof errKey === "string" ? errKey : JSON.stringify(errKey);
        return `state.__error__=${s}`.slice(0, 500);
      }
      // 2c — fallback: serialize the whole state for post-mortem.
      const s = JSON.stringify(state).slice(0, 500);
      return `state_dump=${s}`;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Best-effort run cancellation (used when wallclock budget expires).
 */
async function cancelRun(
  baseUrl: string,
  threadId: string,
  runId: string,
  fetcher: FetcherImpl
): Promise<void> {
  try {
    await fetcher(`${baseUrl}/threads/${threadId}/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch {
    // Best-effort — VM is about to be torn down anyway.
  }
}

export async function runDecepticonScan(
  args: RunScanArgs,
  deps: RunDecepticonDeps = {}
): Promise<RunScanResult> {
  const spawn = deps.spawn ?? defaultSpawn;
  const fetcher = deps.fetcher ?? defaultFetcher;
  const collect = deps.collectFindings ?? defaultCollectFindings;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? defaultNow;

  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bootTimeoutMs = args.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const langgraphUrl = args.langgraphUrl ?? DEFAULT_LANGGRAPH_URL;
  const startTime = now();
  const deadline = startTime + timeoutMs;

  // ----------------------------------------------------------------------
  // Step 1: compose up -d
  // ----------------------------------------------------------------------
  const upProc = spawn(buildComposeUpCmd(args), { env: buildEnv(args) });
  const upCode = await upProc.exited;
  if (upCode !== 0) {
    const findings = await collectSafe(collect, args.findingsDir);
    return {
      status: "failed",
      failure_reason: `docker_exit_${upCode}`,
      findings,
      usage: null,
    };
  }

  // ----------------------------------------------------------------------
  // Step 2: wait for langgraph /ok
  // ----------------------------------------------------------------------
  // Respect the smaller of bootTimeoutMs and the overall wallclock budget.
  const bootBudget = Math.min(bootTimeoutMs, Math.max(0, deadline - now()));
  const ready = await waitForLanggraph(
    langgraphUrl,
    bootBudget,
    fetcher,
    sleep,
    now
  );
  if (!ready) {
    await composeDown(spawn, args);
    const findings = await collectSafe(collect, args.findingsDir);
    return {
      status: "failed",
      failure_reason: "langgraph_boot_timeout",
      findings,
      usage: null,
    };
  }

  // ----------------------------------------------------------------------
  // Step 3+4: thread + run
  // ----------------------------------------------------------------------
  let threadId: string;
  let runId: string;
  try {
    threadId = await createThread(langgraphUrl, fetcher);
    runId = await createRun(
      langgraphUrl,
      threadId,
      buildRunInput(args),
      fetcher
    );
  } catch (err) {
    await composeDown(spawn, args);
    const findings = await collectSafe(collect, args.findingsDir);
    const reason =
      err instanceof Error ? `langgraph_submit_${err.message}` : "langgraph_submit_unknown";
    return {
      status: "failed",
      failure_reason: reason,
      findings,
      usage: null,
    };
  }

  // ----------------------------------------------------------------------
  // Step 5: poll run until terminal or wallclock
  // ----------------------------------------------------------------------
  const outcome = await pollRun(
    langgraphUrl,
    threadId,
    runId,
    deadline,
    fetcher,
    sleep,
    now
  );

  if (outcome.kind === "wallclock") {
    await cancelRun(langgraphUrl, threadId, runId, fetcher);
    await composeDown(spawn, args);
    const findings = await collectSafe(collect, args.findingsDir);
    return {
      status: "failed",
      failure_reason: "timeout_exceeded",
      findings,
      usage: null,
    };
  }

  // Terminal status observed — map to envelope.
  await composeDown(spawn, args);
  const findings = await collectSafe(collect, args.findingsDir);
  if (outcome.status === "success") {
    return {
      status: "done",
      failure_reason: null,
      findings,
      usage: null,
    };
  }
  // Surface the LangGraph error detail when present so the audit_log
  // failure_reason carries WHY the run errored (LLM 401? graph timeout?
  // tool exception?) instead of an opaque "langgraph_run_error".
  const baseReason = `langgraph_run_${outcome.status}`;
  const reasonWithDetail = outcome.error
    ? `${baseReason}: ${outcome.error}`
    : baseReason;
  return {
    status: "failed",
    failure_reason: reasonWithDetail,
    findings,
    usage: null,
  };
}
