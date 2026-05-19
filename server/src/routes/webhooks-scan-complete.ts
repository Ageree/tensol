/**
 * T069 — `POST /v1/webhooks/scan-complete` receiver (US1 final-callback).
 *
 * This is the **inbound HTTP endpoint** that `vps-agent` running on the
 * per-scan Yandex VM calls when a Decepticon scan terminates.
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/contracts/webhook.md`
 *       (envelope, header format, validation order, error envelopes)
 *   - `server/src/schemas/webhook-scan-complete.ts` (T026)
 *       (Zod body validator + YAML frontmatter normaliser)
 *   - `server/src/findings/ingest.ts` (T048)
 *       (per-finding insert + finding_ingested audit)
 *   - `server/src/audit/emit.ts` (T014)
 *       (signed audit chain + webhook_received / webhook_invalid_signature
 *        literal event names)
 *
 * Companion to `server/src/routes/webhooks.ts` — that file holds the V1
 * `POST /scan-progress` handler from feature 001 (per-VPS sign_key looked
 * up via `vps_instances`). This new V2 endpoint uses a single shared
 * `TENSOL_WEBHOOK_SECRET` for the whole fleet, with the Stripe-style
 * `t=<seconds>, v1=<hex>` header envelope. The two paths intentionally
 * live in separate files so the V1 path can be retired independently when
 * we cut over.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Validation order (per webhook.md §"Validation order") — TIGHT and ORDERED:
 *
 *   1. X-Tensol-Signature header present + parses to { t, v1 }
 *        → 401 "webhook_invalid_signature" otherwise
 *   2. Timestamp drift within ±5 minutes of `now()`
 *        → 401 "webhook_replay_too_old" otherwise + audit emit
 *   3. HMAC v1 = hex(hmac_sha256(secret, "${t}.${rawBody}")) matches
 *        → 401 "webhook_invalid_signature" otherwise + audit emit
 *   4. Body parses as JSON
 *        → 422 "webhook_body_invalid" otherwise
 *   5. WebhookScanCompleteBodySchema.parse
 *        → 422 "webhook_body_invalid" otherwise
 *   6. Idempotency: audit_log row with event='webhook_received' AND
 *      metadata.scan_order_id=$id already exists
 *        → 200 { status: "duplicate" } no-op
 *   7. Scan order ownership + state (must be `running` or `vm_provisioning`)
 *        → 409 "scan_order_not_running" otherwise
 *   8. Findings ingest via createFindingsIngest().insertFinding (one per
 *      finding); UPDATE scans.status=completed, scan_orders.status=completed
 *   9. Enqueue `render_pdf`, `send_scan_complete_telegram`,
 *      `teardown_yandex_vm` jobs
 *  10. Emit `webhook_received` signed audit AFTER all state changes commit
 *
 * Constitution invariants honoured here:
 *   - II  (NON-NEGOTIABLE): HMAC validation runs BEFORE JSON.parse and
 *         BEFORE any DB mutation. We read `c.req.text()` so the exact
 *         signed bytes are available without re-canonicalisation.
 *   - VII: file ≤ 800 LOC. (This file: ~330 LOC.)
 *   - IX  (NON-NEGOTIABLE): Zod validates the body before any state write.
 *   - X   (NON-NEGOTIABLE): `webhook_received` audit emit happens AFTER
 *         the controlling state change commits. Likewise, the rejection
 *         path emits `webhook_invalid_signature` with outcome='rejected'
 *         so the SOC has visibility into spoof attempts.
 *
 * INTERPRETATION NOTES (where webhook.md left wiggle room):
 *   - Header format: `t=<unix-seconds>, v1=<hex>` per the contract. We
 *     tolerate optional whitespace around the `,` (the contract shows
 *     one space; vps-agent may emit zero) and lowercase-only hex (the
 *     contract example uses lowercase).
 *   - Drift window: the contract says "within ±5 minutes". We allow
 *     EXACTLY 5min on either side (`Math.abs(...) <= 5*60`) to make the
 *     edge case test-pinnable.
 *   - Idempotency dedup key: we use `audit_log` rows with
 *     `event='webhook_received' AND metadata_json` containing the
 *     scan_order_id (audit_log has no top-level scan_order_id column;
 *     the value lives in the metadata JSON blob). This matches the
 *     contract's "row in audit_log … exists" wording without requiring
 *     a new DB column.
 *   - Findings target: each finding row needs a `target` value (E5
 *     NOT NULL). We default it to `scanOrders.primaryDomain` when the
 *     YAML frontmatter doesn't include `affected_target` — keeps the
 *     ingest schema-clean even on findings that only report a host:port.
 *   - State `cancelled` / `completed`: a webhook arriving for a terminal
 *     order is treated as 409 (not idempotent 200) because the order
 *     was already fully resolved; the audit-log dedup path above only
 *     triggers when the previous webhook_received row exists, which
 *     only happens if WE marked it completed.
 *
 * What this module deliberately does NOT do:
 *   - Touch `vps_instances` — V2 contract has no per-VPS sign_key (single
 *     fleet secret instead). The teardown_yandex_vm job handler is the
 *     one that flips the vps_instances row to `tearing_down`.
 *   - Render PDFs / send Telegram — those happen via the enqueued jobs.
 *   - Verify the evidence_archive_url bucket name policy — contract
 *     mentions "must match expected bucket" but defers concrete policy
 *     to the route handler; we accept any `s3://` URI (already validated
 *     by the Zod schema). Bucket allowlist policy is filed under T07x.
 */
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";

