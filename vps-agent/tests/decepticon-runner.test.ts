import { describe, expect, test } from "bun:test";
import { runDecepticonScan, type SpawnImpl } from "../src/decepticon-runner.ts";
import type { CollectionResult } from "../src/findings-collector.ts";

/**
 * Mock spawn factory. The returned `exited` promise is controlled by the
 * test: either it resolves with a chosen exit code (sync or after a delay)
 * or it never resolves (timeout path).
 *
 * `record` captures the cmd + opts so tests can assert on them after the
 * scan completes.
 */
type SpawnRecord = { cmd: string[]; opts: { env?: Record<string, string> } | undefined };

function makeSpawn(opts: {
  exitCode?: number;
  delayMs?: number;
  neverExits?: boolean;
  record: SpawnRecord[];
}): SpawnImpl {
  return (cmd, spawnOpts) => {
    opts.record.push({ cmd, opts: spawnOpts });
    let killed = false;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    if (opts.neverExits) {
      // Stays pending until kill() is called.
    } else if (opts.delayMs !== undefined && opts.delayMs > 0) {
      setTimeout(() => resolveExit(opts.exitCode ?? 0), opts.delayMs);
    } else {
      // Resolve on next microtask so the runner has a chance to start the race.
      queueMicrotask(() => resolveExit(opts.exitCode ?? 0));
    }
    return {
      exited,
      kill: () => {
        killed = true;
        // When killed during timeout, surface a non-zero code so the runner
        // doesn't accidentally treat a killed scan as success.
        resolveExit(137);
      },
      // Expose for assertions
      get killed() {
        return killed;
      },
    } as ReturnType<SpawnImpl>;
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

describe("runDecepticonScan", () => {
  test("happy path: compose exits 0 → status=done with collected findings", async () => {
    const record: SpawnRecord[] = [];
    const spawn = makeSpawn({ exitCode: 0, record });
    const result = await runDecepticonScan(
      {
        scanId: "scan-abc",
        targetUrl: "https://example.com",
        profile: "standard",
        findingsDir: "/workspace/findings",
        composeFile: "/opt/decepticon/docker-compose.yml",
      },
      {
        spawn,
        collectFindings: makeCollectFindings(TWO_FINDINGS),
      }
    );
    expect(result.status).toBe("done");
    expect(result.failure_reason).toBeNull();
    expect(result.findings.length).toBe(2);
    expect(result.findings[0]!.title).toBe("SQLi in /api/products");
    expect(result.usage).toBeNull();
  });

  test("docker compose exits non-zero → status=failed with docker_exit_<code>", async () => {
    const record: SpawnRecord[] = [];
    const spawn = makeSpawn({ exitCode: 1, record });
    const result = await runDecepticonScan(
      {
        scanId: "scan-xyz",
        targetUrl: "https://target.test",
        profile: "recon",
        findingsDir: "/workspace/findings",
        composeFile: "/opt/decepticon/docker-compose.yml",
      },
      {
        spawn,
        collectFindings: makeCollectFindings(TWO_FINDINGS),
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("docker_exit_1");
    // findings still collected best-effort
    expect(result.findings.length).toBe(2);
  });

  test("timeout: compose never exits → killed, status=failed, reason=timeout_exceeded", async () => {
    const record: SpawnRecord[] = [];
    let killSpy = false;
    const spawn: SpawnImpl = (cmd, opts) => {
      record.push({ cmd, opts });
      let resolveExit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      // Never resolves on its own.
      return {
        exited,
        kill: () => {
          killSpy = true;
          resolveExit(137);
        },
      };
    };
    const result = await runDecepticonScan(
      {
        scanId: "scan-slow",
        targetUrl: "https://slow.test",
        profile: "max",
        findingsDir: "/workspace/findings",
        composeFile: "/opt/decepticon/docker-compose.yml",
        timeoutMs: 50,
      },
      {
        spawn,
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("timeout_exceeded");
    expect(killSpy).toBe(true);
  });

  test("env vars are passed: scan id, target url, profile, findings dir", async () => {
    const record: SpawnRecord[] = [];
    const spawn = makeSpawn({ exitCode: 0, record });
    await runDecepticonScan(
      {
        scanId: "scan-env-1",
        targetUrl: "https://app.example.com",
        profile: "standard",
        findingsDir: "/workspace/findings",
        composeFile: "/opt/decepticon/docker-compose.yml",
      },
      {
        spawn,
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
      }
    );
    expect(record.length).toBe(1);
    const env = record[0]!.opts?.env ?? {};
    expect(env.TENSOL_SCAN_ID).toBe("scan-env-1");
    expect(env.DECEPTICON_TARGET_URL).toBe("https://app.example.com");
    expect(env.DECEPTICON_PROFILE).toBe("standard");
    expect(env.DECEPTICON_FINDINGS_DIR).toBe("/workspace/findings");
  });

  test("profile mapping is literal pass-through (max → max, recon → recon)", async () => {
    const recordA: SpawnRecord[] = [];
    await runDecepticonScan(
      {
        scanId: "s1",
        targetUrl: "https://t.test",
        profile: "max",
        findingsDir: "/w",
        composeFile: "/c.yml",
      },
      {
        spawn: makeSpawn({ exitCode: 0, record: recordA }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
      }
    );
    expect(recordA[0]!.opts?.env?.DECEPTICON_PROFILE).toBe("max");

    const recordB: SpawnRecord[] = [];
    await runDecepticonScan(
      {
        scanId: "s2",
        targetUrl: "https://t.test",
        profile: "recon",
        findingsDir: "/w",
        composeFile: "/c.yml",
      },
      {
        spawn: makeSpawn({ exitCode: 0, record: recordB }),
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
      }
    );
    expect(recordB[0]!.opts?.env?.DECEPTICON_PROFILE).toBe("recon");
  });

  test("compose command structure: docker compose -f <file> up --abort-on-container-exit", async () => {
    const record: SpawnRecord[] = [];
    const spawn = makeSpawn({ exitCode: 0, record });
    await runDecepticonScan(
      {
        scanId: "scan-cmd",
        targetUrl: "https://t.test",
        profile: "standard",
        findingsDir: "/w",
        composeFile: "/opt/decepticon/docker-compose.yml",
      },
      {
        spawn,
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
      }
    );
    expect(record.length).toBe(1);
    expect(record[0]!.cmd).toEqual([
      "docker",
      "compose",
      "-f",
      "/opt/decepticon/docker-compose.yml",
      "up",
      "--abort-on-container-exit",
    ]);
  });

  test("failed compose + empty findings dir → result.findings=[] without crashing", async () => {
    const record: SpawnRecord[] = [];
    const spawn = makeSpawn({ exitCode: 2, record });
    const result = await runDecepticonScan(
      {
        scanId: "scan-empty",
        targetUrl: "https://t.test",
        profile: "recon",
        findingsDir: "/empty",
        composeFile: "/c.yml",
      },
      {
        spawn,
        collectFindings: makeCollectFindings(EMPTY_COLLECTION),
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toBe("docker_exit_2");
    expect(result.findings).toEqual([]);
  });
});
