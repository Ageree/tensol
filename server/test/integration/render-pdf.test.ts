/**
 * T061 — Integration test for `render_pdf` job handler (T060).
 *
 * What this pins down (per task brief + research §R7):
 *   1. HAPPY PATH — handler picks up a pending `reports` row, fetches the
 *      scan + findings, calls the injected `renderPdf` (returns a Buffer of
 *      N bytes), uploads that buffer to S3 via the injected `S3Client`,
 *      and UPDATEs the row to `status='ready'` with `bucket`, `key`,
 *      `byte_size`, `expires_at` populated. Emits a signed `pdf_rendered`
 *      audit row.
 *   2. PERMANENT renderPdf FAILURE — `renderPdf` throws `PDFRenderError`
 *      on every attempt → 3 retries exhausted → `reports.status='failed'`,
 *      `pdf_render_failed` audit emitted, `retry_telegram_notification`
 *      operator-alert job enqueued.
 *   3. PERMANENT S3 FAILURE — `renderPdf` succeeds but `S3Client.send`
 *      throws a non-transient error → 3 retries exhausted → same failure
 *      semantics as #2.
 *   4. IDEMPOTENT RE-RUN — when the `reports` row is already
 *      `status='ready'` (a prior invocation succeeded), the second
 *      invocation is a no-op: no `renderPdf` call, no S3 upload, no
 *      duplicate audit row.
 *   5. TRANSIENT RETRY — `renderPdf` throws a TIMEOUT once, then succeeds
 *      on the 2nd attempt → ends with `status='ready'`, exactly one
 *      `pdf_rendered` audit row, exactly one S3 upload.
 *
 * Schema notes:
 *   - All three event names (`pdf_render_requested`, `pdf_rendered`,
 *     `pdf_render_failed`) ARE members of BLACKBOX_AUDIT_EVENTS
 *     (audit/emit.ts:98-101) — no substitution needed.
 *   - Re-run idempotency is detected by checking `reports.status` — a
 *     `ready` row will be skipped (no work to do).
 *
 * Migrations: bundles all migrations via readdirSync().sort().
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  auditLog,
  findings,
  jobs,
  reports,
  scanOrders,
  scans,
  users,
} from "../../src/db/schema.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { PDFRenderError } from "../../src/reports/pdf.ts";
import {
  createRenderPdfHandler,
  type RenderPdfJobPayload,
} from "../../src/jobs/handlers/render-pdf.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

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

const TEST_AUDIT_KEY = "test-audit-signing-key-render-pdf";
const TEST_BUCKET = "tensol-reports-test";

const FIXED_USER_ID = "01H0USER000000000000000RPD";
const FIXED_ORDER_ID = "01H0ORD0000000000000000RPD";
const FIXED_SCAN_ID = "01H0SCAN000000000000000RPD";
const FIXED_REPORT_ID = "01H0REP0000000000000000RPD";
const FIXED_JOB_ID = "01H0JOB0000000000000000RPD";
const FIXED_FINDING_ID = "01H0FND0000000000000000RPD";

const DOMAIN = "example.test";

/**
 * Seed a completed scan with a `reports` row already in `pending` status
 * (created by the scan-completed webhook before render-pdf is enqueued —
 * see contracts/webhook.md). Also seed one finding so the template has
 * non-trivial content.
 */
