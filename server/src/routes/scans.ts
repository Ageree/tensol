/**
 * T041 — `/api/scans/*` routes. Closes Phase 3.4 (Scan lifecycle).
 *
 * Public surface (mounted under `/api/scans` from `server.ts`):
 *   - POST   /              — body `{target_id, profile}` → start scan.
 *   - GET    /              — list caller's scans (newest-first).
 *   - GET    /:id           — read one scan (owner-scoped).
 *   - POST   /:id/cancel    — cancel a non-terminal scan + enqueue teardown.
 *   - GET    /:id/audit     — return the audit timeline for one scan.
 *
 * Why cancel is inlined here (and not behind a service helper):
 *   T065 (Phase 6) will lift cancel into its own service module with full
 *   semantics — wallclock budget, watchdog interlock, partial-finding
 *   reconciliation. T041's job is just to make POST /cancel work end-to-end
 *   so the integration test can prove the lifecycle round-trip. Keeping
 *   the cancel logic inline matches the "minimal stub" mandate in tasks.md
 *   line 96 and avoids inventing a service surface that T065 might want
 *   to redesign.
 *
 * Status code mapping (kept aligned with `scans/service.ts` T039):
 *   - Service `{ok:false, code:404}` → HTTP 404 `{error: "not_found"}`.
 *   - Service `{ok:false, code:403}` → HTTP 403 `{error: <reason>}`.
 *   - Cancel on terminal scan → HTTP 409 `{error: "scan_terminal"}`.
 *   - Happy paths: 201 (start), 200 (read / list / audit), 204 (cancel).
 *
 * Audit emission:
 *   - `scan_started`   emitted from inside `startScan` (T039 service).
 *   - `scan_cancelled` emitted here, AFTER the cancel tx commits — bun:sqlite
 *     forbids nested BEGINs.
 *   - All other lifecycle events (`vps_provisioned`, `decepticon_invoked`,
 *     `scan_completed`, `scan_failed`) are emitted by their respective
 *     job handlers / webhook receivers — the routes do NOT duplicate them.
 *
 * Ownership semantics:
 *   - Foreign user → 404 (NOT 403) for both GET and cancel. Matches
 *     projects / targets services — hides existence of resources owned by
 *     other tenants. The cancel path re-derives ownership via JOIN through
 *     `targets → projects → users`, mirroring `getScan`.
 */
import { eq, asc } from "drizzle-orm";
import { Hono } from "hono";

import {
  createRequireAuth,
  type AuthVariables,
} from "../auth/middleware.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  auditLog,
  jobs as jobsTable,
  projects as projectsTable,
  scans as scansTable,
  targets as targetsTable,
  vpsInstances as vpsInstancesTable,
} from "../db/schema.ts";
import { now as defaultNow } from "../lib/time.ts";
import { ulid } from "../lib/ids.ts";
import { emitSignedAudit } from "../audit/emit.ts";
import {
  ScanIdParamSchema,
  StartScanBodySchema,
} from "../schemas/scans.ts";
import {
  getScan,
  listScans,
  startScan,
} from "../scans/service.ts";
import type { TeardownVpsJob } from "../jobs/types.ts";

export interface CreateScansRoutesDeps {
  readonly db: DB;
  readonly signingKey: string;
  readonly now?: () => number;
}

/** Uniform 400 envelope, mirrors routes/projects.ts. */
function badRequest(
  c: { json: (b: unknown, s: number) => Response },
  opts: { error: string; field?: string; message?: string },
): Response {
  return c.json(opts, 400);
}

