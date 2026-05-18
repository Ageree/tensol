/**
 * T044 — Integration tests for `POST /webhooks/scan-progress`.
 *
 * Contract refs:
 *   - `specs/001-backend-v2/contracts/webhook.md` (HMAC headers, idempotency)
 *   - `server/src/schemas/webhook.ts` (T042: ScanProgressCallbackSchema)
 *   - `server/src/findings/service.ts` (T043: storeFindings dedup)
 *
 * Surface under test:
 *   POST /webhooks/scan-progress
 *     Headers:
 *       X-Tensol-Scan-Id: <ULID>
 *       X-Tensol-Signature: <hex HMAC-SHA256 of raw body, keyed by vps_instance.sign_key>
 *       Content-Type: application/json
 *     Responses:
 *       200 {ok, inserted, skipped}       — happy path (done|failed)
 *       200 {ok, duplicate:true}           — scan already terminal
 *       400 {error: invalid_body}          — Zod parse failure
 *       401 {error: webhook_signature_invalid}
 *       404 {error: scan_not_found}        — unknown scan OR vps already destroyed
 *
 * Test strategy mirrors `scan-lifecycle.test.ts`:
 *   - `:memory:` SQLite per test (migrations applied).
 *   - Direct Drizzle seeding of user/project/target/scan/vps_instance — we
 *     skip the magic-link, scan-start, spawn-vps ceremony because those are
 *     already covered by T026/T034/T041.
 *   - No auth middleware on this route: HMAC is the only auth.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  auditLog,
  findings as findingsTable,
  jobs as jobsTable,
  projects as projectsTable,
  scans as scansTable,
  targets as targetsTable,
  users as usersTable,
  vpsInstances as vpsInstancesTable,
} from "../../src/db/schema.ts";
import { createClock } from "../../src/lib/time.ts";
import { ulid } from "../../src/lib/ids.ts";
import { hmacSha256 } from "../../src/lib/crypto.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { createWebhookRoutes } from "../../src/routes/webhooks.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY =
  "test-key-64-chars-hex-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

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

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  return db;
}

interface SeededScan {
  readonly userId: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly scanId: string;
  readonly vpsInstanceId: string;
  readonly signKey: string;
}

/** Seed a user, project, verified target, running scan, alive vps_instance. */
function seedRunningScan(
  db: DB,
  args: { now: number; signKey?: string; vpsStatus?: "provisioning" | "alive" | "tearing_down" | "destroyed" },
): SeededScan {
  const signKey = args.signKey ?? "vps-sign-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const userId = ulid(args.now);
  db.insert(usersTable)
    .values({ id: userId, email: "alice@example.com", createdAt: args.now })
    .run();
  const projectId = ulid(args.now + 1);
  db.insert(projectsTable)
    .values({
      id: projectId,
      userId,
      name: "P",
      createdAt: args.now,
    })
    .run();
  const targetId = ulid(args.now + 2);
  db.insert(targetsTable)
    .values({
      id: targetId,
      projectId,
      url: "https://example.com",
      status: "verified",
      verifiedAt: args.now,
      createdAt: args.now,
    })
    .run();
  const scanId = ulid(args.now + 3);
  db.insert(scansTable)
    .values({
      id: scanId,
      userId,
      targetId,
      profile: "recon",
      status: "running",
      startedAt: args.now,
      failureReason: null,
      completedAt: null,
      usageTokens: null,
      usageUsdCents: null,
    })
    .run();
  const vpsInstanceId = ulid(args.now + 4);
  db.insert(vpsInstancesTable)
    .values({
      id: vpsInstanceId,
      scanId,
      provider: "hetzner",
      providerServerId: "srv-test",
      ipv4: "10.0.0.1",
      status: args.vpsStatus ?? "alive",
      signKey,
      createdAt: args.now,
      destroyedAt: null,
    })
    .run();
  return { userId, projectId, targetId, scanId, vpsInstanceId, signKey };
}

interface BuiltApp {
  readonly app: Hono;
}

function buildApp(opts: { db: DB; now: () => number }): BuiltApp {
  const app = new Hono();
  app.route(
    "/webhooks",
    createWebhookRoutes({
      db: opts.db,
      signingKey: SIGNING_KEY,
      now: opts.now,
    }),
  );
  return { app };
}