function seedCompletedScanWithReportPending(db: DB, now: number): void {
  db.insert(users)
    .values({
      id: FIXED_USER_ID,
      email: "u@x.test",
      createdAt: now,
    })
    .run();

  db.insert(scanOrders)
    .values({
      id: FIXED_ORDER_ID,
      userId: FIXED_USER_ID,
      status: "completed",
      tier: "quick",
      primaryDomain: DOMAIN,
      attackSurfaceJson: JSON.stringify([{ hostname: DOMAIN, included: true }]),
      safetyRps: 50,
      dnsVerifyToken: `tensol-verify-${"x".repeat(26)}`,
      dnsVerifiedAt: now,
      dnsCheckAttempts: 1,
      vpsProvider: "yandex",
      paymentKind: "free_quick",
      scanId: FIXED_SCAN_ID,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(scans)
    .values({
      id: FIXED_SCAN_ID,
      userId: FIXED_USER_ID,
      scanOrderId: FIXED_ORDER_ID,
      profile: "recon",
      status: "completed",
      startedAt: now - 60_000,
      completedAt: now,
    })
    .run();

  db.insert(findings)
    .values({
      id: FIXED_FINDING_ID,
      scanId: FIXED_SCAN_ID,
      externalId: "FND-001",
      severity: "high",
      title: "Reflected XSS on /search",
      target: DOMAIN,
      cvssScore: 7.4,
      cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N",
      cvssVersion: "3.1",
      cweJson: JSON.stringify(["CWE-79"]),
      mitreJson: JSON.stringify(["T1059"]),
      confidence: "high",
      phase: "exploit",
      agent: "recon",
      bodyMd: "## Steps\n\n1. Visit `/search?q=<svg/onload=alert(1)>`.\n",
      rawYamlJson: JSON.stringify({ title: "Reflected XSS on /search" }),
      evidenceKeysJson: JSON.stringify([]),
      discoveredAt: now - 30_000,
      createdAt: now - 30_000,
    })
    .run();

  db.insert(reports)
    .values({
      id: FIXED_REPORT_ID,
      scanId: FIXED_SCAN_ID,
      status: "pending",
      renderAttempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(jobs)
    .values({
      id: FIXED_JOB_ID,
      type: "render_pdf",
      payloadJson: JSON.stringify({
        type: "render_pdf",
        scan_id: FIXED_SCAN_ID,
        report_id: FIXED_REPORT_ID,
      }),
      status: "running",
      scheduledAt: now,
      attempts: 1,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const BASE_PAYLOAD: RenderPdfJobPayload = {
  scanId: FIXED_SCAN_ID,
  reportId: FIXED_REPORT_ID,
};

interface S3Capture {
  readonly puts: Array<{
    readonly bucket: string;
    readonly key: string;
    readonly bodySize: number;
  }>;
}

/** Build a fake S3 client that records every PutObject + lets tests fail it. */
function makeFakeS3(opts: {
  failTimes?: number;
  failError?: Error;
  alwaysFail?: boolean;
}): { client: S3Client; capture: S3Capture } {
  const capture: S3Capture = { puts: [] };
  let failsRemaining = opts.failTimes ?? 0;
  const client = {
    async send(command: unknown) {
      if (opts.alwaysFail) {
        throw opts.failError ?? new Error("S3: HTTP 403 forbidden");
      }
      if (failsRemaining > 0) {
        failsRemaining -= 1;
        throw opts.failError ?? new Error("S3: TIMEOUT");
      }
      if (command instanceof PutObjectCommand) {
        const input = (command as PutObjectCommand).input;
        const body = input.Body as Buffer | Uint8Array | undefined;
        capture.puts.push({
          bucket: String(input.Bucket ?? ""),
          key: String(input.Key ?? ""),
          bodySize: body ? (body as Buffer).byteLength : 0,
        });
      }
      return {};
    },
  } as unknown as S3Client;
  return { client, capture };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-render-pdf-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1 — HAPPY PATH
// ───────────────────────────────────────────────────────────────────────────
test("happy path: renderPdf called → S3 PutObject → reports row ready, pdf_rendered audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScanWithReportPending(db, ts);

  const fakePdf = Buffer.from("%PDF-1.4 fake content for testing").subarray(0);
  let renderCalls = 0;
  const renderPdf = async (_html: string) => {
    renderCalls += 1;
    return fakePdf;
  };

  const { client: s3, capture } = makeFakeS3({});

  let clock = ts + 1;
  const handler = createRenderPdfHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    renderPdf,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // renderPdf called exactly once.
  expect(renderCalls).toBe(1);

  // Exactly one S3 PUT.
  expect(capture.puts).toHaveLength(1);
  expect(capture.puts[0]!.bucket).toBe(TEST_BUCKET);
  expect(capture.puts[0]!.key).toContain(FIXED_REPORT_ID);
  expect(capture.puts[0]!.key.endsWith(".pdf")).toBe(true);
  expect(capture.puts[0]!.bodySize).toBe(fakePdf.byteLength);

  // reports row updated to ready.
  const reportRow = db
    .select()
    .from(reports)
    .where(eq(reports.id, FIXED_REPORT_ID))
    .get();
  expect(reportRow!.status).toBe("ready");
  expect(reportRow!.bucket).toBe(TEST_BUCKET);
  expect(reportRow!.key).toBe(capture.puts[0]!.key);
  expect(reportRow!.byteSize).toBe(fakePdf.byteLength);
  expect(reportRow!.expiresAt).not.toBeNull();
  expect(reportRow!.expiresAt!).toBeGreaterThan(ts);
  expect(reportRow!.renderAttempts).toBe(1);

  // pdf_rendered audit emitted.
  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "pdf_rendered"))
    .all();
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0]!.outcome).toBe("success");
  expect(auditRows[0]!.scanId).toBe(FIXED_SCAN_ID);
  const meta = JSON.parse(auditRows[0]!.metadataJson) as Record<
    string,
    unknown
  >;
  expect(meta.report_id).toBe(FIXED_REPORT_ID);
  expect(meta.bucket).toBe(TEST_BUCKET);
  expect(meta.byte_size).toBe(fakePdf.byteLength);

  // Audit chain still valid.
  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2 — PERMANENT renderPdf FAILURE
// ───────────────────────────────────────────────────────────────────────────
test("permanent renderPdf failure: 3 retries exhausted → reports failed, pdf_render_failed audit, telegram alert enqueued", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScanWithReportPending(db, ts);

  let renderCalls = 0;
  const renderPdf = async (_html: string): Promise<Buffer> => {
    renderCalls += 1;
    throw new PDFRenderError("puppeteer launch crashed");
  };

  const { client: s3, capture } = makeFakeS3({});

  let clock = ts + 1;
  const handler = createRenderPdfHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    renderPdf,
    retryBackoffMs: 1,
  });

  // Handler MUST NOT throw — failure is captured internally.
  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // PDFRenderError is treated as transient (retries exhausted) → 3 attempts.
  expect(renderCalls).toBe(3);

  // No S3 uploads.
  expect(capture.puts).toHaveLength(0);

  // reports row failed.
  const reportRow = db
    .select()
    .from(reports)
    .where(eq(reports.id, FIXED_REPORT_ID))
    .get();
  expect(reportRow!.status).toBe("failed");
  expect(reportRow!.bucket).toBeNull();
  expect(reportRow!.key).toBeNull();
  expect(reportRow!.lastError).toContain("puppeteer launch crashed");
  expect(reportRow!.renderAttempts).toBe(3);

  // pdf_render_failed audit emitted.
  const failedAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "pdf_render_failed"))
    .all();
  expect(failedAudits).toHaveLength(1);
  expect(failedAudits[0]!.outcome).toBe("failure");

  // NO pdf_rendered audit on the failure path.
  const successAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "pdf_rendered"))
    .all();
  expect(successAudits).toHaveLength(0);

  // retry_telegram_notification operator-alert job enqueued.
  const telJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.type, "retry_telegram_notification"))
    .all();
  expect(telJobs).toHaveLength(1);
  const telPayload = JSON.parse(telJobs[0]!.payloadJson) as Record<
    string,
    unknown
  >;
  expect(telPayload.kind).toBe("operator_alert_pdf_render_failed");
  expect(telPayload.report_id).toBe(FIXED_REPORT_ID);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3 — PERMANENT S3 FAILURE
