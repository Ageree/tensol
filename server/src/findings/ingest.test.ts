/**
 * T049 — findings ingest tests (Juice Shop fixture).
 *
 * Feeds the 9-finding fixture captured during the 2026-05-19 OAuth
 * local-smoke run (`.harness/goals/decepticon-oauth-local-smoke/`)
 * through the T048 ingest. Pins three guarantees:
 *
 *   1. All 9 fixture findings persist to the `findings` table with
 *      the right severity / CVSS / CWE / MITRE / confidence columns.
 *   2. The audit chain extends by exactly 9 `finding_ingested` rows
 *      AND remains hash-chain-valid after the batch.
 *   3. The ingest layer is intentionally non-idempotent — replaying
 *      the same fixture twice doubles row counts (route-handler dedup
 *      is a future concern).
 *
 * Setup mirrors `server/src/audit/emit.test.ts`:
 *   - in-process `:memory:` DB via `createDb`
 *   - migrations applied via the bundled `.sql` files
 *   - parent FK rows (users / scan_orders / scans) inserted manually so
 *     the FK chain `findings.scan_id → scans.id` resolves
 */
import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import { auditLog, findings, scans, scanOrders, users } from "../db/schema.ts";
import { verifyChain } from "../audit/verify-chain.ts";
import {
  WebhookScanCompleteBodySchema,
  type WebhookScanCompleteBody,
} from "../schemas/webhook-scan-complete.ts";
import { createFindingsIngest } from "./ingest.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "test",
  "fixtures",
  "webhook-scan-complete-juiceshop.json",
);

const AUDIT_KEY = "test-key-findings-ingest";

// 26-char Crockford ULIDs (alphabet excludes I, L, O, U).
const USER_ID = "01JTSTSR000000000000000001";
const SCAN_ID = "01JTSTSCN00000000000000001";
const TARGET = "juiceshop.local";

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
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

function loadFixture(): WebhookScanCompleteBody {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown;
  return WebhookScanCompleteBodySchema.parse(raw);
}

function seedParents(db: DB, payload: WebhookScanCompleteBody): void {
  const ts = 1716114000000;

  db.insert(users)
    .values({
      id: USER_ID,
      email: "ingest-test@tensol.invalid",
      createdAt: ts,
    })
    .run();

  db.insert(scanOrders)
    .values({
      id: payload.scan_order_id,
      userId: USER_ID,
      status: "completed",
      tier: "quick",
      primaryDomain: TARGET,
      attackSurfaceJson: "[]",
      safetyRps: 50,
      dnsVerifyToken: "test-dns-token",
      vpsProvider: "gcp",
      paymentKind: "free_quick",
      createdAt: ts - 3600_000,
      updatedAt: ts,
    })
    .run();

  db.insert(scans)
    .values({
      id: SCAN_ID,
      userId: USER_ID,
      scanOrderId: payload.scan_order_id,
      profile: "max",
      status: "completed",
      startedAt: ts - 2280_000,
      completedAt: ts,
    })
    .run();
}

let db: DB;
let payload: WebhookScanCompleteBody;

beforeEach(() => {
  db = createDb(":memory:");
  applyMigrations(db);
  payload = loadFixture();
  seedParents(db, payload);
});

