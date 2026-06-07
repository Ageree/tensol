import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOCKER_SPAWN_STDIO,
  diagDirFor,
  defaultSpawn,
  runDecepticonScan,
  type FetcherImpl,
  type RunScanArgs,
  type SpawnImpl,
} from "../src/decepticon-runner.ts";
import type { CollectionResult } from "../src/findings-collector.ts";

/**
 * Test scaffolding for the LangGraph-HTTP-based runner.
 *
 * `runDecepticonScan` orchestrates four stages:
 *   1. `docker compose up -d`            → spawn #1 (synchronous exit)
 *   2. poll  GET /ok                     → fetcher GET
 *   3. POST  /threads                    → fetcher POST
 *   4. POST  /threads/{id}/runs          → fetcher POST
 *   5. poll  GET /threads/{id}/runs/{id} → fetcher GET (returns status)
 *   6. `docker compose down -v ...`      → spawn #2
 *
 * Tests inject scripted spawn + fetcher + sleep + now so every branch
 * runs deterministically without touching docker or the network.
 */

type SpawnRecord = {
  cmd: string[];
  opts: { env?: Record<string, string> } | undefined;
};

function makeSpawn(opts: {
  exitCodes: number[];
  record: SpawnRecord[];
}): SpawnImpl {
  let call = 0;
  return (cmd, spawnOpts) => {
    opts.record.push({ cmd, opts: spawnOpts });
    const code = opts.exitCodes[call] ?? 0;
    call += 1;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    queueMicrotask(() => resolveExit(code));
    return {
      exited,
      kill: () => {
        resolveExit(137);
      },
    };
  };
}

type FetchCall = { url: string; method: string; body: unknown };

type ScriptedResponse =
  | { status: number; body: unknown }
  | { error: true };

function makeFetcher(opts: {
  // Routes are matched in declaration order; first matching script entry
  // is consumed per call. Format: predicate → array of scripted responses.
  okResponses?: ScriptedResponse[];
  threadsCreate?: ScriptedResponse;
  runsCreate?: ScriptedResponse;
  runStatus?: ScriptedResponse[];
  cancel?: ScriptedResponse;
  record: FetchCall[];
}): FetcherImpl {
  let okIdx = 0;
  let runStatusIdx = 0;
  return async (input, init) => {
    const url = input;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (init?.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    opts.record.push({ url, method, body });

    const respond = (r: ScriptedResponse) => {
      if ("error" in r) throw new Error("network failure");
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
        text: async () => JSON.stringify(r.body),
      };
    };

    if (url.endsWith("/ok") && method === "GET") {
      const r = opts.okResponses?.[okIdx] ?? { status: 200, body: {} };
      okIdx += 1;
      return respond(r);
    }
    if (url.endsWith("/threads") && method === "POST") {
      return respond(opts.threadsCreate ?? { status: 200, body: { thread_id: "t-1" } });
    }
    if (/\/threads\/[^/]+\/runs$/.test(url) && method === "POST") {
      return respond(opts.runsCreate ?? { status: 200, body: { run_id: "r-1" } });
    }
    if (/\/threads\/[^/]+\/runs\/[^/]+\/cancel$/.test(url)) {
      return respond(opts.cancel ?? { status: 200, body: {} });
    }
    if (/\/threads\/[^/]+\/runs\/[^/]+$/.test(url) && method === "GET") {
      const r = opts.runStatus?.[runStatusIdx]
        ?? opts.runStatus?.[opts.runStatus.length - 1]
        ?? { status: 200, body: { status: "success" } };
      runStatusIdx += 1;
      return respond(r);
    }
    // Unmatched — return 404 so unexpected calls visibly fail tests.
    return respond({ status: 404, body: { error: "unmatched", url, method } });
  };
}

function makeCollectFindings(result: CollectionResult) {
  return async (): Promise<CollectionResult> => result;
}

const EMPTY_COLLECTION: CollectionResult = { findings: [], rejected: [] };

const TWO_FINDINGS: CollectionResult = {
  findings: [
    {
      severity: "high",
      title: "SQLi in /api/products",
      body_md: "## Description\n\nDetails",
    },
    {
      severity: "info",
      title: "Server banner",
      body_md: "nginx version disclosed",
    },
  ],
  rejected: [],
};

/**
 * A virtual clock so tests can race wall-clock deadlines without
 * waiting for real time. `now()` always advances by `sleep(ms)`'s
 * argument, so loops bounded by a deadline terminate in O(1) wallclock
 * even when the runner thinks minutes elapsed.
 */
function makeClock() {
  let virtual = 0;
  return {
    now: () => virtual,
    sleep: async (ms: number) => {
      virtual += ms;
    },
  };
}