// ───────────────────────────────────────────────────────────────────────────
test("permanent S3 failure: 3 retries exhausted → reports failed, pdf_render_failed audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScanWithReportPending(db, ts);

  const fakePdf = Buffer.from("%PDF-1.4 ok");
  let renderCalls = 0;
  const renderPdf = async (_html: string) => {
    renderCalls += 1;
    return fakePdf;
  };

  // S3 always fails with a transient-looking 500 → retries exhausted.
  const { client: s3 } = makeFakeS3({
    alwaysFail: true,
    failError: new Error("S3: HTTP 500 internal server error"),
  });

  let clock = ts + 1;
  const handler = createRenderPdfHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    renderPdf,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // S3 retried up to 3 times → renderPdf called up to 3 times too
  // (since each attempt is render+upload).
  expect(renderCalls).toBe(3);

  // reports row failed.
  const reportRow = db
    .select()
    .from(reports)
    .where(eq(reports.id, FIXED_REPORT_ID))
    .get();
  expect(reportRow!.status).toBe("failed");
  expect(reportRow!.lastError).toContain("500");

  const failedAudits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "pdf_render_failed"))
    .all();
  expect(failedAudits).toHaveLength(1);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4 — IDEMPOTENT RE-RUN
// ───────────────────────────────────────────────────────────────────────────
test("idempotent re-run: reports already ready → no render, no upload, no duplicate audit", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScanWithReportPending(db, ts);

  // Pre-mark report as ready (simulates a prior successful invocation).
  db.update(reports)
    .set({
      status: "ready",
      bucket: TEST_BUCKET,
      key: `reports/${FIXED_REPORT_ID}.pdf`,
      byteSize: 1234,
      expiresAt: ts + 30 * 24 * 60 * 60 * 1000,
      updatedAt: ts,
    })
    .where(eq(reports.id, FIXED_REPORT_ID))
    .run();

  let renderCalls = 0;
  const renderPdf = async (_html: string): Promise<Buffer> => {
    renderCalls += 1;
    return Buffer.from("should not be called");
  };
  const { client: s3, capture } = makeFakeS3({});

  let clock = ts + 1;
  const handler = createRenderPdfHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    renderPdf,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  // No work done.
  expect(renderCalls).toBe(0);
  expect(capture.puts).toHaveLength(0);

  // reports row unchanged.
  const reportRow = db
    .select()
    .from(reports)
    .where(eq(reports.id, FIXED_REPORT_ID))
    .get();
  expect(reportRow!.status).toBe("ready");
  expect(reportRow!.byteSize).toBe(1234);

  // No audit rows at all (no work done).
  const auditRows = db.select().from(auditLog).all();
  expect(auditRows).toHaveLength(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5 — TRANSIENT RETRY (renderPdf throws once, then succeeds)
// ───────────────────────────────────────────────────────────────────────────
test("transient retry: renderPdf throws TIMEOUT once then succeeds → ready, exactly one S3 upload", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const ts = 1_700_000_000_000;
  seedCompletedScanWithReportPending(db, ts);

  const fakePdf = Buffer.from("%PDF-1.4 retry-success");
  let renderCalls = 0;
  const renderPdf = async (_html: string): Promise<Buffer> => {
    renderCalls += 1;
    if (renderCalls === 1) {
      throw new PDFRenderError("PDF render failed: TIMEOUT");
    }
    return fakePdf;
  };

  const { client: s3, capture } = makeFakeS3({});

  let clock = ts + 1;
  const handler = createRenderPdfHandler({
    db,
    s3,
    bucket: TEST_BUCKET,
    auditKey: TEST_AUDIT_KEY,
    now: () => clock++,
    renderPdf,
    retryBackoffMs: 1,
  });

  await handler(FIXED_JOB_ID, BASE_PAYLOAD);

  expect(renderCalls).toBe(2);
  expect(capture.puts).toHaveLength(1);

  const reportRow = db
    .select()
    .from(reports)
    .where(eq(reports.id, FIXED_REPORT_ID))
    .get();
  expect(reportRow!.status).toBe("ready");
  expect(reportRow!.byteSize).toBe(fakePdf.byteLength);
  expect(reportRow!.renderAttempts).toBe(2);

  const auditRows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "pdf_rendered"))
    .all();
  expect(auditRows).toHaveLength(1);

  const chain = verifyChain(db, TEST_AUDIT_KEY);
  expect(chain.ok).toBe(true);
});
