/**
 * Follow-up #2 — `ensureFirewallRule` in gcp.ts.
 *
 * Prod gap (memory project_tensol_gcp_pivot_2026-05-22.md §"Discovered prod
 * gaps" #2): `gcp.ts` never provisioned the `allow-tensol-agent-8080`
 * firewall rule, so on a fresh GCP project every scan reached the
 * agent-dispatch wait and silently timed out after 8 minutes because the
 * server could not reach the VM's :8080.
 *
 * This test pins the idempotent-ensure contract that `spawnVm` now runs
 * BEFORE the instance insert:
 *
 *   1. RULE EXISTS — GET /global/firewalls/<name> → 200. No POST create.
 *      Instance insert proceeds.
 *   2. RULE MISSING — GET → 404 → POST /global/firewalls (create) → 200.
 *      Instance insert proceeds.
 *   3. MISSING + CANNOT CREATE — GET → 404, create → 403. spawnVm throws an
 *      actionable error carrying the manual `gcloud` command, and does NOT
 *      insert the instance (fail fast instead of an 8-minute agent timeout).
 *   4. CANNOT VERIFY — GET → 403 (SA lacks compute.firewalls.get but the
 *      operator-managed rule presumably exists). spawnVm proceeds with the
 *      instance insert (don't break a working prod just because we can't
 *      read the rule).
 *   5. CACHED — two spawnVm calls on the SAME provider instance only GET the
 *      firewall once.
 */
import { expect, test } from "bun:test";

import { createGcpCloudProvider } from "../../src/vps/gcp.ts";

const PROJECT = "tensol-scanners-test";
const ZONE = "europe-west1-b";
const FIREWALL_NAME = "allow-tensol-agent-8080";

type Call = { url: string; method: string };

/**
 * Build a routing fetcher + a recorder. `firewallGet` / `firewallCreate`
 * let each test override the firewall responses; the instance-insert,
 * operation-poll, and status-read responses are always the happy path so
 * spawnVm can run to completion when firewall checks pass.
 */
function makeFetcher(opts: {
  firewallGet: () => Response;
  firewallCreate?: () => Response;
}): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });

    // Firewall GET: /global/firewalls/<name>
    if (url.includes("/global/firewalls/") && method === "GET") {
      return opts.firewallGet();
    }
    // Firewall create: POST /global/firewalls
    if (url.endsWith("/global/firewalls") && method === "POST") {
      return (opts.firewallCreate ?? (() => json(200, { name: "op-fw-1", status: "DONE" })))();
    }
    // Instance insert: POST /instances?requestId=...
    if (url.includes("/instances?") && method === "POST") {
      return json(200, { name: "op-insert-1", status: "RUNNING" });
    }
    // Zonal operation poll: /operations/<op>
    if (url.includes("/operations/")) {
      return json(200, { name: "op-insert-1", status: "DONE" });
    }
    // Instance status read: GET /instances/<name>
    if (url.includes("/instances/") && method === "GET") {
      return json(200, {
        status: "RUNNING",
        networkInterfaces: [{ accessConfigs: [{ natIP: "203.0.113.7" }] }],
      });
    }
    return json(500, { error: `unexpected route: ${method} ${url}` });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseOpts = {
  config: { projectId: PROJECT, zone: ZONE },
  getToken: async () => "test-token",
} as const;

const spawnInput = {
  scanId: "01H0SCAN00000000000000000B",
  userData: "#!/bin/bash\necho hi",
  metadata: { "tensol-scan-id": "01H0SCAN00000000000000000B" },
};

test("rule exists (GET 200) → no create, instance insert proceeds", async () => {
  const { fetcher, calls } = makeFetcher({
    firewallGet: () => json(200, { name: FIREWALL_NAME }),
  });
  const provider = createGcpCloudProvider({ ...baseOpts, fetcher });

  const res = await provider.spawnVm(spawnInput);
  expect(res.instanceId).toContain("tensol-scan-");

  const fwGets = calls.filter(
    (c) => c.url.includes("/global/firewalls/") && c.method === "GET",
  );
  const fwCreates = calls.filter(
    (c) => c.url.endsWith("/global/firewalls") && c.method === "POST",
  );
  expect(fwGets).toHaveLength(1);
  expect(fwCreates).toHaveLength(0);
});

test("rule missing (GET 404) → create (POST 200) → instance insert proceeds", async () => {
  const { fetcher, calls } = makeFetcher({
    firewallGet: () => json(404, { error: { code: 404 } }),
    firewallCreate: () => json(200, { name: "op-fw-1", status: "DONE" }),
  });
  const provider = createGcpCloudProvider({ ...baseOpts, fetcher });

  await provider.spawnVm(spawnInput);

  const fwCreates = calls.filter(
    (c) => c.url.endsWith("/global/firewalls") && c.method === "POST",
  );
  const inserts = calls.filter(
    (c) => c.url.includes("/instances?") && c.method === "POST",
  );
  expect(fwCreates).toHaveLength(1);
  expect(inserts).toHaveLength(1);
});

test("missing + create 403 → throws actionable error, no instance insert", async () => {
  const { fetcher, calls } = makeFetcher({
    firewallGet: () => json(404, { error: { code: 404 } }),
    firewallCreate: () =>
      json(403, { error: { code: 403, message: "permission denied" } }),
  });
  const provider = createGcpCloudProvider({ ...baseOpts, fetcher });

  let threw: Error | null = null;
  try {
    await provider.spawnVm(spawnInput);
  } catch (e) {
    threw = e as Error;
  }
  expect(threw).not.toBeNull();
  // Actionable: names the firewall + a copy-pasteable gcloud command.
  expect(threw!.message).toContain(FIREWALL_NAME);
  expect(threw!.message.toLowerCase()).toContain("gcloud");

  // Fail fast — never attempted the instance insert.
  const inserts = calls.filter(
    (c) => c.url.includes("/instances?") && c.method === "POST",
  );
  expect(inserts).toHaveLength(0);
});

test("cannot verify (GET 403) → proceeds with instance insert", async () => {
  const { fetcher, calls } = makeFetcher({
    firewallGet: () => json(403, { error: { code: 403 } }),
  });
  const provider = createGcpCloudProvider({ ...baseOpts, fetcher });

  await provider.spawnVm(spawnInput);

  const inserts = calls.filter(
    (c) => c.url.includes("/instances?") && c.method === "POST",
  );
  expect(inserts).toHaveLength(1);
});

test("cached: two spawnVm calls GET the firewall only once", async () => {
  const { fetcher, calls } = makeFetcher({
    firewallGet: () => json(200, { name: FIREWALL_NAME }),
  });
  const provider = createGcpCloudProvider({ ...baseOpts, fetcher });

  await provider.spawnVm(spawnInput);
  await provider.spawnVm({ ...spawnInput, scanId: "01H0SCAN00000000000000000C" });

  const fwGets = calls.filter(
    (c) => c.url.includes("/global/firewalls/") && c.method === "GET",
  );
  expect(fwGets).toHaveLength(1);
});