describe("runDecepticonScan (LangGraph HTTP)", () => {
  test("default spawn inherits docker output instead of leaving unread pipes", async () => {
    expect(DEFAULT_DOCKER_SPAWN_STDIO).toBe("inherit");

    const proc = defaultSpawn(["bun", "-e", "process.exit(process.env.TENSOL_SPAWN_TEST === 'ok' ? 0 : 7)"], {
      env: { TENSOL_SPAWN_TEST: "ok" },
    });

    expect(await proc.exited).toBe(0);
  });

  test("happy path: compose up → /ok 200 → thread+run → status=success → status=done", async () => {
    const spawnRec: SpawnRecord[] = [];
    const fetchRec: FetchCall[] = [];
    const clock = makeClock();
    const result = await runDecepticonScan(
      {
        scanId: "scan-abc",
        targetUrl: "https://example.com",
        profile: "standard",
        findingsDir: "/workspace/findings",
        composeFile: "/opt/decepticon/docker-compose.yml",
      },
      {
        spawn: makeSpawn({ exitCodes: [0, 0], record: spawnRec }),
        fetcher: makeFetcher({
          okResponses: [{ status: 200, body: {} }],
          threadsCreate: { status: 200, body: { thread_id: "thread-xyz" } },
          runsCreate: { status: 200, body: { run_id: "run-xyz" } },
          runStatus: [{ status: 200, body: { status: "success" } }],
          record: fetchRec,
        }),
        collectFindings: makeCollectFindings(TWO_FINDINGS),
        now: clock.now,
        sleep: clock.sleep,
      }
    );
    expect(result.status).toBe("done");
    expect(result.failure_reason).toBeNull();
    expect(result.findings.length).toBe(2);
    expect(result.usage).toBeNull();

    // compose up first, compose down last
    expect(spawnRec[0]!.cmd).toEqual([
      "docker",
      "compose",
      "-f",
      "/opt/decepticon/docker-compose.yml",
      "up",
      "-d",
    ]);
    expect(spawnRec[spawnRec.length - 1]!.cmd).toEqual([
      "docker",
      "compose",
      "-f",
      "/opt/decepticon/docker-compose.yml",
      "down",
      "-v",
      "--remove-orphans",
    ]);

    // POST /threads then POST /threads/<id>/runs in that order
    const posts = fetchRec.filter((c) => c.method === "POST");
    expect(posts[0]!.url).toMatch(/\/threads$/);
    expect(posts[1]!.url).toMatch(/\/threads\/thread-xyz\/runs$/);
    const runBody = posts[1]!.body as {
      assistant_id: string;
      input: { target_url: string; messages: Array<{ content: string }> };
      config: { recursion_limit: number };
      on_disconnect: string;
      multitask_strategy: string;
      durability: string;
    };
    expect(runBody.assistant_id).toBe("decepticon");
    expect(runBody.input.target_url).toBe("https://example.com");
    expect(runBody.input.messages[0]!.content).toContain("https://example.com");
    expect(runBody.config.recursion_limit).toBe(400);
    // Cancellation-resilience knobs (E2E #24 fix): vps-agent submits and
    // polls separately, so the POST connection closes immediately —
    // on_disconnect must be "continue" or langgraph cancels the run.
    expect(runBody.on_disconnect).toBe("continue");
    expect(runBody.multitask_strategy).toBe("enqueue");
    expect(runBody.durability).toBe("sync");
  });

  test("profile=recon → assistant_id=recon (literal map)", async () => {
    const fetchRec: FetchCall[] = [];
    const clock = makeClock();
    await runDecepticonScan(
      {
        scanId: "s1",
        targetUrl: "https://t.test",
        profile: "recon",
        findingsDir: "/w",
        composeFile: "/c.yml",
      },
      {
        spawn: makeSpawn({ exitCodes: [0, 0], record: [] }),
        fetcher: makeFetcher({
          runStatus: [{ status: 200, body: { status: "success" } }],
          record: fetchRec,
        }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
        now: clock.now,
        sleep: clock.sleep,
      }
    );
    const runPost = fetchRec.find((c) => /\/runs$/.test(c.url) && c.method === "POST");
    expect(runPost).toBeTruthy();
    expect((runPost!.body as { assistant_id: string }).assistant_id).toBe("recon");
  });

  test("profile=max → assistant_id=decepticon", async () => {
    const fetchRec: FetchCall[] = [];
    const clock = makeClock();
    await runDecepticonScan(
      {
        scanId: "s2",
        targetUrl: "https://t.test",
        profile: "max",
        findingsDir: "/w",
        composeFile: "/c.yml",
      },
      {
        spawn: makeSpawn({ exitCodes: [0, 0], record: [] }),
        fetcher: makeFetcher({
          runStatus: [{ status: 200, body: { status: "success" } }],
          record: fetchRec,
        }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
        now: clock.now,
        sleep: clock.sleep,
      }
    );
    const runPost = fetchRec.find((c) => /\/runs$/.test(c.url) && c.method === "POST");
    expect((runPost!.body as { assistant_id: string }).assistant_id).toBe("decepticon");
  });

  test("compose up fails → status=failed, reason=docker_exit_<code>", async () => {
    const spawnRec: SpawnRecord[] = [];
    let dumped = false;
    const result = await runDecepticonScan(
      {
        scanId: "s",
        targetUrl: "https://t.test",
        profile: "standard",
        findingsDir: "/w",
        composeFile: "/c.yml",
      },
      {
        spawn: makeSpawn({ exitCodes: [1], record: spawnRec }),
        fetcher: makeFetcher({ record: [] }),
        collectFindings: makeCollectFindings(TWO_FINDINGS),
        dumpComposeLogs: async () => {
          dumped = true;
        },
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("docker_exit_1");
    expect(dumped).toBe(true);
    // No further compose calls (we never got past step 1)
    expect(spawnRec.length).toBe(1);
    // Findings still best-effort collected
    expect(result.findings.length).toBe(2);
  });

  test("/ok never returns 200 → langgraph_boot_timeout, compose down called", async () => {
    const spawnRec: SpawnRecord[] = [];
    const fetchRec: FetchCall[] = [];
    const clock = makeClock();
    const result = await runDecepticonScan(
      {
        scanId: "s",
        targetUrl: "https://t.test",
        profile: "standard",
        findingsDir: "/w",
        composeFile: "/c.yml",
        bootTimeoutMs: 100,
        timeoutMs: 60_000,
      },
      {
        spawn: makeSpawn({ exitCodes: [0, 0], record: spawnRec }),
        fetcher: makeFetcher({
          // Always 503 — never ready
          okResponses: Array.from({ length: 50 }, () => ({ status: 503, body: {} })),
          record: fetchRec,
        }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
        now: clock.now,
        sleep: clock.sleep,
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("langgraph_boot_timeout");
    // compose up + compose down both called
    expect(spawnRec.length).toBe(2);
    expect(spawnRec[1]!.cmd).toContain("down");
    // No thread / run created
    const posts = fetchRec.filter((c) => c.method === "POST");
    expect(posts.length).toBe(0);
  });

  test("run terminal status=error → langgraph_run_error", async () => {
    const clock = makeClock();
    const result = await runDecepticonScan(
      {
        scanId: "s",
        targetUrl: "https://t.test",
        profile: "standard",
        findingsDir: "/w",
        composeFile: "/c.yml",
      },
      {
        spawn: makeSpawn({ exitCodes: [0, 0], record: [] }),
        fetcher: makeFetcher({
          runStatus: [{ status: 200, body: { status: "error" } }],
          record: [],
        }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
        now: clock.now,
        sleep: clock.sleep,
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("langgraph_run_error");
  });

  test("run terminal status=cancelled → langgraph_run_cancelled", async () => {
    const clock = makeClock();
    const result = await runDecepticonScan(
      {
        scanId: "s",
        targetUrl: "https://t.test",
        profile: "standard",
        findingsDir: "/w",
        composeFile: "/c.yml",
      },
      {
        spawn: makeSpawn({ exitCodes: [0, 0], record: [] }),
        fetcher: makeFetcher({
          runStatus: [{ status: 200, body: { status: "cancelled" } }],
          record: [],
        }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
        now: clock.now,
        sleep: clock.sleep,
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("langgraph_run_cancelled");
  });

  test("wallclock timeoutMs exceeded → timeout_exceeded, cancel POST + compose down called", async () => {
    const spawnRec: SpawnRecord[] = [];
    const fetchRec: FetchCall[] = [];
    const clock = makeClock();
    const result = await runDecepticonScan(
      {
        scanId: "s",
        targetUrl: "https://t.test",
        profile: "standard",
        findingsDir: "/w",
        composeFile: "/c.yml",
        bootTimeoutMs: 100,
        timeoutMs: 200,
      },
      {
        spawn: makeSpawn({ exitCodes: [0, 0], record: spawnRec }),
        fetcher: makeFetcher({
          okResponses: [{ status: 200, body: {} }],
          // Always pending — never terminal
          runStatus: Array.from({ length: 100 }, () => ({
            status: 200,
            body: { status: "pending" },
          })),
          record: fetchRec,
        }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
        now: clock.now,
        sleep: clock.sleep,
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("timeout_exceeded");
    // Cancel POST attempted
    const cancelCalls = fetchRec.filter((c) => /\/cancel$/.test(c.url));
    expect(cancelCalls.length).toBe(1);
    // compose down called
    expect(spawnRec[spawnRec.length - 1]!.cmd).toContain("down");
  });

  test("thread create fails → langgraph_submit_<msg>, compose down called", async () => {
    const spawnRec: SpawnRecord[] = [];
    const clock = makeClock();
    const result = await runDecepticonScan(
      {
        scanId: "s",
        targetUrl: "https://t.test",
        profile: "standard",
        findingsDir: "/w",
        composeFile: "/c.yml",
      },
      {
        spawn: makeSpawn({ exitCodes: [0, 0], record: spawnRec }),
        fetcher: makeFetcher({
          threadsCreate: { status: 500, body: { error: "boom" } },
          record: [],
        }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
        now: clock.now,
        sleep: clock.sleep,
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toContain("langgraph_submit_");
    expect(spawnRec[spawnRec.length - 1]!.cmd).toContain("down");
  });

  test("dumpComposeLogs runs BEFORE composeDown on terminal-error path", async () => {
    // Test contract: when the LangGraph run terminates with `error`, the
    // runner must persist `docker logs --tail` for every compose container
    // BEFORE invoking `docker compose down -v` (which wipes the logs).
    const events: string[] = [];
    const spawnRec: SpawnRecord[] = [];
    const clock = makeClock();

    // Wrap makeSpawn so we can record when "down" actually fires.
    const baseSpawn = makeSpawn({ exitCodes: [0, 0], record: spawnRec });
    const spawn: SpawnImpl = (cmd, opts) => {
      if (cmd.includes("down")) events.push("compose_down");
      return baseSpawn(cmd, opts);
    };

    const seenScans: string[] = [];
    const dumpStub = async (
      _spawn: SpawnImpl,
      args: RunScanArgs
    ): Promise<void> => {
      events.push("dump_logs");
      seenScans.push(args.scanId);
    };

    const result = await runDecepticonScan(
      {
        scanId: "scan-diag-1",
        targetUrl: "https://t.test",
        profile: "standard",
        findingsDir: "/opt/tensol/workspace/findings",
        composeFile: "/c.yml",
      },
      {
        spawn,
        fetcher: makeFetcher({
          runStatus: [{ status: 200, body: { status: "error" } }],
          record: [],
        }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
        now: clock.now,
        sleep: clock.sleep,
        dumpComposeLogs: dumpStub,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("langgraph_run_error");
    // dump must fire exactly once, BEFORE compose_down.
    expect(events).toEqual(["dump_logs", "compose_down"]);
    expect(seenScans).toEqual(["scan-diag-1"]);
  });

  test("diagDirFor resolves to <findingsDir-parent>/diag/<scanId>", () => {
    expect(
      diagDirFor({
        scanId: "scan-xyz",
        targetUrl: "https://t.test",
        profile: "standard",
        findingsDir: "/opt/tensol/workspace/findings",
        composeFile: "/c.yml",
      })
    ).toBe("/opt/tensol/workspace/diag/scan-xyz");
  });

  test("kickoff prompt mentions target URL, scan id, and load_skill", async () => {
    const fetchRec: FetchCall[] = [];
    const clock = makeClock();
    await runDecepticonScan(
      {
        scanId: "scan-007",
        targetUrl: "https://target.test/app",
        profile: "standard",
        findingsDir: "/w",
        composeFile: "/c.yml",
      },
      {
        spawn: makeSpawn({ exitCodes: [0, 0], record: [] }),
        fetcher: makeFetcher({
          runStatus: [{ status: 200, body: { status: "success" } }],
          record: fetchRec,
        }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
        now: clock.now,
        sleep: clock.sleep,
      }
    );
    const runPost = fetchRec.find((c) => /\/runs$/.test(c.url) && c.method === "POST");
    const body = runPost!.body as {
      input: { messages: Array<{ content: string }>; engagement_name: string; workspace_path: string };
      config: { configurable: { workspace: string } };
    };
    const prompt = body.input.messages[0]!.content;
    expect(prompt).toContain("https://target.test/app");
    expect(prompt).toContain("scan-007");
    expect(prompt).toContain("load_skill");
    expect(body.input.engagement_name).toBe("tensol-scan-007");
    expect(body.input.workspace_path).toBe("/workspace/tensol-scan-007");
    expect(body.config.configurable.workspace).toBe("/workspace/tensol-scan-007");
  });
});
