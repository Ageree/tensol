/**
 * T071 — `/v1/scans/*` simplified read API (US1).
 *
 * Replaces the legacy 001 scans routes that depended on
 * `projects`/`targets` tables (dropped in migration 0010). The new surface
 * is owner-scoped via direct `scans.user_id` (denormalised at scan-order
 * launch time) — no JOIN required.
 *
 * Public surface (mounted under `/v1/scans` from `server.ts`):
 *
 *   GET    /:id                          → ScanSummary (Live + Findings)
 *   GET    /:id/events?since=<ms>        → polled event stream (Constitution V)
 *   GET    /:id/findings                 → list, severity DESC, created_at ASC
 *   GET    /:id/findings/:findingId      → single finding
 *   GET    /:id/report                   → report meta + placeholder url
 *   POST   /:id/report/regenerate        → enqueues render_pdf, 202
 *
 * Ownership semantics (Constitution II):
 *   Every endpoint resolves the scan + its scan_order and confirms
 *   `scans.user_id === c.var.userId`. A foreign user (or unknown id)
 *   gets HTTP 404 `{error:"not_found"}` — never 403 (hides existence).
 *
 * Polling (Constitution V):
 *   `/events?since=<unix-ms>` returns events with `created_at > since`
 *   (strictly after). When `since` is absent we return ALL events for
 *   the scan. The contract returns an array — clients track the last
 *   `created_at` they saw and pass it as `since` on the next tick.
 *
 * Regenerate idempotency:
 *   We refuse a new render_pdf enqueue when there is ALREADY a pending or
 *   running `render_pdf` job whose payload references this scan. The
 *   refusal returns 409 `{error:"conflict"}`. This guards against
 *   double-clicks + concurrent polls.
 *
 * Why we inline queries here (no `scans/service.ts`):
 *   These endpoints are simple owner-scoped reads. A service layer like
 *   `scan-orders/service.ts` exists because that surface mutates state
 *   across N tables in a deterministic state machine; the scans READ
 *   surface has no such complexity. Inlining keeps the file ≤ 800 LOC
 *   (Constitution VII) and avoids inventing a thin pass-through layer.
 *
 * Audit emission:
 *   Only `POST /report/regenerate` is a state change. It emits
 *   `pdf_render_requested` AFTER the jobs+reports rows commit and
 *   BEFORE the 202 response (per Constitution X: audit always trails
 *   the controlling tx).
 */
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";

import type { AuthVariables } from "../auth/middleware.ts";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  findings as findingsTable,
  jobs as jobsTable,
  reports as reportsTable,
  scanOrders as scanOrdersTable,
  scans as scansTable,
  scanEvents as scanEventsTable,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import type { RenderPdfJob } from "../jobs/types.ts";

/** DI surface — server.ts wires concrete instances; tests inject stubs. */
export interface CreateScansRouterDeps {
  readonly db: DB;
  readonly auditKey: string;
  readonly requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>;
  readonly now?: () => number;
}

/** Error envelope mirrors `routes/scan-orders.ts` for consistency. */
interface ErrorEnvelope {
  readonly error: string;
  readonly message: string;
}

const NOT_FOUND: ErrorEnvelope = {
  error: "not_found",
  message: "resource not found",
};

const CONFLICT_PENDING_RENDER: ErrorEnvelope = {
  error: "conflict",
  message: "a render_pdf job is already pending for this scan",
};

/** Severity ranking — DESC means critical first. SQLite text ordering does
 *  NOT match this rank, so we sort in-memory after the SELECT. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

function parseJsonArray(s: string): readonly string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as readonly string[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(s: string | null): Record<string, unknown> | null {
  if (s === null || s === "") return null;
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Convert a `findings` row to its openapi `Finding` envelope. */
function rowToFinding(row: typeof findingsTable.$inferSelect): {
  id: string;
  scan_id: string;
  external_id: string;
  severity: string;
  title: string;
  target: string;
  cvss_score: number | null;
  cvss_vector: string | null;
  cvss_version: string | null;
  cwe: readonly string[];
  mitre: readonly string[];
  confidence: string | null;
  phase: string | null;
  agent: string | null;
  body_md: string;
  evidence_keys: readonly string[];
  discovered_at: number | null;
  created_at: number;
} {
  return {
    id: row.id,
    scan_id: row.scanId,
    external_id: row.externalId,
    severity: row.severity,
    title: row.title,
    target: row.target,
    cvss_score: row.cvssScore,
    cvss_vector: row.cvssVector,
    cvss_version: row.cvssVersion,
    cwe: parseJsonArray(row.cweJson),
    mitre: parseJsonArray(row.mitreJson),
    confidence: row.confidence,
    phase: row.phase,
    agent: row.agent,
    body_md: row.bodyMd,
    evidence_keys: parseJsonArray(row.evidenceKeysJson),
    discovered_at: row.discoveredAt,
    created_at: row.createdAt,
  };
}

