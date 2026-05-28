/**
 * T046 — Unit tests for `createYandexCloudProvider` (T043).
 *
 * No real Yandex API calls — every collaborator (`fetcher`, `getToken`,
 * `pollOp`) is injected so the suite runs offline in milliseconds.
 * Constitution VI: the real-API integration path is covered separately by
 * T047 behind `TENSOL_TEST_REAL_YANDEX=1`.
 *
 * Covers per tasks.md T046:
 *   - Idempotency-Key header passed on POST /instances
 *   - Operation polling path (spawnVm blocks on injected pollOp)
 *   - retry-on-429 (todo — current T043 impl does not retry; see below)
 *
 * Plus the rest of the `CloudProvider` surface that T046 implicitly covers
 * (teardownVm 404 idempotency, getStatus enum mapping + publicIp extraction,
 * pollOperation delegation).
 */

import { describe, expect, test } from "bun:test";

import { createYandexCloudProvider } from "./yandex";
import type { Operation } from "./yandex-operations";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

type FetchResponder = (
  call: RecordedCall,
  idx: number,
) => Response | Promise<Response>;

function makeFetchMock(responder: FetchResponder): {
  fetcher: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: FetchInput, init?: FetchInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else {
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { url, method, headers, body };
    const idx = calls.length;
    calls.push(call);
    return responder(call, idx);
  }) as typeof fetch;
  return { fetcher, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const BASE_CONFIG = {
  folderId: "b1gtestfolder000000",
  zoneId: "ru-central1-a",
  platformId: "standard-v3",
  cores: 2,
  memoryGB: 4,
  bootDiskImageId: "fd8nl4lp3frl63ds9ssn",
  bootDiskSizeGB: 30,
  networkInterfaceSpec: {
    networkId: "enp0test000000000000",
    subnetId: "e9bn0test00000000000",
  },
  sshPublicKey: "ssh-ed25519 AAAATEST tensol@ci",
};

const INSTANCES_URL = "https://compute.api.cloud.yandex.net/compute/v1/instances";

// ---------------------------------------------------------------------------
// spawnVm
// ---------------------------------------------------------------------------

describe("createYandexCloudProvider — spawnVm", () => {
  test("sends POST with Idempotency-Key set to scanId", async () => {
    const { fetcher, calls } = makeFetchMock((call) => {
      if (call.method === "POST") {
        return jsonResponse({
          id: "op-spawn-1",
          done: true,
          metadata: { instanceId: "vm-abc" },
        });
      }
      // Trailing GET /instances/{id}
      return jsonResponse({ id: "vm-abc", status: "RUNNING" });
    });

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok-1",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    await provider.spawnVm({
      scanId: "01J0000000000000000000SCAN",
      userData: "#!/bin/bash\necho hi",
    });

    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(post!.url).toBe(INSTANCES_URL);
    expect(post!.headers["idempotency-key"]).toBe(
      "01J0000000000000000000SCAN",
    );
  });

  test("sends Bearer <token> on Authorization header", async () => {
    const { fetcher, calls } = makeFetchMock((call) => {
      if (call.method === "POST") {
        return jsonResponse({
          id: "op-1",
          done: true,
          metadata: { instanceId: "vm-1" },
        });
      }
      return jsonResponse({ id: "vm-1", status: "RUNNING" });
    });

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok-bearer-xyz",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    await provider.spawnVm({ scanId: "S1", userData: "x" });

    for (const c of calls) {
      expect(c.headers.authorization).toBe("Bearer tok-bearer-xyz");
    }
  });

  test("builds correct request body shape", async () => {
    const { fetcher, calls } = makeFetchMock((call) => {
      if (call.method === "POST") {
        return jsonResponse({
          id: "op-1",
          done: true,
          metadata: { instanceId: "vm-1" },
        });
      }
      return jsonResponse({ id: "vm-1", status: "RUNNING" });
    });

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    await provider.spawnVm({
      scanId: "01J0000000000000000000SCAN",
      userData: "#cloud-config\nruncmd:\n- whoami",
      metadata: { owner: "tensol" },
    });

    const post = calls.find((c) => c.method === "POST")!;
    const body = post.body as Record<string, unknown>;
    expect(body.folderId).toBe(BASE_CONFIG.folderId);
    expect(body.zoneId).toBe(BASE_CONFIG.zoneId);
    expect(body.platformId).toBe(BASE_CONFIG.platformId);
    expect((body.resourcesSpec as Record<string, number>).cores).toBe(2);
    expect((body.resourcesSpec as Record<string, number>).memory).toBe(
      4 * 1024 * 1024 * 1024,
    );

    const bootDisk = body.bootDiskSpec as {
      autoDelete: boolean;
      diskSpec: { typeId: string; size: number; imageId: string };
    };
    expect(bootDisk.autoDelete).toBe(true);
    expect(bootDisk.diskSpec.typeId).toBe("network-ssd");
    expect(bootDisk.diskSpec.size).toBe(30 * 1024 * 1024 * 1024);
    expect(bootDisk.diskSpec.imageId).toBe(BASE_CONFIG.bootDiskImageId);

    const nics = body.networkInterfaceSpecs as Array<{
      subnetId: string;
      primaryV4AddressSpec: { oneToOneNatSpec: { ipVersion: string } };
    }>;
    expect(nics).toHaveLength(1);
    expect(nics[0]!.subnetId).toBe(BASE_CONFIG.networkInterfaceSpec.subnetId);
    expect(nics[0]!.primaryV4AddressSpec.oneToOneNatSpec.ipVersion).toBe(
      "IPV4",
    );

    const metadata = body.metadata as Record<string, string>;
    expect(metadata["user-data"]).toBe("#cloud-config\nruncmd:\n- whoami");
    expect(metadata["ssh-keys"]).toBe(
      `tensol:${BASE_CONFIG.sshPublicKey}`,
    );

    expect(body.labels).toEqual({ owner: "tensol" });

    // Name is lowercased + prefixed + clipped to 63 chars.
    expect(body.name).toBe("tensol-scan-01j0000000000000000000scan");
  });

  test("invokes injected pollOp with the returned operation id", async () => {
    let pollOpCalls = 0;
    let observedOpId = "";
    const { fetcher } = makeFetchMock((call) => {
      if (call.method === "POST") {
        return jsonResponse({
          id: "op-spawn-42",
          done: false,
          metadata: { instanceId: "vm-42" },
        });
      }
      return jsonResponse({ id: "vm-42", status: "RUNNING" });
    });

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => {
        pollOpCalls++;
        observedOpId = id;
        return { id, done: true } as Operation;
      },
    });

    await provider.spawnVm({ scanId: "S1", userData: "x" });
    expect(pollOpCalls).toBe(1);
    expect(observedOpId).toBe("op-spawn-42");
  });

  test("re-reads instance after op done to surface publicIp", async () => {
    const { fetcher, calls } = makeFetchMock((call) => {
      if (call.method === "POST") {
        return jsonResponse({
          id: "op-1",
          done: false,
          metadata: { instanceId: "vm-77" },
        });
      }
      return jsonResponse({
        id: "vm-77",
        status: "RUNNING",
        networkInterfaces: [
          {
            primaryV4Address: {
              address: "10.0.0.1",
              oneToOneNat: { address: "203.0.113.42" },
            },
          },
        ],
      });
    });

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    const result = await provider.spawnVm({ scanId: "S1", userData: "x" });
    expect(result.instanceId).toBe("vm-77");
    expect(result.operationId).toBe("op-1");
    expect(result.publicIp).toBe("203.0.113.42");

    // 2 calls expected: POST + GET status.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.url).toBe(`${INSTANCES_URL}/vm-77`);
  });

  test("omits publicIp when status read returns no NAT address", async () => {
    const { fetcher } = makeFetchMock((call) => {
      if (call.method === "POST") {
        return jsonResponse({
          id: "op-1",
          done: false,
          metadata: { instanceId: "vm-1" },
        });
      }
      return jsonResponse({ id: "vm-1", status: "PROVISIONING" });
    });

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    const result = await provider.spawnVm({ scanId: "S1", userData: "x" });
    expect(result.publicIp).toBeUndefined();
  });

  test("omits ssh-keys metadata entry when sshPublicKey is empty", async () => {
    const { fetcher, calls } = makeFetchMock((call) => {
      if (call.method === "POST") {
        return jsonResponse({
          id: "op-1",
          done: true,
          metadata: { instanceId: "vm-1" },
        });
      }
      return jsonResponse({ id: "vm-1", status: "RUNNING" });
    });

    const provider = createYandexCloudProvider({
      config: { ...BASE_CONFIG, sshPublicKey: "" },
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    await provider.spawnVm({ scanId: "S1", userData: "x" });
    const post = calls.find((c) => c.method === "POST")!;
    const metadata = (post.body as Record<string, unknown>)
      .metadata as Record<string, string>;
    expect(metadata["ssh-keys"]).toBeUndefined();
    expect(metadata["user-data"]).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// spawnVm — error paths
// ---------------------------------------------------------------------------

describe("createYandexCloudProvider — spawnVm errors", () => {
  test("throws on non-2xx POST response", async () => {
    const { fetcher } = makeFetchMock(
      () => new Response("invalid payload", { status: 400 }),
    );

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    await expect(
      provider.spawnVm({ scanId: "S1", userData: "x" }),
    ).rejects.toThrow(/HTTP 400/);
  });

  test("throws when metadata.instanceId is missing from create response", async () => {
    const { fetcher } = makeFetchMock(() =>
      jsonResponse({ id: "op-1", done: false, metadata: {} }),
    );

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    await expect(
      provider.spawnVm({ scanId: "S1", userData: "x" }),
    ).rejects.toThrow(/instanceId/);
  });

  test("throws when poll resolves with error field", async () => {
    const { fetcher } = makeFetchMock((call) => {
      if (call.method === "POST") {
        return jsonResponse({
          id: "op-1",
          done: false,
          metadata: { instanceId: "vm-1" },
        });
      }
      return jsonResponse({ id: "vm-1", status: "ERROR" });
    });

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) =>
        ({
          id,
          done: true,
          error: { code: 13, message: "INTERNAL" },
        }) as Operation,
    });

    await expect(
      provider.spawnVm({ scanId: "S1", userData: "x" }),
    ).rejects.toThrow(/op failed/);
  });

  test.todo(
    "retry-on-429: Yandex returns 429 → provider retries with backoff (not yet implemented in T043; tracked for follow-up)",
    () => {
      // Placeholder: T043's POST handler unconditionally throws on !resp.ok,
      // so 429 currently surfaces as an error. A follow-up task should
      // wrap the POST in an exponential-backoff retry loop bounded by the
      // 10-minute operation budget.
    },
  );
});

// ---------------------------------------------------------------------------
// teardownVm
// ---------------------------------------------------------------------------

describe("createYandexCloudProvider — teardownVm", () => {
  test("sends DELETE with Bearer token to /instances/{id}", async () => {
    const { fetcher, calls } = makeFetchMock(() =>
      jsonResponse({ id: "op-teardown-1", done: false }),
    );

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok-del",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    const result = await provider.teardownVm("vm-doomed");
    expect(result.operationId).toBe("op-teardown-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`${INSTANCES_URL}/vm-doomed`);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-del");
  });

  test("returns {} on 404 (idempotent, no throw)", async () => {
    const { fetcher } = makeFetchMock(
      () => new Response("not found", { status: 404 }),
    );

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    const result = await provider.teardownVm("vm-already-gone");
    expect(result).toEqual({});
  });

  test("throws on other non-2xx responses (e.g. 500)", async () => {
    const { fetcher } = makeFetchMock(
      () => new Response("boom", { status: 500 }),
    );

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    await expect(provider.teardownVm("vm-1")).rejects.toThrow(/HTTP 500/);
  });

  test("URL-encodes the instanceId path segment", async () => {
    const { fetcher, calls } = makeFetchMock(() =>
      jsonResponse({ id: "op-x", done: false }),
    );

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });

    await provider.teardownVm("vm/with slash");
    expect(calls[0]!.url).toBe(`${INSTANCES_URL}/vm%2Fwith%20slash`);
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe("createYandexCloudProvider — getStatus", () => {
  function makeProvider(responder: FetchResponder) {
    const { fetcher, calls } = makeFetchMock(responder);
    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok-status",
      pollOp: async (id) => ({ id, done: true } as Operation),
    });
    return { provider, calls };
  }

  test("sends GET with Bearer token", async () => {
    const { provider, calls } = makeProvider(() =>
      jsonResponse({ id: "vm-1", status: "RUNNING" }),
    );
    await provider.getStatus("vm-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${INSTANCES_URL}/vm-1`);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-status");
  });

  test("returns 'stopped' on 404 (instance reaped or never existed)", async () => {
    const { provider } = makeProvider(
      () => new Response("not found", { status: 404 }),
    );
    const status = await provider.getStatus("vm-gone");
    expect(status).toEqual({ instanceId: "vm-gone", status: "stopped" });
  });

  test("throws on other non-2xx (e.g. 500)", async () => {
    const { provider } = makeProvider(
      () => new Response("boom", { status: 500 }),
    );
    await expect(provider.getStatus("vm-1")).rejects.toThrow(/HTTP 500/);
  });

  test("maps PROVISIONING → provisioning", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ id: "vm-1", status: "PROVISIONING" }),
    );
    const status = await provider.getStatus("vm-1");
    expect(status.status).toBe("provisioning");
  });

  test("maps STARTING → provisioning", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ id: "vm-1", status: "STARTING" }),
    );
    const status = await provider.getStatus("vm-1");
    expect(status.status).toBe("provisioning");
  });

  test("maps CREATING → provisioning", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ id: "vm-1", status: "CREATING" }),
    );
    const status = await provider.getStatus("vm-1");
    expect(status.status).toBe("provisioning");
  });

  test("maps RUNNING → running", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ id: "vm-1", status: "RUNNING" }),
    );
    const status = await provider.getStatus("vm-1");
    expect(status.status).toBe("running");
  });

  test("maps STOPPING → stopping", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ id: "vm-1", status: "STOPPING" }),
    );
    const status = await provider.getStatus("vm-1");
    expect(status.status).toBe("stopping");
  });

  test("maps STOPPED / DELETING / DELETED → stopped", async () => {
    for (const yandex of ["STOPPED", "DELETING", "DELETED"]) {
      const { provider } = makeProvider(() =>
        jsonResponse({ id: "vm-1", status: yandex }),
      );
      const status = await provider.getStatus("vm-1");
      expect(status.status).toBe("stopped");
    }
  });

  test("maps unknown status → error", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ id: "vm-1", status: "ZOMBIE_MODE" }),
    );
    const status = await provider.getStatus("vm-1");
    expect(status.status).toBe("error");
  });

  test("extracts publicIp from networkInterfaces[0].primaryV4Address.oneToOneNat.address", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({
        id: "vm-1",
        status: "RUNNING",
        networkInterfaces: [
          {
            primaryV4Address: {
              address: "10.128.0.5",
              oneToOneNat: { address: "84.201.0.42" },
            },
          },
        ],
      }),
    );
    const status = await provider.getStatus("vm-1");
    expect(status.publicIp).toBe("84.201.0.42");
  });

  test("falls back to primaryV4Address.address when no NAT", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({
        id: "vm-1",
        status: "RUNNING",
        networkInterfaces: [{ primaryV4Address: { address: "10.128.0.5" } }],
      }),
    );
    const status = await provider.getStatus("vm-1");
    expect(status.publicIp).toBe("10.128.0.5");
  });

  test("omits publicIp when no networkInterfaces", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ id: "vm-1", status: "RUNNING" }),
    );
    const status = await provider.getStatus("vm-1");
    expect(status.publicIp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pollOperation — delegation to injected helper
// ---------------------------------------------------------------------------

describe("createYandexCloudProvider — pollOperation", () => {
  test("delegates to injected pollOp and forwards getToken", async () => {
    let observedOpId = "";
    let getTokenInvoked = false;
    const { fetcher } = makeFetchMock(() => jsonResponse({}));

    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => {
        getTokenInvoked = true;
        return "tok-poll";
      },
      pollOp: async (id, opts) => {
        observedOpId = id;
        // Confirm the provider forwards getToken to the poller.
        if (opts?.getToken) await opts.getToken();
        return { id, done: true } as Operation;
      },
    });

    const result = await provider.pollOperation("op-pending-1");
    expect(observedOpId).toBe("op-pending-1");
    expect(getTokenInvoked).toBe(true);
    expect(result).toEqual({ operationId: "op-pending-1", done: true });
  });

  test("returns {done:false} while operation still pending", async () => {
    const { fetcher } = makeFetchMock(() => jsonResponse({}));
    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) => ({ id, done: false } as Operation),
    });
    const result = await provider.pollOperation("op-1");
    expect(result).toEqual({ operationId: "op-1", done: false });
  });

  test("propagates terminal error from pollOp into OperationResult.error", async () => {
    const { fetcher } = makeFetchMock(() => jsonResponse({}));
    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) =>
        ({
          id,
          done: true,
          error: { code: 9, message: "FAILED_PRECONDITION" },
        }) as Operation,
    });
    const result = await provider.pollOperation("op-err");
    expect(result.done).toBe(true);
    expect(result.error).toBe("FAILED_PRECONDITION");
    expect(result.result).toBeUndefined();
  });

  test("populates OperationResult.result on successful spawn-shaped response", async () => {
    const { fetcher } = makeFetchMock(() => jsonResponse({}));
    const provider = createYandexCloudProvider({
      config: BASE_CONFIG,
      fetcher,
      getToken: async () => "tok",
      pollOp: async (id) =>
        ({
          id,
          done: true,
          response: { instanceId: "vm-99", operationId: id },
        }) as Operation,
    });
    const result = await provider.pollOperation("op-ok");
    expect(result.done).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      instanceId: "vm-99",
      operationId: "op-ok",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveConfig — required-folderId guard
// ---------------------------------------------------------------------------

describe("createYandexCloudProvider — config validation", () => {
  test("throws when folderId is missing from both opts and env", () => {
    const prev = process.env.YANDEX_PROD_FOLDER_ID;
    delete process.env.YANDEX_PROD_FOLDER_ID;
    try {
      const { fetcher } = makeFetchMock(() => jsonResponse({}));
      expect(() =>
        createYandexCloudProvider({
          // No folderId override → must throw.
          fetcher,
          getToken: async () => "tok",
          pollOp: async (id) => ({ id, done: true } as Operation),
        }),
      ).toThrow(/folderId is required/);
    } finally {
      if (prev !== undefined) process.env.YANDEX_PROD_FOLDER_ID = prev;
    }
  });
});
