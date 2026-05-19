/**
 * Integration tests for the VPS-agent Hono server (T073).
 *
 * The agent runs as a single-binary process on an ephemeral VPS spawned by
 * the backend. It accepts ONE signed `POST /scan` from the backend, executes
 * the Decepticon scan asynchronously, posts a signed callback to the supplied
 * webhook URL, and then self-shuts-down via `process.exit(0)`.
 *
 * All side-effecting dependencies (`runDecepticonScan`, `sendCallback`,
 * `process.exit`, `now`) are injected through `createAgent({...})`, so these
 * tests never spawn docker, never make a real HTTP callback, and never kill
 * the test process.
 *
 * Coverage:
 *  1. POST /scan happy path → 202, state machine transitions, runScan called
 *     with right args, sendCallback called, exitImpl(0) called.
 *  2. Signature mismatch → 401, no scan started.
 *  3. scan_id mismatch (body vs env) → 400, no scan started.
 *  4. Invalid Zod body → 400.
 *  5. GET /status idle.
 *  6. GET /status while running.
 *  7. Callback failure → exitImpl(1) is called (we choose exit(1) so the VPS
 *     still tears itself down; backend watchdog will mark scan failed when
 *     callback never arrives).
 *  8. Second POST /scan while running → 409 (idempotency).
 *  9. GET /healthz still works.
 */

import { describe, expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createAgent, type AgentState } from "../src/agent.ts";
import type { RunScanResult, SpawnImpl } from "../src/decepticon-runner.ts";
import type { CallbackResult } from "../src/callback.ts";

const SIGN_KEY = "test-sign-key-do-not-use-in-prod";
const SCAN_ID = "01JBVPSCAN0000000000000001";

type RunCall = {
  args: Parameters<typeof import("../src/decepticon-runner.ts").runDecepticonScan>[0];
};
type CallbackCall = {
  opts: Parameters<typeof import("../src/callback.ts").sendCallback>[0];
};

/**
 * Build a deps bundle whose internals can be observed and steered per-test.
 * `runScan` defaults to a resolved promise but tests can swap in a deferred
 * one to inspect intermediate states (e.g. GET /status during running).
 */
function makeDeps(overrides?: {
  runResult?: RunScanResult;
  runDelayResolver?: (resolve: (r: RunScanResult) => void) => void;
  callbackResult?: CallbackResult;
}) {
  const runCalls: RunCall[] = [];
  const callbackCalls: CallbackCall[] = [];
  const exitCalls: number[] = [];

  const defaultRunResult: RunScanResult = {
    status: "done",
    failure_reason: null,
    findings: [
      {
        severity: "high",
        title: "Open admin panel",
        body_md: "Admin panel exposed at /admin",
      },
    ],
    usage: null,
  };

  const runScan = async (
    args: Parameters<typeof import("../src/decepticon-runner.ts").runDecepticonScan>[0],
    _deps?: Parameters<typeof import("../src/decepticon-runner.ts").runDecepticonScan>[1],
  ): Promise<RunScanResult> => {
    runCalls.push({ args });
    if (overrides?.runDelayResolver) {
      return new Promise<RunScanResult>((resolve) => {
        overrides.runDelayResolver!(resolve);
      });
    }
    return overrides?.runResult ?? defaultRunResult;
  };

  const sendCallback = async (
    opts: Parameters<typeof import("../src/callback.ts").sendCallback>[0],
  ): Promise<CallbackResult> => {
    callbackCalls.push({ opts });
    return overrides?.callbackResult ?? { ok: true, attempts: 1, status: 200 };
  };

  const exitImpl = (code: number) => {
    exitCalls.push(code);
  };

  return {
    runCalls,
    callbackCalls,
    exitCalls,
    deps: {
      signKey: SIGN_KEY,
      scanId: SCAN_ID,
      runScan,
      sendCallback,
      exitImpl,
      now: () => 1700000000000,
    },
  };
}

function sign(rawBody: string, key: string): string {
  return createHmac("sha256", key).update(rawBody).digest("hex");
}

function makeScanRequest(
  body: object,
  opts: { signKey?: string; tamperSig?: boolean } = {},
): Request {
  const raw = JSON.stringify(body);
  const sig = sign(raw, opts.signKey ?? SIGN_KEY);
  return new Request("http://agent.local/scan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Signature": opts.tamperSig ? "deadbeef".repeat(8) : sig,
    },
    body: raw,
  });
}

