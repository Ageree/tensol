/**
 * T040 — dispatch_scan handler tests.
 *
 * The handler is built via
 * `createDispatchScanHandler({ db, signingKey, fetchImpl, now, webhookBaseUrl })`.
 * `fetchImpl` is mocked exclusively; nothing leaves the test process.
 *
 * Coverage targets (per T040 brief):
 *   1. HAPPY PATH — POST to https://<ipv4>/scan with HMAC signature header
 *      derived from the VPS row's sign_key over the canonical body;
 *      decepticon_invoked audit emitted on 200.
 *   2. 5xx → throws (runner retries); no audit.
 *   3. Network error → throws.
 *   4. Missing vps_instance row → throws (no fetch attempted).
 *   5. Audit chain verifies after a happy run.
 *
 * Design choices documented in the handler module-level comment:
 *   - HTTPS to a raw IPv4 host: we trust the connection because the VPS
 *     advertises a sign_key established out-of-band via cloud-init; the
 *     application-layer HMAC is what authenticates request bodies. For TLS,
 *     production injects a fetch wrapper that disables CA validation
 *     (raw-IP cert). Tests use a pure mock so no TLS path runs.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../db/client.ts";
import {
  auditLog,
  projects,
  scans,
  targets,
  users,
  vpsInstances,
} from "../../db/schema.ts";
import { verifyChain } from "../../audit/verify-chain.ts";
import { hmacSha256 } from "../../lib/crypto.ts";
import { createDispatchScanHandler } from "./dispatch-scan.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "migrations");

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

function applyMigrations(db: DB): void {
  (db.$client as Database).exec(migrationSql());
}

const TEST_SIGNING_KEY = "test-audit-signing-key-dispatch";
const VPS_SIGN_KEY = "0".repeat(64);
const WEBHOOK_BASE = "https://api.tensol.test";

const FIXED_USER_ID = "01H0USER000000000000000DSA";
const FIXED_PROJECT_ID = "01H0PROJ000000000000000DSA";
const FIXED_TARGET_ID = "01H0TGT00000000000000000DS";
const FIXED_SCAN_ID = "01H0SCAN0000000000000000DS";
const FIXED_VPS_ID = "01H0VPS00000000000000000DS";

function seedRunningScanWithVps(db: DB, opts?: { ipv4?: string }): void {
  const ts = 1_700_000_000_000;
  db.insert(users)
    .values({ id: FIXED_USER_ID, email: "ds@x.test", createdAt: ts })
    .run();
  db.insert(projects)
    .values({
      id: FIXED_PROJECT_ID,
      userId: FIXED_USER_ID,
      name: "P",
      createdAt: ts,
    })
    .run();
  db.insert(targets)
    .values({
      id: FIXED_TARGET_ID,
      projectId: FIXED_PROJECT_ID,
      url: "https://target.example.test",
      status: "verified",
      verifiedAt: ts,
      createdAt: ts,
    })
    .run();
  db.insert(scans)
    .values({
      id: FIXED_SCAN_ID,
      userId: FIXED_USER_ID,
      targetId: FIXED_TARGET_ID,
      profile: "standard",
      status: "running",
      startedAt: ts,
    })
    .run();
  db.insert(vpsInstances)
    .values({
      id: FIXED_VPS_ID,
      scanId: FIXED_SCAN_ID,
      provider: "hetzner",
      providerServerId: "srv-ds-1",
      ipv4: opts?.ipv4 ?? "10.20.30.40",
      status: "alive",
      signKey: VPS_SIGN_KEY,
      createdAt: ts,
    })
    .run();
}

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string | undefined;
};

function makeFetchMock(
  responder: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
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
          headers[pair[0]!.toLowerCase()] = pair[1] as string;
        }
      } else {
        for (const [k, v] of Object.entries(h)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    const rawBody =
      typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = { url, method, headers, rawBody };
    calls.push(call);
    return await responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-dispatch-scan-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — HAPPY PATH
// ---------------------------------------------------------------------------
test("happy path: POST to vps with HMAC signature header; decepticon_invoked audit emitted", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedRunningScanWithVps(db);

  const { fetchImpl, calls } = makeFetchMock(() => new Response("ok", { status: 200 }));

  const handler = createDispatchScanHandler({
    db,
    signingKey: TEST_SIGNING_KEY,
    fetchImpl,
    webhookBaseUrl: WEBHOOK_BASE,
  });

  await handler(
    {
      type: "dispatch_scan",
      scan_id: FIXED_SCAN_ID,
      vps_instance_id: FIXED_VPS_ID,
    },
    { jobId: "01H0JOB00000000000000000DS", attempts: 1 },
  );

  // Exactly one POST hit the VPS.
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.method).toBe("POST");
  expect(call.url).toBe("https://10.20.30.40/scan");
  expect(call.headers["content-type"]).toContain("application/json");
  // Body contains scan params.
  expect(call.rawBody).toBeDefined();
  const body = JSON.parse(call.rawBody!) as Record<string, unknown>;
  expect(body.scan_id).toBe(FIXED_SCAN_ID);
  expect(body.target_url).toBe("https://target.example.test");
  expect(body.profile).toBe("standard");
  expect(body.webhook_url).toBe(`${WEBHOOK_BASE}/webhooks/scan-progress`);
  // The VPS sign_key itself MUST NOT be in the body (VPS already has it via
  // cloud-init); the body is only AUTHENTICATED via the signature header.
  expect(call.rawBody!.includes(VPS_SIGN_KEY)).toBe(false);
  // Signature header present and equal to HMAC-SHA256(signKey, rawBody).
  const sigHeader =
    call.headers["x-tensol-signature"] ??
    call.headers["x-tensol-signature".toLowerCase()];
  expect(sigHeader).toBeDefined();
  const expectedSig = hmacSha256(VPS_SIGN_KEY, call.rawBody!);
  expect(sigHeader).toBe(expectedSig);

  // Audit row emitted.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "decepticon_invoked"))
    .all();
  expect(auditRows).toHaveLength(1);
  const a = auditRows[0]!;
  expect(a.outcome).toBe("success");
  expect(a.scanId).toBe(FIXED_SCAN_ID);
  expect(a.vpsInstanceId).toBe(FIXED_VPS_ID);
  const meta = JSON.parse(a.metadataJson) as Record<string, unknown>;
  expect(meta.target_url).toBe("https://target.example.test");
  expect(meta.profile).toBe("standard");
  // SECURITY: sign_key MUST NOT leak.
  const metaStr = JSON.stringify(meta);
  expect(metaStr.includes(VPS_SIGN_KEY)).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 2 — 5xx → throw, no audit
// ---------------------------------------------------------------------------
test("non-2xx response throws; no audit emitted", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedRunningScanWithVps(db);

  const { fetchImpl, calls } = makeFetchMock(
    () => new Response("server down", { status: 503 }),
  );

  const handler = createDispatchScanHandler({
    db,
    signingKey: TEST_SIGNING_KEY,
    fetchImpl,
    webhookBaseUrl: WEBHOOK_BASE,
  });

  let threw: Error | null = null;
  try {
    await handler(
      {
        type: "dispatch_scan",
        scan_id: FIXED_SCAN_ID,
        vps_instance_id: FIXED_VPS_ID,
      },
      { jobId: "j", attempts: 1 },
    );
  } catch (err) {
    threw = err as Error;
  }
  expect(threw).not.toBeNull();
  expect(threw!.message).toMatch(/503|dispatch_scan/i);
  expect(calls).toHaveLength(1);
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "decepticon_invoked"))
    .all();
  expect(auditRows).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 3 — network error → throw
// ---------------------------------------------------------------------------
test("fetch throws (network failure) → handler propagates", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedRunningScanWithVps(db);

  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const handler = createDispatchScanHandler({
    db,
    signingKey: TEST_SIGNING_KEY,
    fetchImpl,
    webhookBaseUrl: WEBHOOK_BASE,
  });

  let threw: Error | null = null;
  try {
    await handler(
      {
        type: "dispatch_scan",
        scan_id: FIXED_SCAN_ID,
        vps_instance_id: FIXED_VPS_ID,
      },
      { jobId: "j", attempts: 1 },
    );
  } catch (err) {
    threw = err as Error;
  }
  expect(threw).not.toBeNull();
  expect(threw!.message).toContain("ECONNREFUSED");
});

// ---------------------------------------------------------------------------
// Test 4 — missing vps_instance row → throw, no fetch
// ---------------------------------------------------------------------------
test("missing vps_instance row → throws before any fetch", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  // Note: do NOT seed vps_instances.

  const { fetchImpl, calls } = makeFetchMock(
    () => new Response("ok", { status: 200 }),
  );

  const handler = createDispatchScanHandler({
    db,
    signingKey: TEST_SIGNING_KEY,
    fetchImpl,
    webhookBaseUrl: WEBHOOK_BASE,
  });

  let threw: Error | null = null;
  try {
    await handler(
      {
        type: "dispatch_scan",
        scan_id: FIXED_SCAN_ID,
        vps_instance_id: "01H0VPS00000000000000MISS",
      },
      { jobId: "j", attempts: 1 },
    );
  } catch (err) {
    threw = err as Error;
  }
  expect(threw).not.toBeNull();
  expect(threw!.message).toMatch(/vps_instance|not found/i);
  expect(calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 5 — audit chain intact after happy run
// ---------------------------------------------------------------------------
test("audit chain verifies after happy-path emission", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  seedRunningScanWithVps(db);

  const { fetchImpl } = makeFetchMock(() => new Response("ok", { status: 200 }));

  const handler = createDispatchScanHandler({
    db,
    signingKey: TEST_SIGNING_KEY,
    fetchImpl,
    webhookBaseUrl: WEBHOOK_BASE,
  });

  await handler(
    {
      type: "dispatch_scan",
      scan_id: FIXED_SCAN_ID,
      vps_instance_id: FIXED_VPS_ID,
    },
    { jobId: "j", attempts: 1 },
  );

  const result = verifyChain(db, TEST_SIGNING_KEY);
  expect(result.ok).toBe(true);
  expect(result.rows).toBeGreaterThanOrEqual(1);
});