/** Compute HMAC over the EXACT raw body bytes that will be POSTed. */
function sign(rawBody: string, key: string): string {
  return hmacSha256(key, rawBody);
}

interface CallbackBodyArgs {
  readonly scanId: string;
  readonly status: "done" | "failed";
  readonly failureReason?: string | null;
  readonly findings?: Array<{
    severity: "critical" | "high" | "medium" | "low" | "info";
    title: string;
    body_md: string;
    evidence?: { request?: string; response?: string };
  }>;
  readonly usage?: { tokens: number; usd_cents: number } | null;
}

function makeCallbackBody(args: CallbackBodyArgs): string {
  return JSON.stringify({
    scan_id: args.scanId,
    status: args.status,
    failure_reason: args.failureReason ?? null,
    usage: args.usage === undefined ? { tokens: 100, usd_cents: 5 } : args.usage,
    findings: args.findings ?? [],
  });
}

// ---------------------------------------------------------------------------
// Test 1 — Happy path: valid signature, status=done, findings inserted.
// ---------------------------------------------------------------------------
test("T044: valid signature → 200 + scan completed + findings inserted + teardown enqueued + audit", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const seeded = seedRunningScan(db, { now: clock.now() });
  const { app } = buildApp({ db, now: clock.now });

  const body = makeCallbackBody({
    scanId: seeded.scanId,
    status: "done",
    findings: [
      {
        severity: "high",
        title: "Reflected XSS in /search",
        body_md: "Unsanitised `q` parameter.",
        evidence: { request: "GET /search?q=<script>", response: "<script>" },
      },
      {
        severity: "low",
        title: "Server header leak",
        body_md: "X-Powered-By exposed.",
      },
    ],
    usage: { tokens: 1234, usd_cents: 7 },
  });
  const signature = sign(body, seeded.signKey);

  const res = await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": seeded.scanId,
      "X-Tensol-Signature": signature,
    },
    body,
  });
  expect(res.status).toBe(200);
  const responseBody = (await res.json()) as {
    ok: boolean;
    inserted: number;
    skipped: number;
  };
  expect(responseBody.ok).toBe(true);
  expect(responseBody.inserted).toBe(2);
  expect(responseBody.skipped).toBe(0);

  // Scan transitioned → completed.
  const scanRow = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, seeded.scanId))
    .get();
  expect(scanRow!.status).toBe("completed");
  expect(scanRow!.completedAt).not.toBeNull();
  expect(scanRow!.usageTokens).toBe(1234);
  expect(scanRow!.usageUsdCents).toBe(7);

  // Findings rows inserted.
  const findingsRows = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, seeded.scanId))
    .all();
  expect(findingsRows).toHaveLength(2);

  // teardown_vps job enqueued.
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(1);
  const payload = JSON.parse(teardownJobs[0]!.payloadJson) as {
    type: string;
    vps_instance_id: string;
    reason: string;
  };
  expect(payload.type).toBe("teardown_vps");
  expect(payload.vps_instance_id).toBe(seeded.vpsInstanceId);
  expect(payload.reason).toBe("completed");

  // scan_completed audit emitted.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_completed"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.scanId).toBe(seeded.scanId);

  // Audit chain intact.
  const chain = verifyChain(db, SIGNING_KEY);
  expect(chain.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 2 — Bad signature → 401 + audit + scan untouched.
// ---------------------------------------------------------------------------
test("T044: signature mismatch → 401 webhook_signature_invalid + audit + scan untouched", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const seeded = seedRunningScan(db, { now: clock.now() });
  const { app } = buildApp({ db, now: clock.now });

  const body = makeCallbackBody({ scanId: seeded.scanId, status: "done" });
  // Sign with the WRONG key.
  const badSignature = sign(body, "wrong-key");

  const res = await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": seeded.scanId,
      "X-Tensol-Signature": badSignature,
    },
    body,
  });
  expect(res.status).toBe(401);
  const respBody = (await res.json()) as { error: string };
  expect(respBody.error).toBe("webhook_signature_invalid");

  // Scan status untouched.
  const scanRow = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, seeded.scanId))
    .get();
  expect(scanRow!.status).toBe("running");
  expect(scanRow!.completedAt).toBeNull();

  // No findings inserted.
  const findingsRows = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, seeded.scanId))
    .all();
  expect(findingsRows).toHaveLength(0);

  // No teardown job.
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(0);

  // webhook_signature_invalid audit emitted.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "webhook_signature_invalid"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.scanId).toBe(seeded.scanId);
  expect(audits[0]!.outcome).toBe("rejected");

  // Audit chain still intact.
  const chain = verifyChain(db, SIGNING_KEY);
  expect(chain.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3 — Unknown scan → 404 scan_not_found.
// ---------------------------------------------------------------------------
test("T044: unknown scan_id → 404 scan_not_found", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const { app } = buildApp({ db, now: clock.now });

  const unknownScanId = ulid(clock.now());
  const body = makeCallbackBody({ scanId: unknownScanId, status: "done" });
  const signature = sign(body, "any-key");

  const res = await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": unknownScanId,
      "X-Tensol-Signature": signature,
    },
    body,
  });
  expect(res.status).toBe(404);
  const respBody = (await res.json()) as { error: string };
  expect(respBody.error).toBe("scan_not_found");
});