const VALID_BODY = {
  scan_id: SCAN_ID,
  target_url: "https://example.com",
  profile: "recon" as const,
  webhook_url: "https://backend.example.com/webhooks/scan-progress",
};

/**
 * Helper: poll `getState` until predicate matches or timeout.
 * Tests use this to wait for async transitions (running → callback_sent
 * → shutdown_pending) without sleeping arbitrary durations.
 */
async function waitForState(
  getState: () => AgentState,
  predicate: (s: AgentState) => boolean,
  timeoutMs = 1000,
): Promise<AgentState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = getState();
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `waitForState: predicate never matched; final state=${JSON.stringify(getState())}`,
  );
}

describe("createAgent — POST /scan happy path", () => {
  test("202 accepted, state machine runs to shutdown_pending, exitImpl(0) called", async () => {
    const { runCalls, callbackCalls, exitCalls, deps } = makeDeps();
    const { app, getState } = createAgent(deps);

    expect(getState().phase).toBe("idle");

    const res = await app.fetch(makeScanRequest(VALID_BODY));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ accepted: true, scan_id: SCAN_ID });

    // Eventually transitions through running → callback_sent → shutdown_pending.
    const final = await waitForState(
      getState,
      (s) => s.phase === "shutdown_pending",
    );
    expect(final.phase).toBe("shutdown_pending");

    // runScan was called with the right args.
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.args.scanId).toBe(SCAN_ID);
    expect(runCalls[0]!.args.targetUrl).toBe("https://example.com");
    expect(runCalls[0]!.args.profile).toBe("recon");

    // sendCallback was called with the right webhook + signKey + findings.
    expect(callbackCalls).toHaveLength(1);
    expect(callbackCalls[0]!.opts.webhookUrl).toBe(VALID_BODY.webhook_url);
    expect(callbackCalls[0]!.opts.signKey).toBe(SIGN_KEY);
    expect(callbackCalls[0]!.opts.payload.scan_id).toBe(SCAN_ID);
    expect(callbackCalls[0]!.opts.payload.status).toBe("done");
    expect(callbackCalls[0]!.opts.payload.findings).toHaveLength(1);

    // Self-shutdown with code 0.
    expect(exitCalls).toEqual([0]);
  });
});

