/**
 * T037 — Hetzner VPS provider tests.
 *
 * All tests use an injected `fetchImpl` mock. No real Hetzner API calls.
 */

import { describe, expect, test } from "bun:test";

import { createHetznerProvider, buildCloudInit, type HetznerOpts } from "./hetzner";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

type RouteHandler = (req: { url: string; method: string; init: FetchInit }) => Response;

function makeFetchMock(handler: RouteHandler): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(h)) {
        for (const pair of h) {
          const k = pair[0];
          const v = pair[1];
          if (k !== undefined && v !== undefined) headers[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
      }
    }
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, headers, body });
    return handler({ url, method, init });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function defaultOpts(overrides: Partial<HetznerOpts> = {}): HetznerOpts {
  return {
    apiToken: "test-token-abc",
    location: "fsn1",
    serverType: "cpx21",
    image: "ubuntu-24.04",
    sshKeyName: "tensol-ops",
    vpsAgentImage: "ghcr.io/tensol/vps-agent:1.0.0",
    webhookBaseUrl: "https://api.tensol.io",
    ...overrides,
  };
}

const sampleSpawnArgs = {
  scanId: "01ABCDEFGHIJKLMNOPQRSTUVWX",
  signKey: "deadbeefcafebabe1234567890abcdef",
};