// ---------------------------------------------------------------------------
// Test 1 — all 9 findings ingest with correct severity histogram and
// audit chain extends by exactly 9 verifiable rows.
// ---------------------------------------------------------------------------
test("ingests all 9 Juice Shop findings + extends audit chain by 9 (chain stays valid)", async () => {
  const ingest = createFindingsIngest({ db, auditKey: AUDIT_KEY });

  // Baseline: audit_log is empty (we did not emit during seedParents).
  const baseline = (
    db.$client as Database
  )
    .query("SELECT COUNT(*) AS n FROM audit_log")
    .get() as { n: number };
  expect(baseline.n).toBe(0);

  const inserted = [];
  for (const f of payload.findings) {
    inserted.push(
      await ingest.insertFinding({
        scanId: SCAN_ID,
        target: TARGET,
        finding: f,
      }),
    );
  }
  expect(inserted).toHaveLength(9);

  // Row count.
  const findingRows = db
    .select({ severity: findings.severity })
    .from(findings)
    .all();
  expect(findingRows).toHaveLength(9);

  // Severity histogram per the 2026-05-19 OAuth local-smoke run:
  // 3 CRIT + 4 HIGH + 2 MED.
  const hist = findingRows.reduce(
    (acc, r) => {
      acc[r.severity] = (acc[r.severity] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  expect(hist).toEqual({ critical: 3, high: 4, medium: 2 });

  // Audit chain extended by exactly 9 finding_ingested rows.
  const auditRows = (
    db.$client as Database
  )
    .query(
      "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'finding_ingested'",
    )
    .get() as { n: number };
  expect(auditRows.n).toBe(9);

  // And the chain still verifies cleanly.
  const res = verifyChain(db, AUDIT_KEY);
  expect(res.ok).toBe(true);
  expect(res.rows).toBe(9);
  expect(res.brokenAt).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Test 2 — spot-check CVSS / CWE / MITRE / confidence on a known finding
// (FIND-001, the SQLi auth-bypass).
// ---------------------------------------------------------------------------
test("FIND-001 (SQLi auth bypass) lands with full CVSS/CWE/MITRE/confidence/phase/agent", async () => {
  const ingest = createFindingsIngest({ db, auditKey: AUDIT_KEY });

  for (const f of payload.findings) {
    await ingest.insertFinding({ scanId: SCAN_ID, target: TARGET, finding: f });
  }

  const row = db
    .select()
    .from(findings)
    .where(eq(findings.externalId, "FIND-001"))
    .get();
  expect(row).toBeDefined();
  expect(row!.severity).toBe("critical");
  expect(row!.cvssScore).toBe(9.3);
  expect(row!.cvssVersion).toBe("4.0");
  expect(row!.cvssVector).toMatch(/^CVSS:4\.0\//);
  expect(JSON.parse(row!.cweJson)).toEqual(["CWE-89"]);
  expect(JSON.parse(row!.mitreJson)).toEqual(["T1190", "T1078"]);
  expect(row!.confidence).toBe("verified");
  expect(row!.phase).toBe("exploit");
  expect(row!.agent).toBe("exploit");
  expect(row!.target).toBe(TARGET);
  expect(row!.bodyMd.length).toBeGreaterThan(100);

  // raw_yaml_json round-trips the full normalised frontmatter including
  // unknown keys (data-model E5 forward-compat guarantee).
  const fm = JSON.parse(row!.rawYamlJson);
  expect(fm.id).toBe("FIND-001");
  expect(fm.severity).toBe("critical");
  // The H1 fallback supplied a title since FIND-001 frontmatter has no
  // explicit `title:` key.
  expect(typeof fm.title).toBe("string");
  expect(fm.title.length).toBeGreaterThan(0);

  // discovered_at coerced from ISO-8601 string to unix ms.
  expect(row!.discoveredAt).toBe(Date.parse("2026-05-19T08:41:30Z"));
});

// ---------------------------------------------------------------------------
// Test 3 — ingest layer is intentionally NOT idempotent (route handler
// dedup is a separate concern).
// ---------------------------------------------------------------------------
test("re-ingesting the same fixture twice doubles row counts (no implicit dedup)", async () => {
  const ingest = createFindingsIngest({ db, auditKey: AUDIT_KEY });

  for (const f of payload.findings) {
    await ingest.insertFinding({ scanId: SCAN_ID, target: TARGET, finding: f });
  }
  for (const f of payload.findings) {
    await ingest.insertFinding({ scanId: SCAN_ID, target: TARGET, finding: f });
  }

  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(findings)
    .get();
  expect(total!.n).toBe(18);

  const auditRows = (
    db.$client as Database
  )
    .query(
      "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'finding_ingested'",
    )
    .get() as { n: number };
  expect(auditRows.n).toBe(18);

  const res = verifyChain(db, AUDIT_KEY);
  expect(res.ok).toBe(true);
  expect(res.rows).toBe(18);
});

// ---------------------------------------------------------------------------
// Test 4 — `parseYamlFrontmatter` helper round-trips a real fixture file.
// Confirms the helper exposed for non-webhook (CLI replay) callers works.
// ---------------------------------------------------------------------------
describe("parseYamlFrontmatter helper", () => {
  test.skipIf(!existsSync(join(import.meta.dir, "..", "..", "..", ".harness", "goals", "decepticon-oauth-local-smoke", "evidence", "E-juiceshop-findings", "FIND-002-sqli-union-products-search.md")))("parses a real FIND-002 markdown file end-to-end", async () => {
    const path = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      ".harness",
      "goals",
      "decepticon-oauth-local-smoke",
      "evidence",
      "E-juiceshop-findings",
      "FIND-002-sqli-union-products-search.md",
    );
    const md = readFileSync(path, "utf8");
    const { parseYamlFrontmatter } = await import("./ingest.ts");
    const { fm, body } = parseYamlFrontmatter(md);
    expect(fm.id).toBe("FIND-002");
    expect(fm.severity).toBe("critical");
    expect(fm.title).toMatch(/SQL Injection/i);
    expect(body).toMatch(/Description/);
  });
});