import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  scanOrders as scanOrdersTable,
  scans as scansTable,
  jobs as jobsTable,
  auditLog as auditLogTable,
} from "../db/schema.ts";
import { emitSignedAudit } from "../audit/emit.ts";
import { createFindingsIngest } from "../findings/ingest.ts";
import { hmacSha256, timingSafeEqual } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import {
  WebhookScanCompleteBodySchema,
  type WebhookScanCompleteBody,
} from "../schemas/webhook-scan-complete.ts";

/** Five-minute drift window per webhook.md §"Signature header". */
const SIGNATURE_DRIFT_SECONDS = 5 * 60;

/** Jobs we enqueue on successful webhook ingest. Order is irrelevant —
 *  the runner picks them up independently — but listing here keeps the
 *  audit trail / tests readable. */
const FOLLOWUP_JOB_KINDS = [
  "render_pdf",
  "send_scan_complete_telegram",
  "teardown_yandex_vm",
] as const;

export interface CreateWebhookScanCompleteRouterDeps {
  readonly db: DB;
  /** HMAC-SHA256 secret shared with every vps-agent (TENSOL_WEBHOOK_SECRET). */
  readonly webhookSecret: string;
  /** Audit-log signing key (TENSOL_AUDIT_SIGNING_KEY) — same key the
   *  scan-orders service uses. */
  readonly auditKey: string;
  /** Clock injection for tests. Defaults to `Date.now()` via lib/time. */
  readonly now?: () => number;
  /** ULID factory injection for tests. Defaults to global `ulid()`. */
  readonly newId?: () => string;
}

interface ParsedSignatureHeader {
  readonly t: number; // unix seconds
  readonly v1: string; // lowercase hex
}

/** Parse the `t=<seconds>, v1=<hex>` envelope per webhook.md.
 *
 * Tolerates:
 *   - any whitespace around the `,` separator
 *   - any ordering of the two key/value pairs (`v1=...,t=...` also valid)
 *   - lower OR upper-case hex (`hmacSha256` always returns lowercase, but
 *     we don't want an upper-case sig from a bug to look like a "spoof")
 *
 * Returns `null` on any structural problem; the caller maps null to 401.
 */
function parseSignatureHeader(raw: string | undefined): ParsedSignatureHeader | null {
  if (!raw) return null;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 2) return null;

  let t: number | null = null;
  let v1: string | null = null;

  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) return null;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key === "t") {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      t = n;
    } else if (key === "v1") {
      if (!/^[0-9a-fA-F]+$/.test(value)) return null;
      v1 = value.toLowerCase();
    } else {
      return null;
    }
  }

  if (t === null || v1 === null) return null;
  return { t, v1 };
}

/**
 * Public factory — assembles the Hono subrouter mounted at `/v1/webhooks`
 * (so the full path is `POST /v1/webhooks/scan-complete`).
 */
