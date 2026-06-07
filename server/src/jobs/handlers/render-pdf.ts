/**
 * T060 — `render_pdf` job handler.
 *
 * Lifecycle (per task brief + research §R7):
 *   1. Idempotency gate: load the `reports` row by id. If status is already
 *      `ready`, no-op return (the runner marks job done so further
 *      invocations move on). This guards re-invocations from multiple paths
 *      (webhook re-delivery, manual retry, watchdog re-enqueue).
 *   2. Load scan + findings via Drizzle. The findings are mapped into the
 *      `ReportTemplateInput` shape consumed by `renderReportHtml` (T051).
 *   3. Retry-on-transient loop, up to MAX_RETRIES attempts, around the
 *      composite step "renderPdf(html) → S3 PutObject". Either failure is
 *      classified the same way: transient (TIMEOUT, 5xx, RATE_LIMIT,
 *      ECONN*, PDFRenderError) triggers backoff + retry; non-transient
 *      breaks out immediately. We re-render on every attempt rather than
 *      caching the buffer because the second failure may be a render
 *      failure too — keeping the loop body simple.
 *   4. On success path: UPDATE the `reports` row to status='ready' with
 *      `bucket`, `key`, `byte_size`, `expires_at` (+30d), `render_attempts`.
 *      Then emit a signed `pdf_rendered` audit row.
 *   5. On permanent failure (or retries exhausted): UPDATE the `reports`
 *      row to status='failed' with `last_error`, emit a signed
 *      `pdf_render_failed` audit row, enqueue a
 *      `retry_telegram_notification` operator-alert job carrying
 *      `kind='operator_alert_pdf_render_failed'`. Same convention as
 *      teardown-scan-vm.ts (T058) and spawn-scan-vm.ts (T056).
 *
 * Why audit is post-commit and not inside `withTx`:
 *   `emitSignedAudit` opens its own `BEGIN IMMEDIATE`. bun:sqlite does not
 *   support nested transactions. Same pattern as the other 002 handlers.
 *   Per Constitution X, audit always emits AFTER the controlling tx
 *   commits.
 *
 * Why all three event names exist:
 *   `pdf_rendered`, `pdf_render_failed`, `pdf_render_requested` are all
 *   members of BLACKBOX_AUDIT_EVENTS (audit/emit.ts:98-101). We use
 *   `pdf_rendered` (success) and `pdf_render_failed` (perm failure)
 *   directly. `pdf_render_requested` belongs to the caller that enqueues
 *   the job (scan-completed webhook), not to this handler.
 *
 * Return value: the handler never throws on permanent provider failure —
 * the failure is captured in the alert job + audit + reports row, and the
 * runner records the handler as done. We DO throw on unexpected internal
 * errors (malformed payload missing reportId, reports row not found) so
 * the runner's retry / permanent-failure logic catches them.
 */
import { eq } from "drizzle-orm";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import type { DB } from "../../db/client.ts";
import { withTx } from "../../db/client.ts";
import {
  findings as findingsTable,
  jobs as jobsTable,
  reports as reportsTable,
  scanOrders,
  scans as scansTable,
} from "../../db/schema.ts";
import { ulid } from "../../lib/ids.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { emitSignedAudit } from "../../audit/emit.ts";
import {
  PDFRenderError,
  renderReport as defaultRenderReport,
} from "../../reports/pdf.ts";
import {
  renderReportHtml as defaultRenderReportHtml,
  type ReportFinding,
  type ReportSeverity,
  type ReportTemplateInput,
} from "../../reports/template.html.ts";

/**
 * Job payload shape — tolerant of both snake_case (DB-emitted) and camelCase
 * (briefs) keys. Mirrors the convention used by the spawn/teardown handlers.
 */
export interface RenderPdfJobPayload {
  readonly scanId: string;
  readonly reportId: string;
}

interface NormalizedPayload {
  readonly scanId: string;
  readonly reportId: string;
}

function normalizePayload(raw: unknown): NormalizedPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("render_pdf: payload is not an object");
  }
  const r = raw as Record<string, unknown>;
  const scanId =
    (typeof r.scanId === "string" && r.scanId) ||
    (typeof r.scan_id === "string" && r.scan_id) ||
    "";
  const reportId =
    (typeof r.reportId === "string" && r.reportId) ||
    (typeof r.report_id === "string" && r.report_id) ||
    "";

  if (!scanId || !reportId) {
    throw new Error(
      `render_pdf: payload missing scanId/reportId (got ${JSON.stringify(raw)})`,
    );
  }
  return { scanId, reportId };
}