/**
 * Build the scans subrouter. Mount at `/v1/scans` in server.ts.
 */
export function createScansRouter(
  deps: CreateScansRouterDeps,
): Hono<{ Variables: AuthVariables }> {
  const { db, auditKey, requireAuth } = deps;
  const clock = deps.now ?? defaultNow;

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth);

  /**
   * Owner-gate helper. Returns the scan row when the caller owns it,
   * `null` otherwise. Centralises the "load + verify ownership" rule
   * used by every endpoint in this file.
   */
  function loadOwnedScan(
    scanId: string,
    userId: string,
  ): typeof scansTable.$inferSelect | null {
    const row = db
      .select()
      .from(scansTable)
      .where(eq(scansTable.id, scanId))
      .get();
    if (!row) return null;
    if (row.userId !== userId) return null;
    return row;
  }

  // -------------------------------------------------------------------------
  // GET /:id — scan summary
  // -------------------------------------------------------------------------
  app.get("/:id", (c) => {
    const user = c.get("user");
    const scanId = c.req.param("id");
    const scan = loadOwnedScan(scanId, user.id);
    if (!scan) return c.json(NOT_FOUND, 404);

    return c.json(
      {
        id: scan.id,
        user_id: scan.userId,
        scan_order_id: scan.scanOrderId,
        profile: scan.profile,
        status: scan.status,
        failure_reason: scan.failureReason,
        started_at: scan.startedAt,
        completed_at: scan.completedAt,
        usage_tokens: scan.usageTokens,
        usage_usd_cents: scan.usageUsdCents,
      },
      200,
    );
  });

  // -------------------------------------------------------------------------
  // GET /:id/events?since=<unix-ms> — polled event stream
  //
  // Strictly-after semantics: `created_at > since`. When `since` is absent
  // or unparseable we treat it as 0 (return everything). The shape is a
  // bare array per openapi (clients infer `nextSince` by reading the
  // largest `created_at` they saw).
  // -------------------------------------------------------------------------
  app.get("/:id/events", (c) => {
    const user = c.get("user");
    const scanId = c.req.param("id");
    const scan = loadOwnedScan(scanId, user.id);
    if (!scan) return c.json(NOT_FOUND, 404);

    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined ? Number.parseInt(sinceRaw, 10) : 0;
    const sinceMs = Number.isFinite(since) && since >= 0 ? since : 0;

    const rows = db
      .select()
      .from(scanEventsTable)
      .where(
        sinceMs > 0
          ? and(eq(scanEventsTable.scanId, scanId), gt(scanEventsTable.createdAt, sinceMs))
          : eq(scanEventsTable.scanId, scanId),
      )
      .orderBy(asc(scanEventsTable.createdAt))
      .all();

    return c.json(
      rows.map((r) => ({
        id: r.id,
        scan_id: r.scanId,
        event_type: r.eventType,
        payload: parseJsonObject(r.payloadJson),
        created_at: r.createdAt,
      })),
      200,
    );
  });

  // -------------------------------------------------------------------------
  // GET /:id/findings — list
  //
  // Order: severity DESC (critical → informational) then created_at ASC
  // (chronological within each severity bucket). Severity ordering uses
  // SEVERITY_RANK because SQLite text sort does NOT match the desired
  // semantic order.
  // -------------------------------------------------------------------------
  app.get("/:id/findings", (c) => {
    const user = c.get("user");
    const scanId = c.req.param("id");
    const scan = loadOwnedScan(scanId, user.id);
    if (!scan) return c.json(NOT_FOUND, 404);

    const rows = db
      .select()
      .from(findingsTable)
      .where(eq(findingsTable.scanId, scanId))
      .orderBy(asc(findingsTable.createdAt))
      .all();

    const sorted = [...rows].sort((a, b) => {
      const ra = SEVERITY_RANK[a.severity] ?? 99;
      const rb = SEVERITY_RANK[b.severity] ?? 99;
      if (ra !== rb) return ra - rb;
      return a.createdAt - b.createdAt;
    });

    return c.json(sorted.map(rowToFinding), 200);
  });

  // -------------------------------------------------------------------------
  // GET /:id/findings/:findingId — detail
  //
  // We re-verify the finding belongs to the requested scan (not just owned
  // by the caller) — otherwise a caller could probe a finding from one of
  // their OTHER scans by guessing the id. 404 either way.
  // -------------------------------------------------------------------------
  app.get("/:id/findings/:findingId", (c) => {
    const user = c.get("user");
    const scanId = c.req.param("id");
    const findingId = c.req.param("findingId");
    const scan = loadOwnedScan(scanId, user.id);
    if (!scan) return c.json(NOT_FOUND, 404);

    const row = db
      .select()
      .from(findingsTable)
      .where(and(eq(findingsTable.id, findingId), eq(findingsTable.scanId, scanId)))
      .get();
    if (!row) return c.json(NOT_FOUND, 404);

    return c.json(rowToFinding(row), 200);
  });

  // -------------------------------------------------------------------------
  // GET /:id/report — report meta + placeholder download URL
  //
  // The actual S3 presign happens in a follow-up task (T070 area). For now
  // we return the bucket+key plus a placeholder `download_url` that the
  // frontend treats as "ready when non-null"; the real signed URL will
  // be wired when the S3 dependency lands in server boot for this route.
  // -------------------------------------------------------------------------
  app.get("/:id/report", (c) => {
    const user = c.get("user");
    const scanId = c.req.param("id");
    const scan = loadOwnedScan(scanId, user.id);
    if (!scan) return c.json(NOT_FOUND, 404);

    const report = db
      .select()
      .from(reportsTable)
      .where(eq(reportsTable.scanId, scanId))
      .get();
    if (!report) return c.json(NOT_FOUND, 404);

    const isReady = report.status === "ready" && report.bucket !== null && report.key !== null;
    return c.json(
      {
        status: report.status,
        byte_size: report.byteSize,
        download_url: isReady
          ? `s3://${report.bucket}/${report.key}` // placeholder until presign wiring
          : null,
        download_expires_at: isReady ? report.expiresAt : null,
      },
      200,
    );
  });

  // -------------------------------------------------------------------------
  // POST /:id/report/regenerate — enqueue a new render_pdf job
  //
  // Idempotency rule: refuse with 409 when ANY render_pdf job for this
  // scan is currently in `pending` or `running` status. We check the
  // jobs table by scanning payloads — there is no FK index, but the
  // `jobs_type_idx` makes the WHERE type='render_pdf' lookup cheap, and
  // we filter the small result set in-memory.
  //
  // The new flow:
  //   1. Verify owner.
  //   2. Scan for collision → 409 if found.
  //   3. UPSERT-like: if no `reports` row exists for this scan, INSERT a
  //      fresh one with status='pending'. Otherwise UPDATE its status
  //      back to 'pending' so the handler can pick it up cleanly.
  //      All inside one `withTx` with the jobs insert.
  //   4. Audit emit AFTER commit (Constitution X).
  //   5. 202 response with the report id.
  // -------------------------------------------------------------------------
  app.post("/:id/report/regenerate", async (c) => {
    const user = c.get("user");
    const scanId = c.req.param("id");
    const scan = loadOwnedScan(scanId, user.id);
    if (!scan) return c.json(NOT_FOUND, 404);

    // Idempotency check — pull all live render_pdf jobs and match payloads.
    const liveRenderJobs = db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.type, "render_pdf"),
          inArray(jobsTable.status, ["pending", "running"]),
        ),
      )
      .all();
    const collision = liveRenderJobs.find((row) => {
      try {
        const p = JSON.parse(row.payloadJson) as { scanId?: string };
        return p.scanId === scanId;
      } catch {
        return false;
      }
    });
    if (collision) {
      return c.json(CONFLICT_PENDING_RENDER, 409);
    }

    const ts = clock();
    const newReportId = ulid(ts);
    const newJobId = ulid(ts);
    let reportId = newReportId;

    await withTx(db, async (tx) => {
      const existing = tx
        .select({ id: reportsTable.id })
        .from(reportsTable)
        .where(eq(reportsTable.scanId, scanId))
        .get();
      if (existing) {
        reportId = existing.id;
        tx.update(reportsTable)
          .set({
            status: "pending",
            lastError: null,
            updatedAt: ts,
          })
          .where(eq(reportsTable.scanId, scanId))
          .run();
      } else {
        tx.insert(reportsTable)
          .values({
            id: reportId,
            scanId,
            status: "pending",
            bucket: null,
            key: null,
            byteSize: null,
            renderAttempts: 0,
            lastError: null,
            expiresAt: null,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }

      const payload: RenderPdfJob = {
        type: "render_pdf",
        scanId,
        reportId,
      };
      tx.insert(jobsTable)
        .values({
          id: newJobId,
          type: "render_pdf",
          payloadJson: JSON.stringify(payload),
          status: "pending",
          scheduledAt: ts,
          attempts: 0,
          lastError: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    });

    // Audit AFTER tx commit (bun:sqlite cannot nest BEGINs).
    await emitSignedAudit(
      db,
      {
        event: "pdf_render_requested",
        outcome: "success",
        ts,
        user_id: user.id,
        scan_id: scanId,
        metadata: {
          job_id: newJobId,
          report_id: reportId,
          regenerate: true,
        },
      },
      { key: auditKey },
    );

    return c.json({ report_id: reportId, job_id: newJobId }, 202);
  });

  return app;
}

// `desc` is intentionally unused by the public surface (severity ordering
// is in-memory). Keep the import so future ordering tweaks have it ready.
void desc;
