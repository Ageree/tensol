/**
 * Regression test for `POST /api/webhooks/scan-progress` accepting the
 * vps-agent's diagnostic-finding payload (5 entries with severity=`info`,
 * `body_md` = ~64KiB log dump, evidence omitted).
 *
 * Backstory: the V1 webhook handler `routes/webhooks.ts` + the legacy
 * `findings/service.ts` were written against the 001-backend-v2 8-column
 * `findings` table. Migration 0010 dropped that stub and re-created the
 * table with the full E5 18-column shape (NOT NULL external_id, target,
 * raw_yaml_json; CHECK severity IN ('critical','high','medium','low',
 * 'informational') — note `informational`, not `info`).
 *
 * The agent kept calling the V1 endpoint (see `spawn-yandex-vm.ts` line
 * 426 — `${backendUrl}/api/webhooks/scan-progress`) and every callback
 * 500'd because:
 *   1. `storeFindings` inserted into columns `dedup_key` and
 *      `evidence_json` that no longer exist.
 *   2. NOT NULL `external_id`, `target`, `raw_yaml_json` were never set.
 *   3. Severity `info` violated the new CHECK constraint.
 *
 * This test wires up a fresh in-memory DB with ALL migrations applied,
 * seeds a running scan + vps_instance with a known sign_key, then POSTs
 * the exact payload shape vps-agent's `dumpComposeLogs` produces (5 diag
 * findings + valid HMAC). Expects 200 + `inserted: 5`.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  users as usersTable,
  scanOrders as scanOrdersTable,
  scans as scansTable,
  vpsInstances as vpsInstancesTable,
  findings as findingsTable,
  jobs as jobsTable,
} from "../../src/db/schema.ts";
import { createWebhookRoutes } from "../../src/routes/webhooks.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY = "test-audit-signing-key-for-v1-webhook-it-tests";
const VPS_SIGN_KEY = "test-vps-sign-key-shared-with-fake-vps-agent";

// All IDs are 26 chars of Crockford-32 (no I/L/O/U).
const SCAN_ID = "01JTESTSCANV100000000000DZ";
const SCAN_ORDER_ID = "01JTESTRDERV100000000000Z2";
const VPS_INSTANCE_ID = "01JTESTVPSV100000000000000";
const USER_ID = "01JTESTSERV100000000000ZZ3";

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

function seedRunningScan(db: DB, nowMs: number): void {
  db.insert(usersTable)
    .values({ id: USER_ID, email: `${USER_ID}@test.local`, createdAt: nowMs })
    .run();

  db.insert(scanOrdersTable)
    .values({
      id: SCAN_ORDER_ID,
      userId: USER_ID,
      status: "running",
      tier: "quick",
      primaryDomain: "example.com",
      attackSurfaceJson: "[]",
      safetyRps: 50,
      dnsVerifyToken: "dns-token-stub",
      dnsCheckAttempts: 0,
      vpsProvider: "yandex",
      paymentKind: "free_quick",
      scanId: SCAN_ID,
      createdAt: nowMs,
      updatedAt: nowMs,
    })
    .run();

  db.insert(scansTable)
    .values({
      id: SCAN_ID,
      userId: USER_ID,
      scanOrderId: SCAN_ORDER_ID,
      profile: "recon",
      status: "running",
      failureReason: null,
      startedAt: nowMs,
      completedAt: null,
      usageTokens: null,
      usageUsdCents: null,
    })
    .run();

  db.insert(vpsInstancesTable)
    .values({
      id: VPS_INSTANCE_ID,
      scanId: SCAN_ID,
      provider: "yandex",
      providerServerId: "fhm0test0000000000000",
      ipv4: "203.0.113.42",
      status: "alive",
      signKey: VPS_SIGN_KEY,
      createdAt: nowMs,
      destroyedAt: null,
    })
    .run();
}

function buildApp(db: DB, nowMs: number): Hono {
  const app = new Hono();
  app.route(
    "/api/webhooks",
    createWebhookRoutes({ db, signingKey: SIGNING_KEY, now: () => nowMs }),
  );
  return app;
}

/** Mirror what vps-agent does: raw body + HMAC over the exact bytes. */
function signed(body: string): { sig: string } {
  const sig = createHmac("sha256", VPS_SIGN_KEY).update(body).digest("hex");
  return { sig };
}

/** Build a single diag finding the way `dumpComposeLogs.renderLogAsMarkdown`
 *  + `findings-collector.parseOne` would shape it after collection. */
function diagFinding(container: string, body: string) {
  return {
    severity: "info" as const,
    title: `Container log: ${container}`,
    body_md: ["```", body, "```"].join("\n"),
    // Diag findings have no evidence object.
  };
}