// ---------------------------------------------------------------------------
// Test 4 — Duplicate callback → 200 {duplicate:true}, no double-insert.
// ---------------------------------------------------------------------------
test("T044: duplicate callback → 200 duplicate=true + no double findings/teardown/audit", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const seeded = seedRunningScan(db, { now: clock.now() });
  const { app } = buildApp({ db, now: clock.now });

  const body = makeCallbackBody({
    scanId: seeded.scanId,
    status: "done",
    findings: [
      {
        severity: "medium",
        title: "Open redirect on /next",
        body_md: "Param `next=` allows host change.",
      },
    ],
  });
  const signature = sign(body, seeded.signKey);
  const headers = {
    "Content-Type": "application/json",
    "X-Tensol-Scan-Id": seeded.scanId,
    "X-Tensol-Signature": signature,
  };

  // First call — happy.
  const first = await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers,
    body,
  });
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as {
    ok: boolean;
    inserted: number;
  };
  expect(firstBody.inserted).toBe(1);

  // Second call — same payload, same signature, scan already terminal.
  const second = await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers,
    body,
  });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as {
    ok: boolean;
    duplicate: boolean;
  };
  expect(secondBody.ok).toBe(true);
  expect(secondBody.duplicate).toBe(true);

  // No double-insert of findings.
  const findingsRows = db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.scanId, seeded.scanId))
    .all();
  expect(findingsRows).toHaveLength(1);

  // No second teardown job.
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(1);

  // No second scan_completed audit.
  const completedAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_completed"))
    .all();
  expect(completedAudits).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Test 5 — status=failed → scan.failed + teardown + scan_failed audit.
// ---------------------------------------------------------------------------
test("T044: status=failed → scan.failed + failureReason recorded + teardown + scan_failed audit", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const seeded = seedRunningScan(db, { now: clock.now() });
  const { app } = buildApp({ db, now: clock.now });

  const body = makeCallbackBody({
    scanId: seeded.scanId,
    status: "failed",
    failureReason: "agent_timeout",
    findings: [],
    usage: null,
  });
  const signature = sign(body, seeded.signKey);

  const res = await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": seeded.scanId,
      "X-Tensol-Signature": signature,
    },
    body,
  });
  expect(res.status).toBe(200);

  const scanRow = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, seeded.scanId))
    .get();
  expect(scanRow!.status).toBe("failed");
  expect(scanRow!.failureReason).toBe("agent_timeout");
  expect(scanRow!.completedAt).not.toBeNull();

  // Teardown enqueued.
  const teardownJobs = db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, "teardown_vps"))
    .all();
  expect(teardownJobs).toHaveLength(1);
  const payload = JSON.parse(teardownJobs[0]!.payloadJson) as { reason: string };
  expect(payload.reason).toBe("failed");

  // scan_failed audit emitted.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "scan_failed"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.outcome).toBe("failure");
});

