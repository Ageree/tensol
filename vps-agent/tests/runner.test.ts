/**
 * T136 — tests for `vps-agent/src/runner.ts`.
 *
 * Strategy: every external side-effecting dep (`decepticon`, `bundler`,
 * `evidenceUploader`, `findingCollector`, `fetcher`, `shutdown`, `now`) is
 * injected through `RunnerDeps`. No real docker socket, S3 endpoint, or
 * network call is made — the test asserts wiring + signature + retry logic.
 *
 * Constitution II (NON-NEGOTIABLE): the signed webhook header is asserted
 * byte-for-byte against `signWebhook()` because the receiver on the backend
 * side (`server/src/routes/webhooks-scan-complete.ts`) parses the EXACT
 * envelope `t=<sec>, v1=<hex>` — drift would brick US1.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { runScan, type RunnerDeps } from "../src/runner.ts";
import type { FindingFromAgent } from "../src/runner.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SCAN_ID = "scan_01HXTESTRUNNER0000000001";
const SCAN_ORDER_ID = "01JJCSHPTESTSCANRDER000001";
const SIGN_KEY = "runner-test-secret";
const WEBHOOK_URL = "https://api.tensol.run/v1/webhooks/scan-complete";

function makeFinding(id: string, severity: FindingFromAgent["raw_yaml_frontmatter"]["severity"]): FindingFromAgent {
  return {
    raw_yaml_frontmatter: {
      id,
      severity,
      title: `Finding ${id}`,
    },
    body_md: `# Finding ${id}\n\nDetails about ${id}.`,
    evidence_keys: [`evidence/${id}/poc.txt`],
  };
}

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function makeFakeFetch(
  responder: (req: CapturedRequest, attempt: number) => Response | Promise<Response>,
): { fetcher: typeof fetch; captured: CapturedRequest[]; attempts: () => number } {
  const captured: CapturedRequest[] = [];
  let attempt = 0;
  const fetcher: typeof fetch = async (input, init) => {
    attempt += 1;
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === "string" ? init.body : "";
    const req: CapturedRequest = { url, method, headers, body };
    captured.push(req);
    return responder(req, attempt);
  };
  return { fetcher, captured, attempts: () => attempt };
}

function baseDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const findings: FindingFromAgent[] = [
    makeFinding("FIND-001", "critical"),
    makeFinding("FIND-002", "high"),
    makeFinding("FIND-003", "medium"),
  ];
  return {
    scanId: SCAN_ID,
    scanOrderId: SCAN_ORDER_ID,
    signKey: SIGN_KEY,
    webhookUrl: WEBHOOK_URL,
    evidenceBucket: "tensol-test-bucket",
    decepticon: {
      run: async () => ({
        findingsDir: "/workspace/findings",
        evidenceDir: "/workspace/evidence",
        durationSeconds: 2280,
        decepticonEventsCount: 759,
      }),
    },
    findingCollector: {
      collect: async () => findings,
    },
    bundler: {
      createTarGz: async (_src, out) => ({ path: out, size: 1024 }),
    },
    evidenceUploader: {
      uploadEvidence: async ({ scanId, filePath }) => ({
        bucket: "tensol-test-bucket",
        key: `evidence/${scanId}/${filePath.split("/").pop() ?? "archive.tar.gz"}`,
        size: 1024,
      }),
    },
    fetcher: makeFakeFetch(() => new Response(JSON.stringify({ status: "ok" }), { status: 200 })).fetcher,
    now: () => 1716114000_000,
    shutdown: async () => {},
    sleep: async () => {},
    bundleOutPath: "/tmp/evidence.tar.gz",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("runScan — happy path", () => {
  test("orchestrates decepticon → tar.gz → upload → signed POST → shutdown", async () => {
    let shutdownCalled = false;
    const { fetcher, captured } = makeFakeFetch(() => new Response("{}", { status: 200 }));
    const deps = baseDeps({
      fetcher,
      shutdown: async () => {
        shutdownCalled = true;
      },
    });
    const result = await runScan(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.findings).toBe(3);
    expect(result.uploadKey).toBe(
      `evidence/${SCAN_ID}/evidence.tar.gz`,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe(WEBHOOK_URL);
    expect(shutdownCalled).toBe(true);
  });

  test("X-Tensol-Signature header matches t=<sec>, v1=<hex> envelope", async () => {
    const fixedTs = 1716114000_000;
    const { fetcher, captured } = makeFakeFetch(() => new Response("{}", { status: 200 }));
    await runScan(baseDeps({ fetcher, now: () => fixedTs }));
    const sigHeader = captured[0]?.headers["x-tensol-signature"];
    expect(sigHeader).toBeDefined();
    expect(sigHeader).toMatch(/^t=\d+, v1=[0-9a-f]+$/);

    const expectedSeconds = Math.floor(fixedTs / 1000);
    const body = captured[0]!.body;
    const expectedHmac = createHmac("sha256", SIGN_KEY)
      .update(`${expectedSeconds}.${body}`)
      .digest("hex");
    expect(sigHeader).toBe(`t=${expectedSeconds}, v1=${expectedHmac}`);
  });

  test("Content-Type header is application/json", async () => {
    const { fetcher, captured } = makeFakeFetch(() => new Response("{}", { status: 200 }));
    await runScan(baseDeps({ fetcher }));
    expect(captured[0]?.headers["content-type"]).toBe("application/json");
  });

  test("body matches WebhookScanCompleteBody shape", async () => {
    const { fetcher, captured } = makeFakeFetch(() => new Response("{}", { status: 200 }));
    await runScan(baseDeps({ fetcher, now: () => 1716114000_000 }));
    const body = JSON.parse(captured[0]!.body);
    expect(body.scan_order_id).toBe(SCAN_ORDER_ID);
    expect(body.completed_at).toBe(1716114000_000);
    expect(body.duration_seconds).toBe(2280);
    expect(body.decepticon_events_count).toBe(759);
    expect(body.evidence_archive_url).toBe(
      `s3://tensol-test-bucket/evidence/${SCAN_ID}/evidence.tar.gz`,
    );
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.findings).toHaveLength(3);
    expect(body.findings[0].raw_yaml_frontmatter.id).toBe("FIND-001");
    expect(body.findings[0].body_md).toContain("FIND-001");
    expect(body.findings[0].evidence_keys).toEqual(["evidence/FIND-001/poc.txt"]);
  });

  test("calls dependencies in correct order (decepticon → bundle → upload → fetch → shutdown)", async () => {
    const order: string[] = [];
    const { fetcher } = makeFakeFetch(() => {
      order.push("fetch");
      return new Response("{}", { status: 200 });
    });
    const deps = baseDeps({
      decepticon: {
        run: async () => {
          order.push("decepticon");
          return {
            findingsDir: "/workspace/findings",
            evidenceDir: "/workspace/evidence",
            durationSeconds: 10,
          };
        },
      },
      findingCollector: {
        collect: async () => {
          order.push("collect");
          return [];
        },
      },
      bundler: {
        createTarGz: async (_s, out) => {
          order.push("bundle");
          return { path: out, size: 100 };
        },
      },
      evidenceUploader: {
        uploadEvidence: async ({ scanId }) => {
          order.push("upload");
          return { bucket: "b", key: `evidence/${scanId}/archive.tar.gz`, size: 100 };
        },
      },
      shutdown: async () => {
        order.push("shutdown");
      },
      fetcher,
    });
    await runScan(deps);
    expect(order).toEqual(["decepticon", "collect", "bundle", "upload", "fetch", "shutdown"]);
  });

  test("zero findings still produces a valid webhook (empty array)", async () => {
    const { fetcher, captured } = makeFakeFetch(() => new Response("{}", { status: 200 }));
    const deps = baseDeps({
      fetcher,
      findingCollector: { collect: async () => [] },
    });
    const result = await runScan(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.findings).toBe(0);
    const body = JSON.parse(captured[0]!.body);
    expect(body.findings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────────────────────────────────────

describe("runScan — failure paths", () => {
  test("decepticon failure → no webhook POST, returns ok=false", async () => {
    let posted = false;
    const { fetcher } = makeFakeFetch(() => {
      posted = true;
      return new Response("{}", { status: 200 });
    });
    const deps = baseDeps({
      fetcher,
      decepticon: {
        run: async () => {
          throw new Error("docker_exit_137");
        },
      },
    });
    const result = await runScan(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toContain("decepticon");
    expect(posted).toBe(false);
  });

  test("upload failure → no webhook POST, returns ok=false", async () => {
    let posted = false;
    const { fetcher } = makeFakeFetch(() => {
      posted = true;
      return new Response("{}", { status: 200 });
    });
    const deps = baseDeps({
      fetcher,
      evidenceUploader: {
        uploadEvidence: async () => {
          throw new Error("S3 connection refused");
        },
      },
    });
    const result = await runScan(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toContain("upload");
    expect(posted).toBe(false);
  });

  test("bundler failure → no webhook POST, returns ok=false", async () => {
    const deps = baseDeps({
      bundler: {
        createTarGz: async () => {
          throw new Error("tar binary not found");
        },
      },
    });
    const result = await runScan(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toContain("bundle");
  });

  test("findingCollector failure → no webhook POST, returns ok=false", async () => {
    const deps = baseDeps({
      findingCollector: {
        collect: async () => {
          throw new Error("findings dir vanished");
        },
      },
    });
    const result = await runScan(deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toContain("collect");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook retry semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("runScan — webhook retry", () => {
  test("5xx triggers retry then success", async () => {
    const { fetcher, attempts } = makeFakeFetch((_req, n) => {
      if (n < 3) return new Response("upstream timeout", { status: 503 });
      return new Response("{}", { status: 200 });
    });
    const deps = baseDeps({ fetcher });
    const result = await runScan(deps);
    expect(result.ok).toBe(true);
    expect(attempts()).toBe(3);
  });

  test("4xx (non-200) fails immediately without retry", async () => {
    const { fetcher, attempts } = makeFakeFetch(() =>
      new Response('{"error":"webhook_body_invalid"}', { status: 422 }),
    );
    const result = await runScan(baseDeps({ fetcher }));
    expect(result.ok).toBe(false);
    expect(attempts()).toBe(1);
  });

  test("persistent 5xx exhausts retries and returns ok=false", async () => {
    const { fetcher, attempts } = makeFakeFetch(() =>
      new Response("server down", { status: 500 }),
    );
    const result = await runScan(baseDeps({ fetcher, maxWebhookAttempts: 3 }));
    expect(result.ok).toBe(false);
    expect(attempts()).toBe(3);
    if (result.ok) throw new Error();
    expect(result.error).toContain("webhook");
  });

  test("network error (thrown fetch) is retried like 5xx", async () => {
    let attempt = 0;
    const fetcher: typeof fetch = async () => {
      attempt += 1;
      if (attempt < 2) throw new Error("ECONNRESET");
      return new Response("{}", { status: 200 });
    };
    const result = await runScan(baseDeps({ fetcher }));
    expect(result.ok).toBe(true);
    expect(attempt).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("runScan — shutdown", () => {
  test("shutdown is called even when webhook fails", async () => {
    let shutdownCalled = false;
    const { fetcher } = makeFakeFetch(() => new Response("nope", { status: 422 }));
    const result = await runScan(
      baseDeps({
        fetcher,
        shutdown: async () => {
          shutdownCalled = true;
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(shutdownCalled).toBe(true);
  });

  test("shutdown is NOT called when decepticon throws (decepticon owns its own teardown)", async () => {
    let shutdownCalled = false;
    const deps = baseDeps({
      decepticon: {
        run: async () => {
          throw new Error("docker daemon dead");
        },
      },
      shutdown: async () => {
        shutdownCalled = true;
      },
    });
    const result = await runScan(deps);
    expect(result.ok).toBe(false);
    // Pre-webhook failures don't trigger orchestrator shutdown — the
    // wrapper script / cloud-init handles VM teardown when the agent
    // exits non-zero. Documented in runner.ts.
    expect(shutdownCalled).toBe(false);
  });
});