export interface RenderPdfHandlerDeps {
  readonly db: DB;
  readonly s3: S3Client;
  /** Object Storage bucket for finished PDFs (e.g. `tensol-reports`). */
  readonly bucket: string;
  /** Key prefix inside the bucket. Defaults to `"reports/"`. */
  readonly keyPrefix?: string;
  /** Audit-log signing key. */
  readonly auditKey: string;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Override the HTML template builder (tests inject a stub). */
  readonly renderHtml?: (input: ReportTemplateInput) => string;
  /** Override the PDF renderer (tests inject a fake that returns a Buffer). */
  readonly renderPdf?: (html: string) => Promise<Buffer>;
  /** Sleep between retry attempts. Tests override to 1ms. */
  readonly retryBackoffMs?: number;
  /** Override the report TTL (ms). Defaults to 30 days. */
  readonly reportTtlMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Heuristic transient-error classifier — superset of the spawn/teardown set
 *  with PDFRenderError treated as transient (per research §R7: PDF render
 *  failures are usually launcher crashes / sandbox timeouts, both retriable). */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /RATE[_ ]?LIMIT/i,
  /TOO[_ ]MANY[_ ]REQUESTS/i,
  /TIMEOUT/i,
  /TIMED[_ ]?OUT/i,
  /UNAVAILABLE/i,
  /TEMPORARILY/i,
  /(^|[^0-9])5\d{2}([^0-9]|$)/, // 5xx in the message
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
];