describe("createAgent — signature verification", () => {
  test("tampered signature returns 401 and does NOT start scan", async () => {
    const { runCalls, callbackCalls, exitCalls, deps } = makeDeps();
    const { app, getState } = createAgent(deps);

    const res = await app.fetch(
      makeScanRequest(VALID_BODY, { tamperSig: true }),
    );
    expect(res.status).toBe(401);
    expect(getState().phase).toBe("idle");

    // Give any (incorrect) async work a tick to run; verify nothing happened.
    await new Promise((r) => setTimeout(r, 20));
    expect(runCalls).toHaveLength(0);
    expect(callbackCalls).toHaveLength(0);
    expect(exitCalls).toEqual([]);
  });

  test("wrong sign key (sig computed over correct body w/ wrong key) → 401", async () => {
    const { deps } = makeDeps();
    const { app } = createAgent(deps);

    const res = await app.fetch(
      makeScanRequest(VALID_BODY, { signKey: "WRONG-KEY" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("createAgent — body validation", () => {
  test("scan_id mismatch (body vs env) → 400", async () => {
    const { runCalls, deps } = makeDeps();
    const { app, getState } = createAgent(deps);

    const res = await app.fetch(
      makeScanRequest({ ...VALID_BODY, scan_id: "01JBVPSCAN9999999999999999" }),
    );
    expect(res.status).toBe(400);
    expect(getState().phase).toBe("idle");
    await new Promise((r) => setTimeout(r, 10));
    expect(runCalls).toHaveLength(0);
  });

  test("missing target_url → 400 zod error", async () => {
    const { deps } = makeDeps();
    const { app } = createAgent(deps);

    const { target_url: _omit, ...partial } = VALID_BODY;
    const res = await app.fetch(makeScanRequest(partial));
    expect(res.status).toBe(400);
  });

  test("invalid profile → 400", async () => {
    const { deps } = makeDeps();
    const { app } = createAgent(deps);

    const res = await app.fetch(
      makeScanRequest({ ...VALID_BODY, profile: "ludicrous" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("createAgent — GET /status", () => {
  test("idle by default", async () => {
    const { deps } = makeDeps();
    const { app } = createAgent(deps);

    const res = await app.fetch(new Request("http://agent.local/status"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ phase: "idle" });
  });

  test("running after POST /scan, before runScan resolves", async () => {
    let resolveRun: (r: RunScanResult) => void = () => {};
    const { deps } = makeDeps({
      runDelayResolver: (r) => {
        resolveRun = r;
      },
    });
    const { app, getState } = createAgent(deps);

    await app.fetch(makeScanRequest(VALID_BODY));
    await waitForState(getState, (s) => s.phase === "running");

    const res = await app.fetch(new Request("http://agent.local/status"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      phase: "running",
      scan_id: SCAN_ID,
      started_at: 1700000000000,
    });

    // Cleanup: resolve the run so the agent can finish.
    resolveRun({
      status: "done",
      failure_reason: null,
      findings: [],
      usage: null,
    });
    await waitForState(getState, (s) => s.phase === "shutdown_pending");
  });
});

describe("createAgent — callback failure", () => {
  test("sendCallback returns ok:false → exitImpl(1) is called", async () => {
    const { exitCalls, deps } = makeDeps({
      callbackResult: {
        ok: false,
        attempts: 5,
        lastStatus: 502,
        lastError: "HTTP 502",
      },
    });
    const { app, getState } = createAgent(deps);

    await app.fetch(makeScanRequest(VALID_BODY));
    await waitForState(getState, (s) => s.phase === "shutdown_pending");

    // Failure path STILL shuts down — but with non-zero exit code so the
    // backend watchdog can disambiguate clean vs dirty exits via logs.
    expect(exitCalls).toEqual([1]);
  });
});

describe("createAgent — idempotency", () => {
  test("second POST /scan while running → 409", async () => {
    let resolveRun: (r: RunScanResult) => void = () => {};
    const { deps } = makeDeps({
      runDelayResolver: (r) => {
        resolveRun = r;
      },
    });
    const { app, getState } = createAgent(deps);

    const first = await app.fetch(makeScanRequest(VALID_BODY));
    expect(first.status).toBe(202);
    await waitForState(getState, (s) => s.phase === "running");

    const second = await app.fetch(makeScanRequest(VALID_BODY));
    expect(second.status).toBe(409);

    resolveRun({
      status: "done",
      failure_reason: null,
      findings: [],
      usage: null,
    });
    await waitForState(getState, (s) => s.phase === "shutdown_pending");
  });
});

describe("createAgent — GET /healthz", () => {
  test("still returns {ok:true}", async () => {
    const { deps } = makeDeps();
    const { app } = createAgent(deps);

    const res = await app.fetch(new Request("http://agent.local/healthz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe("createAgent — HMAC verification details", () => {
  test("uses constant-time compare (smoke test: signature with same length but wrong bytes fails 401)", async () => {
    const { deps } = makeDeps();
    const { app } = createAgent(deps);

    const raw = JSON.stringify(VALID_BODY);
    const correct = sign(raw, SIGN_KEY);
    // Flip last char to produce same-length wrong signature.
    const wrong =
      correct.slice(0, -1) + (correct.at(-1) === "0" ? "1" : "0");

    const res = await app.fetch(
      new Request("http://agent.local/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tensol-Signature": wrong,
        },
        body: raw,
      }),
    );
    expect(res.status).toBe(401);

    // Sanity check that our test helper's "correct" sig actually works.
    const ok = await app.fetch(
      new Request("http://agent.local/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tensol-Signature": correct,
        },
        body: raw,
      }),
    );
    expect(ok.status).toBe(202);
  });

  test("missing signature header → 401", async () => {
    const { deps } = makeDeps();
    const { app } = createAgent(deps);

    const res = await app.fetch(
      new Request("http://agent.local/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      }),
    );
    expect(res.status).toBe(401);
  });
});

// Avoid an unused-import lint warning for timingSafeEqual reference;
// this confirms node:crypto is reachable from the test file's runtime.
test("crypto.timingSafeEqual is reachable (sanity)", () => {
  const a = Buffer.from("abc");
  const b = Buffer.from("abc");
  expect(timingSafeEqual(a, b)).toBe(true);
});