describe("V1 webhook /api/webhooks/scan-progress — diag-finding payload", () => {
  test("5 info-severity diag findings → 200 + inserted=5", async () => {
    const now = 1_716_400_000_000;
    const db = freshMemDb();
    seedRunningScan(db, now);
    const app = buildApp(db, now);

    // Build the agent payload exactly as `dumpComposeLogs` would: 5 diag
    // findings, each carrying a moderately large fenced log body so we
    // exercise the body_md path (the prod regression's 500 fired with
    // logs near 64KiB; we use ~5KiB per finding to keep the test fast
    // while still being non-trivial).
    const logSnippet = "x".repeat(5_000);
    const findings = [
      diagFinding("tensol-litellm-1", logSnippet),
      diagFinding("tensol-langgraph-1", logSnippet),
      diagFinding("tensol-sandbox-1", logSnippet),
      diagFinding("tensol-postgres-1", logSnippet),
      diagFinding("tensol-neo4j-1", logSnippet),
    ];

    const body = JSON.stringify({
      scan_id: SCAN_ID,
      status: "failed",
      failure_reason: "decepticon_crash",
      usage: null,
      findings,
    });
    const { sig } = signed(body);

    const res = await app.fetch(
      new Request("http://test/api/webhooks/scan-progress", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tensol-Scan-Id": SCAN_ID,
          "X-Tensol-Signature": sig,
        },
        body,
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      inserted: number;
      skipped: number;
    };
    expect(json.ok).toBe(true);
    expect(json.inserted).toBe(5);
    expect(json.skipped).toBe(0);

    // Persisted rows: all five with severity=`informational` (DB enum).
    const rows = db
      .select()
      .from(findingsTable)
      .where(eq(findingsTable.scanId, SCAN_ID))
      .all();
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.severity).toBe("informational");
      expect(r.target).toBe("example.com");
      // NOT NULL columns must be populated
      expect(r.externalId.length).toBeGreaterThan(0);
      expect(r.rawYamlJson.length).toBeGreaterThan(0);
      expect(r.cweJson).toBe("[]");
      expect(r.mitreJson).toBe("[]");
      expect(r.evidenceKeysJson).toBe("[]");
    }

    // Scan + teardown job: scan flipped to `failed`, one teardown_vps
    // job queued.
    const scan = db
      .select()
      .from(scansTable)
      .where(eq(scansTable.id, SCAN_ID))
      .get();
    expect(scan?.status).toBe("failed");
    expect(scan?.failureReason).toBe("decepticon_crash");

    const jobs = db.select().from(jobsTable).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe("teardown_vps");
  });

  test("regular Decepticon findings (severity=critical/high) still work", async () => {
    const now = 1_716_400_000_001;
    const db = freshMemDb();
    seedRunningScan(db, now);
    const app = buildApp(db, now);

    const body = JSON.stringify({
      scan_id: SCAN_ID,
      status: "done",
      failure_reason: null,
      usage: { tokens: 12345, usd_cents: 50 },
      findings: [
        {
          severity: "critical",
          title: "SQL injection in /login",
          body_md: "Found auth bypass via `' OR '1'='1'-- `",
          evidence: {
            request: "POST /login HTTP/1.1\nuser=admin' OR 1=1--",
            response: "HTTP/1.1 200 OK\nSet-Cookie: session=admin",
          },
        },
        {
          severity: "high",
          title: "Stored XSS in profile bio",
          body_md: "Bio field renders `<script>` unescaped.",
        },
      ],
    });
    const { sig } = signed(body);

    const res = await app.fetch(
      new Request("http://test/api/webhooks/scan-progress", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tensol-Scan-Id": SCAN_ID,
          "X-Tensol-Signature": sig,
        },
        body,
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { inserted: number; skipped: number };
    expect(json.inserted).toBe(2);

    const rows = db
      .select()
      .from(findingsTable)
      .where(eq(findingsTable.scanId, SCAN_ID))
      .all();
    expect(rows).toHaveLength(2);
    const severities = rows.map((r) => r.severity).sort();
    expect(severities).toEqual(["critical", "high"]);

    // Evidence keys captured for the SQLi finding.
    const sqli = rows.find((r) => r.title.startsWith("SQL"))!;
    expect(sqli.evidenceKeysJson).toBe('["request","response"]');
  });

  test("duplicate (same title) is skipped on retry — idempotent", async () => {
    const now = 1_716_400_000_002;
    const db = freshMemDb();
    seedRunningScan(db, now);
    const app = buildApp(db, now);

    const findings = [
      {
        severity: "info" as const,
        title: "Container log: tensol-litellm-1",
        body_md: "log body",
      },
    ];
    const body = JSON.stringify({
      scan_id: SCAN_ID,
      status: "failed",
      failure_reason: "decepticon_crash",
      usage: null,
      findings,
    });
    const { sig } = signed(body);

    // First delivery — full path.
    const first = await app.fetch(
      new Request("http://test/api/webhooks/scan-progress", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tensol-Scan-Id": SCAN_ID,
          "X-Tensol-Signature": sig,
        },
        body,
      }),
    );
    expect(first.status).toBe(200);

    // Re-mark scan as `running` so the retry isn't short-circuited by
    // the route's terminal-status idempotency guard (which fires
    // BEFORE storeFindings). We want to exercise the per-finding dedup.
    db.update(scansTable)
      .set({ status: "running", completedAt: null, failureReason: null })
      .where(eq(scansTable.id, SCAN_ID))
      .run();

    const second = await app.fetch(
      new Request("http://test/api/webhooks/scan-progress", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tensol-Scan-Id": SCAN_ID,
          "X-Tensol-Signature": sig,
        },
        body,
      }),
    );
    expect(second.status).toBe(200);
    const json = (await second.json()) as { inserted: number; skipped: number };
    expect(json.inserted).toBe(0);
    expect(json.skipped).toBe(1);

    // Still only one finding row total.
    const rows = db
      .select()
      .from(findingsTable)
      .where(eq(findingsTable.scanId, SCAN_ID))
      .all();
    expect(rows).toHaveLength(1);
  });
});