function isTransient(err: unknown): boolean {
  if (err instanceof PDFRenderError) return true; // research §R7 retry policy
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function severityFromRow(s: string): ReportSeverity {
  // Schema constrains the column to the same five literals.
  return s as ReportSeverity;
}

/** Build a `render_pdf` handler closing over the injected deps. */
export function createRenderPdfHandler(deps: RenderPdfHandlerDeps) {
  const {
    db,
    s3,
    bucket,
    keyPrefix = "reports/",
    auditKey,
    now = defaultNow,
    newId = () => ulid(now()),
    renderHtml = defaultRenderReportHtml,
    renderPdf = defaultRenderReport,
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
    reportTtlMs = DEFAULT_REPORT_TTL_MS,
  } = deps;

  /**
   * @param jobId    The jobs.id from the runner — reserved for tracing.
   * @param rawPayload The parsed JSON from jobs.payload_json.
   */
  return async function handle(
    jobId: string,
    rawPayload: unknown,
  ): Promise<void> {
    void jobId;
    const { scanId, reportId } = normalizePayload(rawPayload);

    // 1. Idempotency gate.
    const existingReport = db
      .select()
      .from(reportsTable)
      .where(eq(reportsTable.id, reportId))
      .get();
    if (!existingReport) {
      throw new Error(`render_pdf: reports row not found (id=${reportId})`);
    }
    if (existingReport.status === "ready") {
      return;
    }

    // 2. Load scan + order + findings.
    const scanRow = db
      .select()
      .from(scansTable)
      .where(eq(scansTable.id, scanId))
      .get();
    if (!scanRow) {
      throw new Error(`render_pdf: scans row not found (id=${scanId})`);
    }
    const orderRow = db
      .select()
      .from(scanOrders)
      .where(eq(scanOrders.id, scanRow.scanOrderId))
      .get();
    if (!orderRow) {
      throw new Error(
        `render_pdf: scan_orders row not found (id=${scanRow.scanOrderId})`,
      );
    }
    const findingRows = db
      .select()
      .from(findingsTable)
      .where(eq(findingsTable.scanId, scanId))
      .all();

    // 3. Build template input and HTML.
    const templateFindings: readonly ReportFinding[] = findingRows.map((f) => ({
      id: f.id,
      externalId: f.externalId,
      title: f.title,
      severity: severityFromRow(f.severity),
      cvssScore: f.cvssScore,
      cvssVector: f.cvssVector,
      cvssVersion: f.cvssVersion,
      cwe: safeParseStringArray(f.cweJson),
      mitre: safeParseStringArray(f.mitreJson),
      confidence: f.confidence,
      affectedTarget: f.target,
      affectedComponent: null,
      phase: f.phase,
      agent: f.agent,
      bodyMd: f.bodyMd,
    }));

    const bySeverity = countBySeverity(templateFindings);
    const completedAt = scanRow.completedAt ?? now();
    const startedAt = scanRow.startedAt;
    const durationSeconds = Math.max(
      0,
      Math.floor((completedAt - startedAt) / 1000),
    );
    const generatedAt = now();
    const templateInput: ReportTemplateInput = {
      scan: {
        id: scanRow.id,
        scanOrderId: scanRow.scanOrderId,
        primaryDomain: orderRow.primaryDomain,
        completedAt,
        durationSeconds,
      },
      findings: templateFindings,
      summary: {
        total: templateFindings.length,
        bySeverity,
      },
      generatedAt,
      reportId,
    };
    const html = renderHtml(templateInput);

    // 4. Retry-on-transient loop around (renderPdf → S3 PutObject).
    const key = `${keyPrefix}${reportId}.pdf`;
    let pdfBytes: Buffer | null = null;
    let lastErr: Error | null = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      attempts = attempt;
      try {
        const buf = await renderPdf(html);
        pdfBytes = buf;
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buf,
            ContentType: "application/pdf",
          }),
        );
        break;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        lastErr = e;
        pdfBytes = null;
        if (!isTransient(e)) {
          break; // permanent — no further retries
        }
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(retryBackoffMs);
        }
      }
    }

    // 5. Persist outcome + emit audit.
    if (pdfBytes !== null) {
      const ts = now();
      const expiresAt = ts + reportTtlMs;
      const byteSize = pdfBytes.byteLength;

      await withTx(db, async (tx) => {
        tx.update(reportsTable)
          .set({
            status: "ready",
            bucket,
            key,
            byteSize,
            renderAttempts: attempts,
            lastError: null,
            expiresAt,
            updatedAt: ts,
          })
          .where(eq(reportsTable.id, reportId))
          .run();
      });

      await emitSignedAudit(
        db,
        {
          event: "pdf_rendered",
          outcome: "success",
          ts,
          user_id: scanRow.userId,
          scan_id: scanId,
          metadata: {
            report_id: reportId,
            bucket,
            key,
            byte_size: byteSize,
            attempts,
          },
        },
        { key: auditKey },
      );
      return;
    }

    // 5b. Permanent failure.
    await markFailure({
      db,
      scanId,
      userId: scanRow.userId,
      reportId,
      attempts,
      error: lastErr ?? new Error("render_pdf: unknown failure"),
      auditKey,
      now,
      newId,
    });
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function safeParseStringArray(jsonText: string): readonly string[] {
  try {
    const v = JSON.parse(jsonText);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

function countBySeverity(
  findings: readonly ReportFinding[],
): ReportTemplateInput["summary"]["bySeverity"] {
  const acc = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  for (const f of findings) {
    if (f.severity in acc) {
      (acc as Record<ReportSeverity, number>)[f.severity] += 1;
    }
  }
  return acc;
}

interface MarkFailureArgs {
  readonly db: DB;
  readonly scanId: string;
  readonly userId: string;
  readonly reportId: string;
  readonly attempts: number;
  readonly error: Error;
  readonly auditKey: string;
  readonly now: () => number;
  readonly newId: () => string;
}

async function markFailure(args: MarkFailureArgs): Promise<void> {
  const {
    db,
    scanId,
    userId,
    reportId,
    attempts,
    error,
    auditKey,
    now,
    newId,
  } = args;

  const ts = now();
  const telegramJobId = newId();
  const telegramPayload = JSON.stringify({
    type: "retry_telegram_notification",
    kind: "operator_alert_pdf_render_failed",
    scan_id: scanId,
    report_id: reportId,
    attempts,
    error: error.message,
  });

  // 1. Persist failure + enqueue operator alert in one tx.
  await withTx(db, async (tx) => {
    tx.update(reportsTable)
      .set({
        status: "failed",
        renderAttempts: attempts,
        lastError: error.message,
        updatedAt: ts,
      })
      .where(eq(reportsTable.id, reportId))
      .run();

    tx.insert(jobsTable)
      .values({
        id: telegramJobId,
        type: "retry_telegram_notification",
        payloadJson: telegramPayload,
        status: "pending",
        scheduledAt: ts,
        attempts: 0,
        lastError: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  });

  // 2. Post-commit audit (Constitution X).
  await emitSignedAudit(
    db,
    {
      event: "pdf_render_failed",
      outcome: "failure",
      ts,
      user_id: userId,
      scan_id: scanId,
      metadata: {
        report_id: reportId,
        attempts,
        error: error.message,
      },
    },
    { key: auditKey },
  );
}
