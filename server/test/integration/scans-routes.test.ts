/**
 * T072 — Integration tests for `/v1/scans/*` HTTP routes (T071).
 *
 * Contract surface (matches openapi.yaml verbatim):
 *
 *   GET    /v1/scans/:id                          → ScanSummary
 *   GET    /v1/scans/:id/events?since=<ms>        → live event poll
 *   GET    /v1/scans/:id/findings                 → ordered list
 *   GET    /v1/scans/:id/findings/:findingId      → single finding
 *   GET    /v1/scans/:id/report                   → report meta + url
 *   POST   /v1/scans/:id/report/regenerate        → 202, enqueue render_pdf
 *
 * Coverage axes:
 *   - Happy path for every endpoint
 *   - Foreign-user → 404 (Constitution II — no existence leak)
 *   - Polling shape: `since` filter strictly-after, nextSince advances
 *   - Findings ordered by severity DESC then created_at ASC (stable)
 *   - Report status pass-through (ready / pending / failed) + missing → 404
 *   - Regenerate idempotency: 409 when prior render_pdf still pending
 *
 * Ownership is via direct `scans.user_id` (matches schema after migration
 * 0010 — no projects/targets JOIN). The test app mounts auth middleware
 * + the scans subrouter under `/v1/scans` so we drive the full chain.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  users as usersTable,
  sessions as sessionsTable,
  scanOrders as scanOrdersTable,
  scans as scansTable,
  scanEvents as scanEventsTable,
  findings as findingsTable,
  reports as reportsTable,
  jobs as jobsTable,
} from "../../src/db/schema.ts";
import { createScansRouter } from "../../src/routes/scans.ts";
import {
  createRequireAuth,
  type AuthVariables,
} from "../../src/auth/middleware.ts";
import { SESSION_COOKIE_NAME } from "../../src/auth/session.ts";
import { ulid } from "../../src/lib/ids.ts";

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY = "test-scans-routes-signing-key";

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

interface UserSeed {
  readonly userId: string;
  readonly sessionId: string;
  readonly cookie: string;
}

function seedUserAndSession(db: DB, opts?: { email?: string; nowMs?: number }): UserSeed {
  const now = opts?.nowMs ?? 1_700_000_000_000;
  const userId = ulid(now);
  const sessionId = ulid(now + 1);
  db.insert(usersTable)
    .values({
      id: userId,
      email: opts?.email ?? `${userId}@test.local`,
      createdAt: now,
    })
    .run();
  db.insert(sessionsTable)
    .values({
      id: sessionId,
      userId,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    })
    .run();
  return {
    userId,
    sessionId,
    cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
  };
}

interface ScanSeed {
  readonly scanOrderId: string;
  readonly scanId: string;
}

function seedScanOrderAndScan(
  db: DB,
  userId: string,
  opts?: { nowMs?: number; primaryDomain?: string; status?: "running" | "completed" | "failed" },
): ScanSeed {
  const now = opts?.nowMs ?? 1_700_000_100_000;
  const scanOrderId = ulid(now);
  const scanId = ulid(now + 1);
  db.insert(scanOrdersTable)
    .values({
      id: scanOrderId,
      userId,
      status: opts?.status === "running" ? "running" : "completed",
      tier: "quick",
      primaryDomain: opts?.primaryDomain ?? "example.com",
      attackSurfaceJson: JSON.stringify([
        { domain: opts?.primaryDomain ?? "example.com", primary: true, headers: [] },
      ]),
      safetyRps: 50,
      dnsVerifyToken: "tensol-verify-test",
      dnsCheckAttempts: 0,
      vpsProvider: "yandex",
      scanId,
      paymentKind: "free_quick",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(scansTable)
    .values({
      id: scanId,
      userId,
      scanOrderId,
      profile: "standard",
      status: opts?.status ?? "completed",
      failureReason: null,
      startedAt: now,
      completedAt: opts?.status === "running" ? null : now + 60_000,
      usageTokens: 1000,
      usageUsdCents: 50,
    })
    .run();
  return { scanOrderId, scanId };
}

function seedEvents(db: DB, scanId: string, count: number, baseNowMs: number): readonly string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = baseNowMs + i * 1000;
    const id = ulid(at);
    db.insert(scanEventsTable)
      .values({
        id,
        scanId,
        eventType: i === 0 ? "agent_started" : i === count - 1 ? "scan_completed" : "agent_phase_changed",
        payloadJson: JSON.stringify({ step: i }),
        createdAt: at,
      })
      .run();
    ids.push(id);
  }
  return ids;
}

function seedFindings(db: DB, scanId: string, count: number, baseNowMs: number): readonly string[] {
  const severities: Array<"critical" | "high" | "medium" | "low" | "informational"> = [
    "critical", "high", "high", "medium", "medium", "medium", "low", "low", "informational",
  ];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = baseNowMs + i * 100;
    const id = ulid(at);
    db.insert(findingsTable)
      .values({
        id,
        scanId,
        externalId: `ext-${i}`,
        severity: severities[i % severities.length] ?? "informational",
        title: `Finding ${i}`,
        target: `https://example.com/path${i}`,
        cvssScore: null,
        cvssVector: null,
        cvssVersion: null,
        cweJson: JSON.stringify([`CWE-${i + 1}`]),
        mitreJson: JSON.stringify([]),
        confidence: "high",
        phase: "recon",
        agent: "decepticon",
        bodyMd: `# Finding ${i}\n\nDetails here.`,
        rawYamlJson: JSON.stringify({ severity: severities[i % severities.length] }),
        evidenceKeysJson: JSON.stringify([`scans/${scanId}/evidence/${i}.txt`]),
        discoveredAt: at,
        createdAt: at,
      })
      .run();
    ids.push(id);
  }
  return ids;
}

function seedReport(
  db: DB,
  scanId: string,
  opts?: { status?: "ready" | "pending" | "failed"; nowMs?: number },
): string {
  const now = opts?.nowMs ?? 1_700_000_300_000;
  const reportId = ulid(now);
  const status = opts?.status ?? "ready";
  db.insert(reportsTable)
    .values({
      id: reportId,
      scanId,
      status,
      bucket: status === "ready" ? "tensol-evidence" : null,
      key: status === "ready" ? `reports/${scanId}.pdf` : null,
      byteSize: status === "ready" ? 12345 : null,
      renderAttempts: status === "ready" ? 1 : 0,
      lastError: status === "failed" ? "render timed out" : null,
      expiresAt: status === "ready" ? now + 30 * 24 * 60 * 60 * 1000 : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return reportId;
}

interface BuildAppOpts {
  readonly db: DB;
  readonly now?: () => number;
}

function buildApp(opts: BuildAppOpts): Hono<{ Variables: AuthVariables }> {
  let counter = 1_700_000_500_000;
  const nowFn = opts.now ?? (() => ++counter);
  const enqueued: Array<{ kind: string; payload: unknown }> = [];
  // We DON'T pass a stub enqueueJob to the scans router — it writes directly
  // to the jobs table inside its own tx (mirrors scan-orders/service.ts).
  const requireAuth = createRequireAuth({ db: opts.db, now: nowFn });
  const router = createScansRouter({
    db: opts.db,
    auditKey: SIGNING_KEY,
    now: nowFn,
    requireAuth,
  });
  const app = new Hono<{ Variables: AuthVariables }>();
  app.route("/v1/scans", router);
  // Expose captured enqueues for assertions (not used currently — kept for
  // potential future cross-checks against the jobs table).
  void enqueued;
  return app;
}

const NONEXISTENT_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

// ---------------------------------------------------------------------------
// AUTH GATE
// ---------------------------------------------------------------------------

describe("scans routes — auth gate", () => {
  test("GET /v1/scans/:id without cookie → 401", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const res = await app.request(`/v1/scans/${NONEXISTENT_ULID}`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /:id — scan summary
// ---------------------------------------------------------------------------

describe("GET /v1/scans/:id (summary)", () => {
  test("happy path → 200 with Scan shape", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanOrderId, scanId } = seedScanOrderAndScan(db, userId);

    const res = await app.request(`/v1/scans/${scanId}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      user_id: string;
      scan_order_id: string;
      profile: string;
      status: string;
      started_at: number;
    };
    expect(body.id).toBe(scanId);
    expect(body.user_id).toBe(userId);
    expect(body.scan_order_id).toBe(scanOrderId);
    expect(body.profile).toBe("standard");
    expect(body.status).toBe("completed");
    expect(typeof body.started_at).toBe("number");
  });

  test("foreign user → 404 (no existence leak)", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, { email: "them@test.local", nowMs: 1_700_000_100_000 });
    const { scanId } = seedScanOrderAndScan(db, them.userId, { nowMs: 1_700_000_200_000 });

    const res = await app.request(`/v1/scans/${scanId}`, {
      headers: { Cookie: me.cookie },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("nonexistent id → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie } = seedUserAndSession(db);
    const res = await app.request(`/v1/scans/${NONEXISTENT_ULID}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/events — polled events
// ---------------------------------------------------------------------------

describe("GET /v1/scans/:id/events (polled)", () => {
  test("happy path → 200 returns all events (no `since`)", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);
    seedEvents(db, scanId, 5, 1_700_000_200_000);

    const res = await app.request(`/v1/scans/${scanId}/events`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      scan_id: string;
      event_type: string;
      payload: unknown;
      created_at: number;
    }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(5);
    expect(body[0]!.scan_id).toBe(scanId);
    expect(body[0]!.event_type).toBe("agent_started");
    expect(body[4]!.event_type).toBe("scan_completed");
    // payload must be parsed JSON, not a string
    expect((body[0]!.payload as { step: number }).step).toBe(0);
  });

  test("`since` filter returns strictly-after events", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);
    const baseMs = 1_700_000_200_000;
    seedEvents(db, scanId, 5, baseMs);
    // events at baseMs, baseMs+1000, baseMs+2000, baseMs+3000, baseMs+4000
    // since=baseMs+2000 → should return events at baseMs+3000 and baseMs+4000
    const since = baseMs + 2000;
    const res = await app.request(`/v1/scans/${scanId}/events?since=${since}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ created_at: number }>;
    expect(body.length).toBe(2);
    expect(body[0]!.created_at).toBeGreaterThan(since);
    expect(body[1]!.created_at).toBeGreaterThan(since);
  });

  test("foreign user → 404 on events", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, { email: "them@test.local", nowMs: 1_700_000_100_000 });
    const { scanId } = seedScanOrderAndScan(db, them.userId, { nowMs: 1_700_000_200_000 });
    seedEvents(db, scanId, 3, 1_700_000_300_000);

    const res = await app.request(`/v1/scans/${scanId}/events`, {
      headers: { Cookie: me.cookie },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/findings — list
// ---------------------------------------------------------------------------

describe("GET /v1/scans/:id/findings (list)", () => {
  test("happy path → 200 returns N findings ordered by severity DESC, created_at ASC", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);
    seedFindings(db, scanId, 9, 1_700_000_200_000);

    const res = await app.request(`/v1/scans/${scanId}/findings`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      severity: string;
      title: string;
      cwe: string[];
      evidence_keys: string[];
    }>;
    expect(body.length).toBe(9);
    // severity DESC order: critical > high > medium > low > informational
    const sevOrder = ["critical", "high", "high", "medium", "medium", "medium", "low", "low", "informational"];
    expect(body.map((f) => f.severity)).toEqual(sevOrder);
    // arrays parsed from JSON, not raw strings
    expect(Array.isArray(body[0]!.cwe)).toBe(true);
    expect(Array.isArray(body[0]!.evidence_keys)).toBe(true);
  });

  test("foreign user → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, { email: "them@test.local", nowMs: 1_700_000_100_000 });
    const { scanId } = seedScanOrderAndScan(db, them.userId, { nowMs: 1_700_000_200_000 });
    seedFindings(db, scanId, 3, 1_700_000_300_000);

    const res = await app.request(`/v1/scans/${scanId}/findings`, {
      headers: { Cookie: me.cookie },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/findings/:findingId — detail
// ---------------------------------------------------------------------------

describe("GET /v1/scans/:id/findings/:findingId (detail)", () => {
  test("happy path → 200 with full body_md + evidence keys", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);
    const findingIds = seedFindings(db, scanId, 3, 1_700_000_200_000);
    const fid = findingIds[1]!;

    const res = await app.request(`/v1/scans/${scanId}/findings/${fid}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      scan_id: string;
      body_md: string;
      evidence_keys: string[];
    };
    expect(body.id).toBe(fid);
    expect(body.scan_id).toBe(scanId);
    expect(body.body_md).toContain("Finding 1");
    expect(body.evidence_keys.length).toBe(1);
  });

  test("foreign user → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, { email: "them@test.local", nowMs: 1_700_000_100_000 });
    const { scanId } = seedScanOrderAndScan(db, them.userId, { nowMs: 1_700_000_200_000 });
    const findingIds = seedFindings(db, scanId, 1, 1_700_000_300_000);
    const fid = findingIds[0]!;

    const res = await app.request(`/v1/scans/${scanId}/findings/${fid}`, {
      headers: { Cookie: me.cookie },
    });
    expect(res.status).toBe(404);
  });

  test("finding belongs to a different scan → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const scanA = seedScanOrderAndScan(db, userId, { nowMs: 1_700_000_200_000, primaryDomain: "a.example" });
    const scanB = seedScanOrderAndScan(db, userId, { nowMs: 1_700_000_400_000, primaryDomain: "b.example" });
    const findingsA = seedFindings(db, scanA.scanId, 1, 1_700_000_500_000);
    const fidA = findingsA[0]!;

    // Request finding from scanA using scanB's id in the path → must 404
    const res = await app.request(`/v1/scans/${scanB.scanId}/findings/${fidA}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/report — report meta
// ---------------------------------------------------------------------------

describe("GET /v1/scans/:id/report (meta)", () => {
  test("ready report → 200 with status=ready + byte_size + download_url", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);
    seedReport(db, scanId, { status: "ready" });

    const res = await app.request(`/v1/scans/${scanId}/report`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      byte_size: number | null;
      download_url: string | null;
      download_expires_at: number | null;
    };
    expect(body.status).toBe("ready");
    expect(body.byte_size).toBe(12345);
    // download_url is a placeholder (presigning is out-of-scope for the
    // route layer); just verify the field is present and non-null when ready.
    expect(typeof body.download_url).toBe("string");
    expect(typeof body.download_expires_at).toBe("number");
  });

  test("pending report → 200 with status=pending + null url", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);
    seedReport(db, scanId, { status: "pending" });

    const res = await app.request(`/v1/scans/${scanId}/report`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; download_url: string | null };
    expect(body.status).toBe("pending");
    expect(body.download_url).toBeNull();
  });

  test("no report row → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);

    const res = await app.request(`/v1/scans/${scanId}/report`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });

  test("foreign user → 404", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, { email: "them@test.local", nowMs: 1_700_000_100_000 });
    const { scanId } = seedScanOrderAndScan(db, them.userId, { nowMs: 1_700_000_200_000 });
    seedReport(db, scanId);

    const res = await app.request(`/v1/scans/${scanId}/report`, {
      headers: { Cookie: me.cookie },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/report/regenerate — enqueue
// ---------------------------------------------------------------------------

describe("POST /v1/scans/:id/report/regenerate", () => {
  test("happy path → 202 + enqueues render_pdf job", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);
    seedReport(db, scanId, { status: "ready" });

    const res = await app.request(`/v1/scans/${scanId}/report/regenerate`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(202);

    const enqueued = db
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.type, "render_pdf"), eq(jobsTable.status, "pending")))
      .all();
    expect(enqueued.length).toBe(1);
    const payload = JSON.parse(enqueued[0]!.payloadJson) as {
      type: string;
      scanId: string;
      reportId: string;
    };
    expect(payload.type).toBe("render_pdf");
    expect(payload.scanId).toBe(scanId);
    expect(payload.reportId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("409 when prior render_pdf already pending", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);
    seedReport(db, scanId, { status: "failed" });

    // First regenerate succeeds
    const first = await app.request(`/v1/scans/${scanId}/report/regenerate`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(first.status).toBe(202);

    // Second one collides with the still-pending job
    const second = await app.request(`/v1/scans/${scanId}/report/regenerate`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("conflict");
  });

  test("foreign user → 404 on regenerate", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const me = seedUserAndSession(db, { email: "me@test.local" });
    const them = seedUserAndSession(db, { email: "them@test.local", nowMs: 1_700_000_100_000 });
    const { scanId } = seedScanOrderAndScan(db, them.userId, { nowMs: 1_700_000_200_000 });
    seedReport(db, scanId);

    const res = await app.request(`/v1/scans/${scanId}/report/regenerate`, {
      method: "POST",
      headers: { Cookie: me.cookie },
    });
    expect(res.status).toBe(404);
  });

  // T116 — regenerate after expiry. Reports rendered long ago have
  // status='ready' but their `expires_at` is in the past and the storage
  // keys have been swept by the lifecycle policy. Regenerate must still
  // work: it UPSERTs the reports row back to 'pending' and enqueues a
  // fresh render_pdf job. No 409, no impl branch on expiry.
  test("regenerate after report expiry → 202 + status reset to pending", async () => {
    const db = freshMemDb();
    const app = buildApp({ db });
    const { cookie, userId } = seedUserAndSession(db);
    const { scanId } = seedScanOrderAndScan(db, userId);

    // Seed an EXPIRED ready report — bucket/key still set but expires_at
    // in the past, mirroring real-world lifecycle-swept artifacts.
    const reportId = seedReport(db, scanId, { status: "ready" });
    const farPast = 1_500_000_000_000; // ~2017-07-14, well before now
    db.update(reportsTable)
      .set({ expiresAt: farPast })
      .where(eq(reportsTable.id, reportId))
      .run();

    const res = await app.request(`/v1/scans/${scanId}/report/regenerate`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { report_id: string; job_id: string };
    // Existing report row is REUSED — id stays the same, status flips.
    expect(body.report_id).toBe(reportId);

    const after = db
      .select()
      .from(reportsTable)
      .where(eq(reportsTable.id, reportId))
      .get();
    expect(after?.status).toBe("pending");
    expect(after?.lastError).toBeNull();

    const enqueued = db
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.type, "render_pdf"), eq(jobsTable.status, "pending")))
      .all();
    expect(enqueued.length).toBe(1);
    const payload = JSON.parse(enqueued[0]!.payloadJson) as { scanId: string; reportId: string };
    expect(payload.scanId).toBe(scanId);
    expect(payload.reportId).toBe(reportId);
  });
});