// ---------------------------------------------------------------------------
// Test 6 — Zod failure → 400 invalid_body.
// ---------------------------------------------------------------------------
test("T044: invalid body (missing scan_id field) → 400 invalid_body", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const seeded = seedRunningScan(db, { now: clock.now() });
  const { app } = buildApp({ db, now: clock.now });

  // Body is JSON-parseable but missing required scan_id.
  const body = JSON.stringify({
    status: "done",
    failure_reason: null,
    usage: null,
    findings: [],
  });
  const signature = sign(body, seeded.signKey);

  const res = await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": seeded.scanId,
      "X-Tensol-Signature": signature,
    },
    body,
  });
  expect(res.status).toBe(400);
  const respBody = (await res.json()) as { error: string };
  expect(respBody.error).toBe("invalid_body");
});

// ---------------------------------------------------------------------------
// Test 7 — VPS already destroyed → 404 (no live instance for sig verify).
// ---------------------------------------------------------------------------
test("T044: vps_instance.status=destroyed → 404 scan_not_found", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const seeded = seedRunningScan(db, {
    now: clock.now(),
    vpsStatus: "destroyed",
  });
  const { app } = buildApp({ db, now: clock.now });

  const body = makeCallbackBody({ scanId: seeded.scanId, status: "done" });
  const signature = sign(body, seeded.signKey);

  const res = await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": seeded.scanId,
      "X-Tensol-Signature": signature,
    },
    body,
  });
  expect(res.status).toBe(404);
  const respBody = (await res.json()) as { error: string };
  expect(respBody.error).toBe("scan_not_found");
});

// ---------------------------------------------------------------------------
// Test 8 — Raw-body verification: subtle whitespace difference breaks sig.
//
// Confirms we verify the EXACT bytes posted, not a re-stringified parse.
// ---------------------------------------------------------------------------
test("T044: HMAC verifies raw bytes — whitespace in body changes signature", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const seeded = seedRunningScan(db, { now: clock.now() });
  const { app } = buildApp({ db, now: clock.now });

  // Body with extra whitespace formatting. We compute signature over THIS
  // exact string, then POST the same string. If the handler re-stringified
  // before HMAC verify, the canonicalised body would have different bytes
  // and our pre-computed signature would still match the raw bytes only
  // if the handler used the raw body — which is what we want to assert.
  const rawBody = `{\n  "scan_id": "${seeded.scanId}",\n  "status": "done",\n  "failure_reason": null,\n  "usage": null,\n  "findings": []\n}`;
  const signature = sign(rawBody, seeded.signKey);

  const res = await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": seeded.scanId,
      "X-Tensol-Signature": signature,
    },
    body: rawBody,
  });
  expect(res.status).toBe(200);
  const respBody = (await res.json()) as { ok: boolean };
  expect(respBody.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 9 — Audit chain after mixed (ok + invalid + duplicate) callbacks.
// ---------------------------------------------------------------------------
test("T044: audit chain verifies after mixed ok / invalid / duplicate callbacks", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const seeded = seedRunningScan(db, { now: clock.now() });
  const { app } = buildApp({ db, now: clock.now });

  // 1. Bad signature attempt → audit row.
  const badBody = makeCallbackBody({ scanId: seeded.scanId, status: "done" });
  await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": seeded.scanId,
      "X-Tensol-Signature": sign(badBody, "wrong-key"),
    },
    body: badBody,
  });

  // 2. Good callback → completion audit.
  const okBody = makeCallbackBody({
    scanId: seeded.scanId,
    status: "done",
    findings: [
      {
        severity: "info",
        title: "Robots.txt present",
        body_md: "Common file disclosed.",
      },
    ],
  });
  await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": seeded.scanId,
      "X-Tensol-Signature": sign(okBody, seeded.signKey),
    },
    body: okBody,
  });

  // 3. Duplicate callback → no audit row added.
  await app.request("/webhooks/scan-progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tensol-Scan-Id": seeded.scanId,
      "X-Tensol-Signature": sign(okBody, seeded.signKey),
    },
    body: okBody,
  });

  const chain = verifyChain(db, SIGNING_KEY);
  expect(chain.ok).toBe(true);
});