export function createWebhookScanCompleteRouter(
  deps: CreateWebhookScanCompleteRouterDeps,
): Hono {
  const { db, webhookSecret, auditKey } = deps;
  const clock = deps.now ?? defaultNow;
  const newId = deps.newId ?? (() => ulid(clock()));

  const ingest = createFindingsIngest({
    db,
    auditKey,
    clock,
    newId,
  });

  const app = new Hono();

  app.post("/scan-complete", async (c) => {
    // ───────────────────────────────────────────────────────────────────
    // 1. Read raw body bytes — HMAC verifies the exact bytes the agent
    //    signed; re-canonicalising via c.req.json() would break the
    //    signature for any body with non-canonical whitespace.
    // ───────────────────────────────────────────────────────────────────
    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch {
      return c.json(
        { error: "webhook_body_invalid", message: "could not read body" },
        422,
      );
    }

    // ───────────────────────────────────────────────────────────────────
    // 2. Parse the signature header.
    // ───────────────────────────────────────────────────────────────────
    const sigHeader = c.req.header("x-tensol-signature");
    const sig = parseSignatureHeader(sigHeader);
    if (!sig) {
      // Bare 401 — no audit row, because without a timestamp we have no
      // useful signal to record (could be a benign probe / scanner).
      return c.json(
        {
          error: "webhook_invalid_signature",
          message: "missing or malformed X-Tensol-Signature header",
        },
        401,
      );
    }

    // ───────────────────────────────────────────────────────────────────
    // 3. Timestamp drift check. Outside ±5min → 401 + rejected audit.
    // ───────────────────────────────────────────────────────────────────
    const nowMs = clock();
    const nowSeconds = Math.floor(nowMs / 1000);
    const driftSeconds = Math.abs(nowSeconds - sig.t);
    if (driftSeconds > SIGNATURE_DRIFT_SECONDS) {
      await emitSignedAudit(
        db,
        {
          event: "webhook_invalid_signature",
          outcome: "rejected",
          ts: nowMs,
          metadata: {
            reason: "stale_timestamp",
            drift_seconds: driftSeconds,
            agent_timestamp: sig.t,
          },
        },
        { key: auditKey },
      );
      return c.json(
        {
          error: "webhook_replay_too_old",
          message: `Timestamp ${sig.t} outside ±${SIGNATURE_DRIFT_SECONDS}s window`,
        },
        401,
      );
    }

    // ───────────────────────────────────────────────────────────────────
    // 4. Verify HMAC. Constant-time compare against the recomputed hex.
    //    Signed string per contract: "${t}.${rawBody}".
    // ───────────────────────────────────────────────────────────────────
    const expected = hmacSha256(webhookSecret, `${sig.t}.${rawBody}`);
    if (!timingSafeEqual(expected, sig.v1)) {
      await emitSignedAudit(
        db,
        {
          event: "webhook_invalid_signature",
          outcome: "rejected",
          ts: nowMs,
          metadata: {
            reason: "hmac_mismatch",
            // Length only — never log the offending signature bytes.
            received_signature_length: sig.v1.length,
          },
        },
        { key: auditKey },
      );
      return c.json(
        {
          error: "webhook_invalid_signature",
          message: "Signature verification failed",
        },
        401,
      );
    }

    // ───────────────────────────────────────────────────────────────────
    // 5. Body parse + Zod validation. Both failure modes → 422.
    // ───────────────────────────────────────────────────────────────────
    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(rawBody);
    } catch {
      return c.json(
        { error: "webhook_body_invalid", message: "body is not valid JSON" },
        422,
      );
    }
    const parsed = WebhookScanCompleteBodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      return c.json(
        {
          error: "webhook_body_invalid",
          message: parsed.error.issues[0]?.message ?? "validation failed",
          issues: parsed.error.issues,
        },
        422,
      );
    }
    const body: WebhookScanCompleteBody = parsed.data;

    // ───────────────────────────────────────────────────────────────────
    // 6. Idempotency check (audit-log dedup).
    //
    // We look for a prior `webhook_received` row whose metadata_json
    // contains the same scan_order_id. SQLite has no native JSON
    // operator we want to rely on (json_extract works but the column
    // contains alpha-sorted keys), so we use a LIKE pattern on the
    // serialised metadata blob — false positives are impossible because
    // the scan_order_id is a 26-char Crockford ULID, vanishingly
    // unlikely to appear as a substring anywhere else.
    // ───────────────────────────────────────────────────────────────────
    const dedupPattern = `%"scan_order_id":"${body.scan_order_id}"%`;
    const prior = db
      .select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(
        sql`${auditLogTable.event} = ${"webhook_received"} AND ${auditLogTable.metadataJson} LIKE ${dedupPattern}`,
      )
      .limit(1)
      .get();
    if (prior) {
      return c.json(
        {
          status: "duplicate",
          scan_order_id: body.scan_order_id,
        },
        200,
      );
    }

    // ───────────────────────────────────────────────────────────────────
    // 7. Order + scan ownership. The order must be in `running` or
    //    `vm_provisioning` per webhook.md §4; anything else → 409.
    // ───────────────────────────────────────────────────────────────────
    const order = db
      .select()
      .from(scanOrdersTable)
      .where(eq(scanOrdersTable.id, body.scan_order_id))
      .get();
    if (!order) {
      return c.json(
        { error: "scan_order_not_found", message: "no such scan_order" },
        404,
      );
    }
    const acceptedStates = new Set(["running", "vm_provisioning"]);
    if (!acceptedStates.has(order.status)) {
      return c.json(
        {
          error: "scan_order_not_running",
          message: `Order is in status '${order.status}'`,
        },
        409,
      );
    }
    if (!order.scanId) {
      // Defensive — the wizard's launchScan always sets scan_id at the
      // same moment it flips status→vm_provisioning. A missing scan_id
      // here would mean a schema-drift bug, not a webhook problem.
      return c.json(
        { error: "scan_id_missing", message: "scan row not provisioned" },
        409,
      );
    }
    const scanRow = db
      .select()
      .from(scansTable)
      .where(eq(scansTable.id, order.scanId))
      .get();
    if (!scanRow) {
      return c.json(
        { error: "scan_not_found", message: "scan row missing" },
        409,
      );
    }

    // ───────────────────────────────────────────────────────────────────
    // 8. Ingest findings (one row + one finding_ingested audit each).
    //    Per-finding ingest happens OUTSIDE the state-transition tx
    //    because createFindingsIngest owns its own BEGIN per audit emit
    //    (bun:sqlite forbids nested BEGINs). Crash-safety: a crash mid-
    //    batch leaves N<full findings + 0 jobs + status=running, and the
    //    next retry from vps-agent will (a) re-insert all findings
    //    [duplicates allowed — dedup is the route's job, not ingest's],
    //    (b) finish the terminal transition, (c) emit webhook_received.
    //    To avoid duplicate findings on retry, we honour the audit-log
    //    dedup in step 6 BEFORE running ingest — so a retry path that
    //    reached step 8 last time and crashed before step 10 would also
    //    skip ingest the second time, leaving partial findings. That's
    //    rare enough (process crash mid-callback) to defer to T07x.
    // ───────────────────────────────────────────────────────────────────
    for (const f of body.findings) {
      const target =
        f.raw_yaml_frontmatter.affected_target ?? order.primaryDomain;
      await ingest.insertFinding({
        scanId: scanRow.id,
        target,
        finding: f,
        now: nowMs,
      });
    }

    // ───────────────────────────────────────────────────────────────────
    // 9. State transition + job enqueue in ONE transaction.
    // ───────────────────────────────────────────────────────────────────
    const jobIds: Record<string, string> = {};
    await withTx(db, async (tx) => {
      tx.update(scansTable)
        .set({
          status: "completed",
          completedAt: nowMs,
        })
        .where(eq(scansTable.id, scanRow.id))
        .run();

      tx.update(scanOrdersTable)
        .set({
          status: "completed",
          updatedAt: nowMs,
        })
        .where(eq(scanOrdersTable.id, body.scan_order_id))
        .run();

      for (const kind of FOLLOWUP_JOB_KINDS) {
        const jobId = newId();
        jobIds[kind] = jobId;
        const payload =
          kind === "render_pdf"
            ? { type: kind, scan_id: scanRow.id }
            : kind === "send_scan_complete_telegram"
              ? {
                  type: kind,
                  scan_id: scanRow.id,
                  scan_order_id: body.scan_order_id,
                  user_id: scanRow.userId,
                }
              : {
                  type: kind,
                  scan_id: scanRow.id,
                  scan_order_id: body.scan_order_id,
                };
        tx.insert(jobsTable)
          .values({
            id: jobId,
            type: kind,
            payloadJson: JSON.stringify(payload),
            status: "pending",
            scheduledAt: nowMs,
            attempts: 0,
            lastError: null,
            createdAt: nowMs,
            updatedAt: nowMs,
          })
          .run();
      }
    });

    // ───────────────────────────────────────────────────────────────────
    // 10. Post-commit audit (Constitution X). Emit `scan_completed` for
    //     scan lifecycle parity (the V1 webhook also did this) and then
    //     `webhook_received` as the idempotency anchor.
    // ───────────────────────────────────────────────────────────────────
    await emitSignedAudit(
      db,
      {
        event: "scan_completed",
        outcome: "success",
        ts: nowMs,
        user_id: scanRow.userId,
        scan_id: scanRow.id,
        metadata: {
          scan_order_id: body.scan_order_id,
          findings_count: body.findings.length,
          duration_seconds: body.duration_seconds,
        },
      },
      { key: auditKey },
    );

    await emitSignedAudit(
      db,
      {
        event: "webhook_received",
        outcome: "success",
        ts: nowMs,
        user_id: scanRow.userId,
        scan_id: scanRow.id,
        metadata: {
          scan_order_id: body.scan_order_id,
          findings_count: body.findings.length,
          evidence_archive_url: body.evidence_archive_url,
          decepticon_events_count: body.decepticon_events_count ?? null,
          jobs: jobIds,
        },
      },
      { key: auditKey },
    );

    return c.json(
      {
        status: "ok",
        scan_order_id: body.scan_order_id,
        findings_ingested: body.findings.length,
      },
      200,
    );
  });

  return app;
}