describe("createHetznerProvider.spawnVps", () => {
  test("returns provider_server_id + ipv4 from POST /v1/servers response", async () => {
    const { fetchImpl, calls } = makeFetchMock(({ method, url }) => {
      if (method === "POST" && url === "https://api.hetzner.cloud/v1/servers") {
        return new Response(
          JSON.stringify({
            server: {
              id: 12345,
              public_net: { ipv4: { ip: "1.2.3.4" } },
              status: "initializing",
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    });

    const provider = createHetznerProvider({ ...defaultOpts(), fetchImpl });
    const result = await provider.spawnVps(sampleSpawnArgs);

    expect(result).toEqual({ provider_server_id: "12345", ipv4: "1.2.3.4" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer test-token-abc");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
  });

  test("cloud-init in user_data contains webhook URL, sign_key, and agent image", async () => {
    const { fetchImpl, calls } = makeFetchMock(() => {
      return new Response(
        JSON.stringify({ server: { id: 7, public_net: { ipv4: { ip: "9.9.9.9" } }, status: "initializing" } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = createHetznerProvider({ ...defaultOpts(), fetchImpl });
    await provider.spawnVps(sampleSpawnArgs);

    const body = calls[0]!.body as Record<string, unknown>;
    const userData = body.user_data as string;
    expect(typeof userData).toBe("string");
    expect(userData).toContain("TENSOL_WEBHOOK_BASE_URL");
    expect(userData).toContain("https://api.tensol.io");
    expect(userData).toContain("TENSOL_SIGN_KEY");
    // critical: signKey must appear verbatim
    expect(userData).toContain(sampleSpawnArgs.signKey);
    expect(userData).toContain("ghcr.io/tensol/vps-agent:1.0.0");
    expect(userData).toContain(sampleSpawnArgs.scanId);
    // server name should also carry scanId suffix (lowercased for DNS-style naming)
    expect(body.name).toEqual(expect.stringContaining(sampleSpawnArgs.scanId.toLowerCase()));
    expect(body.server_type).toBe("cpx21");
    expect(body.location).toBe("fsn1");
    expect(body.image).toBe("ubuntu-24.04");
    expect(body.ssh_keys).toEqual(["tensol-ops"]);
  });

  test("throws on 4xx with a descriptive message; no retry inside provider", async () => {
    let callCount = 0;
    const { fetchImpl } = makeFetchMock(() => {
      callCount += 1;
      return new Response(JSON.stringify({ error: { code: "invalid_input", message: "bad ssh key" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });

    const provider = createHetznerProvider({ ...defaultOpts(), fetchImpl });
    await expect(provider.spawnVps(sampleSpawnArgs)).rejects.toThrow(/hetzner/i);
    expect(callCount).toBe(1);
  });
});

describe("createHetznerProvider.getVpsStatus", () => {
  test("maps initializing → initializing on first poll, running → running on second", async () => {
    const responses = ["initializing", "running"];
    let i = 0;
    const { fetchImpl } = makeFetchMock(({ method }) => {
      if (method !== "GET") return new Response("no", { status: 500 });
      const status = responses[i++]!;
      return new Response(JSON.stringify({ server: { status } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const provider = createHetznerProvider({ ...defaultOpts(), fetchImpl });
    expect(await provider.getVpsStatus("12345")).toBe("initializing");
    expect(await provider.getVpsStatus("12345")).toBe("running");
  });

  test("returns 'destroyed' on 404 (server already gone)", async () => {
    const { fetchImpl } = makeFetchMock(() => {
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    const provider = createHetznerProvider({ ...defaultOpts(), fetchImpl });
    expect(await provider.getVpsStatus("12345")).toBe("destroyed");
  });

  test("maps 'off' → stopped, unknown server statuses → unknown", async () => {
    const responses = ["off", "weirdfutureStatus"];
    let i = 0;
    const { fetchImpl } = makeFetchMock(() => {
      const status = responses[i++]!;
      return new Response(JSON.stringify({ server: { status } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const provider = createHetznerProvider({ ...defaultOpts(), fetchImpl });
    expect(await provider.getVpsStatus("12345")).toBe("stopped");
    expect(await provider.getVpsStatus("12345")).toBe("unknown");
  });
});

describe("createHetznerProvider.destroyVps", () => {
  test("resolves on 200 DELETE", async () => {
    const { fetchImpl, calls } = makeFetchMock(({ method, url }) => {
      if (method === "DELETE" && url === "https://api.hetzner.cloud/v1/servers/12345") {
        return new Response("", { status: 200 });
      }
      return new Response("nope", { status: 500 });
    });

    const provider = createHetznerProvider({ ...defaultOpts(), fetchImpl });
    await expect(provider.destroyVps("12345")).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer test-token-abc");
  });

  test("idempotent: resolves on 404 (already gone)", async () => {
    const { fetchImpl } = makeFetchMock(() => {
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    const provider = createHetznerProvider({ ...defaultOpts(), fetchImpl });
    await expect(provider.destroyVps("12345")).resolves.toBeUndefined();
  });

  test("throws on 5xx", async () => {
    const { fetchImpl } = makeFetchMock(() => {
      return new Response("upstream broken", { status: 500 });
    });
    const provider = createHetznerProvider({ ...defaultOpts(), fetchImpl });
    await expect(provider.destroyVps("12345")).rejects.toThrow(/hetzner/i);
  });
});

describe("buildCloudInit", () => {
  test("returns bash script with required env vars and docker commands", () => {
    const script = buildCloudInit({
      vpsAgentImage: "ghcr.io/tensol/vps-agent:1.0.0",
      webhookBaseUrl: "https://api.tensol.io",
      signKey: "abcdef1234567890",
      scanId: "01SCAN",
    });

    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("TENSOL_WEBHOOK_BASE_URL=https://api.tensol.io");
    expect(script).toContain("TENSOL_SIGN_KEY=abcdef1234567890");
    expect(script).toContain("TENSOL_SCAN_ID=01SCAN");
    expect(script).toContain("ghcr.io/tensol/vps-agent:1.0.0");
    expect(script).toContain("get.docker.com");
    expect(script).toContain("docker");
    // firewall on port 8080
    expect(script).toMatch(/8080/);
  });

  test("escapes nothing dangerous — signKey is interpolated verbatim", () => {
    const script = buildCloudInit({
      vpsAgentImage: "img:1",
      webhookBaseUrl: "https://x",
      signKey: "key-with-dashes-and-numbers-987",
      scanId: "01Z",
    });
    expect(script).toContain("key-with-dashes-and-numbers-987");
  });
});

/**
 * T075 — vps-agent runtime contract extensions.
 *
 * The vps-agent container (T073, T074) needs:
 *   - `/var/run/docker.sock` mount so Decepticon's `docker compose up` works
 *     inside the agent container.
 *   - Port 8080 exposed for inbound /scan-start callback from coordinator.
 *   - Explicit `docker pull` so the run step never blocks on image fetch retries.
 *   - Restart policy so the agent survives transient crashes during long scans.
 *   - All 3 env vars (TENSOL_WEBHOOK_BASE_URL, TENSOL_SIGN_KEY, TENSOL_SCAN_ID)
 *     present together in a single env-injection block.
 */
describe("buildCloudInit — T075 vps-agent runtime contract", () => {
  const script = buildCloudInit({
    vpsAgentImage: "ghcr.io/tensol/vps-agent:1.0.0",
    webhookBaseUrl: "https://api.tensol.io",
    signKey: "abcdef1234567890",
    scanId: "01SCAN",
  });

  test("mounts /var/run/docker.sock so Decepticon compose stack can run", () => {
    expect(script).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  test("publishes container port 8080 for inbound /scan-start callback", () => {
    expect(script).toMatch(/-p\s+8080:8080/);
  });

  test("pulls the vps-agent image explicitly before docker run", () => {
    expect(script).toContain("docker pull ghcr.io/tensol/vps-agent:1.0.0");
    // pull must come BEFORE run, otherwise run would race image fetch
    const pullIdx = script.indexOf("docker pull");
    const runIdx = script.indexOf("docker run");
    expect(pullIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(-1);
    expect(pullIdx).toBeLessThan(runIdx);
  });

  test("declares an automatic restart policy", () => {
    expect(script).toMatch(/--restart[= ](unless-stopped|on-failure|always)/);
  });

  test("injects all 3 required env vars into the docker run command", () => {
    // All three must appear as -e VAR=... entries on the docker run line(s).
    expect(script).toMatch(/-e\s+TENSOL_WEBHOOK_BASE_URL/);
    expect(script).toMatch(/-e\s+TENSOL_SIGN_KEY/);
    expect(script).toMatch(/-e\s+TENSOL_SCAN_ID/);
    // And their values must reach the script body too.
    expect(script).toContain("https://api.tensol.io");
    expect(script).toContain("abcdef1234567890");
    expect(script).toContain("01SCAN");
  });
});