export function createScansRoutes(
  deps: CreateScansRoutesDeps,
): Hono<{ Variables: AuthVariables }> {
  const { db, signingKey } = deps;
  const clock = deps.now ?? defaultNow;
  const requireAuth = createRequireAuth({ db, now: clock });

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth);

  // -------------------------------------------------------------------------
  // POST / — start a new scan.
  // -------------------------------------------------------------------------
  app.post("/", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return badRequest(c, { error: "invalid_json" });
    }
    const parsed = StartScanBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return badRequest(c, {
        error: "invalid_request",
        field: issue?.path.join(".") ?? "body",
        message: issue?.message ?? "invalid request body",
      });
    }

    const user = c.get("user");
    const result = await startScan(
      db,
      {
        userId: user.id,
        targetId: parsed.data.target_id,
        profile: parsed.data.profile,
      },
      { signingKey, now: clock },
    );
    if (!result.ok) {
      return c.json({ error: result.reason }, result.code);
    }
    return c.json({ scan: result.value }, 201);
  });

  // -------------------------------------------------------------------------
  // GET / — list caller's scans.
  // -------------------------------------------------------------------------
  app.get("/", async (c) => {
    const user = c.get("user");
    const scans = await listScans(db, { userId: user.id });
    return c.json({ scans });
  });

  // -------------------------------------------------------------------------
  // GET /:id — read one scan.
  // -------------------------------------------------------------------------
  app.get("/:id", async (c) => {
    const paramParse = ScanIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) {
      return c.json({ error: "not_found" }, 404);
    }
    const user = c.get("user");
    const result = await getScan(db, {
      userId: user.id,
      scanId: paramParse.data.id,
    });
    if (!result.ok) {
      return c.json({ error: result.reason }, result.code);
    }
    return c.json({ scan: result.value });
  });

  // -------------------------------------------------------------------------
  // POST /:id/cancel — cancel a non-terminal scan.
  //
  // 1. Validate id shape (malformed → 404 to hide existence).
  // 2. Ownership-checked SELECT (JOIN scans → targets → projects).
  // 3. If scan.status in {completed, failed, cancelled} → 409 scan_terminal.
  // 4. withTx: UPDATE scans.status='cancelled' + (if a live vps_instance
  //    exists) INSERT a teardown_vps job row.
  // 5. After commit: emit scan_cancelled audit (bun:sqlite cannot nest
  //    BEGINs — same rule as scans/service.ts).
  // -------------------------------------------------------------------------
  app.post("/:id/cancel", async (c) => {
    const paramParse = ScanIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) {
      return c.json({ error: "not_found" }, 404);
    }

    const user = c.get("user");
    const scanId = paramParse.data.id;

    // Ownership-checked read.
    const row = db
      .select({
        scan: scansTable,
        projectId: targetsTable.projectId,
        ownerUserId: projectsTable.userId,
      })
      .from(scansTable)
      .innerJoin(targetsTable, eq(scansTable.targetId, targetsTable.id))
      .innerJoin(projectsTable, eq(targetsTable.projectId, projectsTable.id))
      .where(eq(scansTable.id, scanId))
      .get();

    if (!row || row.ownerUserId !== user.id) {
      // Hide existence — matches getScan / deleteProject semantics.
      return c.json({ error: "not_found" }, 404);
    }

    const terminal = ["completed", "failed", "cancelled"] as const;
    if (terminal.includes(row.scan.status as (typeof terminal)[number])) {
      return c.json({ error: "scan_terminal" }, 409);
    }

    const cancelTs = clock();

    await withTx(db, async (tx) => {
      tx.update(scansTable)
        .set({ status: "cancelled", completedAt: cancelTs })
        .where(eq(scansTable.id, scanId))
        .run();

      // Enqueue teardown_vps if a live vps_instance exists for this scan.
      // We look for both 'provisioning' and 'alive' — either state means
      // the provider may still be billing us.
      const liveVps = tx
        .select()
        .from(vpsInstancesTable)
        .where(eq(vpsInstancesTable.scanId, scanId))
        .all()
        .filter(
          (v) => v.status === "provisioning" || v.status === "alive",
        );

      for (const vps of liveVps) {
        const teardownPayload: TeardownVpsJob = {
          type: "teardown_vps",
          vps_instance_id: vps.id,
          reason: "cancelled",
        };
        tx.insert(jobsTable)
          .values({
            id: ulid(cancelTs),
            type: "teardown_vps",
            payloadJson: JSON.stringify(teardownPayload),
            status: "pending",
            scheduledAt: cancelTs,
            attempts: 0,
            lastError: null,
            createdAt: cancelTs,
            updatedAt: cancelTs,
          })
          .run();
      }
    });

    // Audit emission AFTER commit — emit owns its own BEGIN IMMEDIATE.
    await emitSignedAudit(
      db,
      {
        event: "scan_cancelled",
        outcome: "success",
        ts: cancelTs,
        user_id: user.id,
        project_id: row.projectId,
        target_id: row.scan.targetId,
        scan_id: scanId,
        metadata: { reason: "user_initiated" },
      },
      { key: signingKey },
    );

    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /:id/audit — audit timeline for one scan.
  //
  // Ownership-checked: we re-run the same JOIN as cancel, then SELECT all
  // audit_log rows WHERE scan_id=:id ORDER BY id ASC. The id ordering
  // matches insertion order (audit_log.id is AUTOINCREMENT INTEGER).
  // -------------------------------------------------------------------------
  app.get("/:id/audit", async (c) => {
    const paramParse = ScanIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) {
      return c.json({ error: "not_found" }, 404);
    }

    const user = c.get("user");
    const scanId = paramParse.data.id;

    // Ownership gate via the same JOIN as getScan.
    const ownerRow = db
      .select({ ownerUserId: projectsTable.userId })
      .from(scansTable)
      .innerJoin(targetsTable, eq(scansTable.targetId, targetsTable.id))
      .innerJoin(projectsTable, eq(targetsTable.projectId, projectsTable.id))
      .where(eq(scansTable.id, scanId))
      .get();

    if (!ownerRow || ownerRow.ownerUserId !== user.id) {
      return c.json({ error: "not_found" }, 404);
    }

    const rows = db
      .select({
        id: auditLog.id,
        ts: auditLog.ts,
        event: auditLog.event,
        outcome: auditLog.outcome,
        severity: auditLog.severity,
        scanId: auditLog.scanId,
        vpsInstanceId: auditLog.vpsInstanceId,
        findingId: auditLog.findingId,
        metadataJson: auditLog.metadataJson,
      })
      .from(auditLog)
      .where(eq(auditLog.scanId, scanId))
      .orderBy(asc(auditLog.id))
      .all();

    // Reshape to snake_case + parse metadata for the response envelope.
    const events = rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      event: r.event,
      outcome: r.outcome,
      severity: r.severity,
      scan_id: r.scanId,
      vps_instance_id: r.vpsInstanceId,
      finding_id: r.findingId,
      metadata: safeParseJson(r.metadataJson),
    }));
    return c.json({ events });
  });

  return app;
}

/** Defensive: malformed metadata shouldn't break the audit timeline view. */
function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
