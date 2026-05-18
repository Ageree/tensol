/**
 * T044 — `POST /webhooks/scan-progress` receiver.
 *
 * Public surface (mounted under `/webhooks` from `server.ts`):
 *   - POST /scan-progress — VPS-agent terminal callback.
 *
 * This is a PUBLIC endpoint — no session-cookie auth. The only authentication
 * is the per-VPS HMAC-SHA256 signature carried in `X-Tensol-Signature`, keyed
 * by the `vps_instances.sign_key` minted at spawn time.
 *
 * Contract refs:
 *   - `specs/001-backend-v2/contracts/webhook.md`     (wire shape + responses)
 *   - `server/src/schemas/webhook.ts` (T042)          (Zod body validator)
 *   - `server/src/findings/service.ts` (T043)         (storeFindings dedup)
 *   - `server/src/audit/emit.ts` (T014)               (emitSignedAudit)
 *
 * Flow:
 *   1. Read `X-Tensol-Scan-Id` + `X-Tensol-Signature` headers (missing → 401).
 *   2. Read raw body bytes via `c.req.text()` — NEVER `c.req.json()`, because
 *      HMAC verification must run over the EXACT bytes the agent signed. Any
 *      JSON re-stringification would canonicalise whitespace and the signature
 *      would no longer match a payload formatted with extra whitespace, which
 *      is legal per RFC 8259.
 *   3. Lookup the most recent NON-destroyed `vps_instance` for this scan_id.
 *      No row → 404 (we deliberately conflate "scan does not exist" and
 *      "scan exists but vps already destroyed" — both mean we cannot verify
 *      the signature, and revealing the distinction leaks lifecycle state).
 *   4. Compute `expected = HMAC-SHA256(vps.sign_key, rawBody)` and compare
 *      against `X-Tensol-Signature` with constant-time equality. Mismatch →
 *      401 + `webhook_signature_invalid` audit (we DO emit the audit row
 *      even on rejection because the SOC needs visibility into spoof
 *      attempts; the audit row gets `outcome="rejected"` per data-model.md).
 *   5. Parse JSON + Zod-validate. Failure → 400 `invalid_body`.
 *   6. Re-SELECT scan row (the lookup in step 3 only resolved vps_instance).
 *      Missing → 404 (defence in depth — should be impossible given step 3
 *      succeeded, but it costs one query to guard against schema drift).
 *   7. **Idempotency check**: if `scan.status` ∈ {completed, failed, cancelled}
 *      return 200 `{ok:true, duplicate:true}` with NO side effects. This
 *      matches the contract's "duplicate retry from a flaky agent" path.
 *      Per-finding ON CONFLICT dedup (T043) would also catch this, but
 *      catching it here avoids the wasted INSERT churn AND avoids emitting
 *      a second `scan_completed` audit row.
 *   8. Inside `withTx`:
 *        - storeFindings (per-finding ON CONFLICT(dedup_key) DO NOTHING).
 *        - UPDATE scans SET status = 'completed' | 'failed',
 *                          completed_at = now(),
 *                          failure_reason = body.failure_reason (if failed),
 *                          usage_tokens / usage_usd_cents (if body.usage).
 *        - INSERT teardown_vps job.
 *   9. AFTER commit: emit `scan_completed` (done) or `scan_failed` (failed)
 *      audit. `emitSignedAudit` owns its own BEGIN IMMEDIATE, so we cannot
 *      nest it inside the withTx above (bun:sqlite forbids nested BEGINs;
 *      same rule as `routes/scans.ts` cancel path).
 *  10. Return `{ok:true, inserted, skipped}`.
 *
 * Status-mapping invariant:
 *   webhook.status="done"   → scans.status="completed"  + audit "scan_completed" + outcome="success"
 *   webhook.status="failed" → scans.status="failed"     + audit "scan_failed"    + outcome="failure"
 *
 * The webhook contract uses {done, failed} — NOT {completed, failed} — because
 * "done" describes the *callback fact* (agent finished its job) while
 * "completed" describes the *scan fact* (scan exists and is no longer
 * running). T042's `WebhookStatusEnum` enforces the wire-level naming; this
 * module performs the wire↔storage translation.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  jobs as jobsTable,
  scans as scansTable,
  vpsInstances as vpsInstancesTable,
} from "../db/schema.ts";
import { storeFindings } from "../findings/service.ts";
import { hmacSha256, timingSafeEqual } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import {
  ScanProgressCallbackSchema,
  type ScanProgressCallback,
} from "../schemas/webhook.ts";
import type { TeardownVpsJob } from "../jobs/types.ts";

export interface CreateWebhookRoutesDeps {
  readonly db: DB;
  /** Audit-log signing key (NOT the per-VPS sign_key — that's per-row in
   *  vps_instances.sign_key, looked up by scan_id). */
  readonly signingKey: string;
  readonly now?: () => number;
}

export function createWebhookRoutes(deps: CreateWebhookRoutesDeps): Hono {
  const { db, signingKey } = deps;
  const clock = deps.now ?? defaultNow;

  const app = new Hono();

  app.post("/scan-progress", async (c) => {
    // -------------------------------------------------------------------
    // 1. Read auth headers.
    // -------------------------------------------------------------------
    const scanIdHeader = c.req.header("x-tensol-scan-id");
    const sigHeader = c.req.header("x-tensol-signature");
    if (!scanIdHeader || !sigHeader) {
      return c.json({ error: "webhook_signature_invalid" }, 401);
    }

    // -------------------------------------------------------------------
    // 2. Read raw body bytes — HMAC verification MUST operate on the
    //    exact bytes the agent signed.
    // -------------------------------------------------------------------
    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }

    // -------------------------------------------------------------------
    // 3. Lookup VPS instance for this scan (must not be destroyed).
    //
    //    We accept either 'provisioning' or 'alive' (and 'tearing_down'
    //    for the rare race where teardown began before the callback was
    //    in flight — the sign_key is still valid until destruction
    //    completes). 'destroyed' rows are excluded: at that point the
    //    sign_key is treated as revoked.
    // -------------------------------------------------------------------
    const vps = db
      .select()
      .from(vpsInstancesTable)
      .where(
        and(
          eq(vpsInstancesTable.scanId, scanIdHeader),
          inArray(vpsInstancesTable.status, [
            "provisioning",
            "alive",
            "tearing_down",
          ]),
        ),
      )
      .orderBy(desc(vpsInstancesTable.createdAt))
      .limit(1)
      .get();

    if (!vps) {
      return c.json({ error: "scan_not_found" }, 404);
    }

    // -------------------------------------------------------------------
    // 4. Verify HMAC signature.
    // -------------------------------------------------------------------
    const expected = hmacSha256(vps.signKey, rawBody);
    if (!timingSafeEqual(expected, sigHeader)) {
      // Emit a rejected audit row so SOC can see spoof attempts. Use
      // outcome="rejected" per data-model.md — distinct from "failure"
      // (which means "we tried and it failed") and "success".
      await emitSignedAudit(
        db,
        {
          event: "webhook_signature_invalid",
          outcome: "rejected",
          ts: clock(),
          scan_id: scanIdHeader,
          vps_instance_id: vps.id,
          metadata: {
            // Capture *length only* of the offending signature, never its
            // bytes — leaking the rejected sig could help an attacker
            // tune a future spoof attempt.
            received_signature_length: sigHeader.length,
          },
        },
        { key: signingKey },
      );
      return c.json({ error: "webhook_signature_invalid" }, 401);
    }

    // -------------------------------------------------------------------
    // 5. Parse + Zod-validate body.
    // -------------------------------------------------------------------
    let parsed: ScanProgressCallback;
    try {
      const jsonObj = JSON.parse(rawBody);
      const safe = ScanProgressCallbackSchema.safeParse(jsonObj);
      if (!safe.success) {
        return c.json({ error: "invalid_body" }, 400);
      }
      parsed = safe.data;
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }

    // -------------------------------------------------------------------
    // 6. Re-resolve scan row.
    // -------------------------------------------------------------------
    const scanRow = db
      .select()
      .from(scansTable)
      .where(eq(scansTable.id, scanIdHeader))
      .get();
    if (!scanRow) {
      return c.json({ error: "scan_not_found" }, 404);
    }

    // -------------------------------------------------------------------
    // 7. Idempotency: if scan already terminal, do nothing and return
    //    {ok, duplicate: true}. The retrying agent will see the same
    //    success envelope and stop retrying.
    // -------------------------------------------------------------------
    const TERMINAL = new Set(["completed", "failed", "cancelled"]);
    if (TERMINAL.has(scanRow.status)) {
      return c.json({ ok: true, duplicate: true }, 200);
    }

    // -------------------------------------------------------------------
    // 8. Mutate state in a single transaction:
    //    findings → scan.status → teardown_vps job.
    // -------------------------------------------------------------------
    const ts = clock();
    const targetStatus = parsed.status === "done" ? "completed" : "failed";

    // storeFindings has its OWN withTx; bun:sqlite forbids nesting BEGINs,
    // so we call it OUTSIDE our withTx below. This is safe because:
    //   - The findings insert is idempotent (ON CONFLICT DO NOTHING).
    //   - A crash between storeFindings and the scan/job UPDATE leaves
    //     findings present without a terminal scan. The next webhook
    //     retry will (a) re-insert findings (all skipped) and (b) finish
    //     the terminal transition — net effect is identical.
    const storeResult = await storeFindings(db, {
      scanId: scanRow.id,
      findings: parsed.findings,
      now: clock,
    });

    await withTx(db, async (tx) => {
      tx.update(scansTable)
        .set({
          status: targetStatus,
          completedAt: ts,
          failureReason:
            parsed.status === "failed" ? parsed.failure_reason : null,
          usageTokens: parsed.usage?.tokens ?? null,
          usageUsdCents: parsed.usage?.usd_cents ?? null,
        })
        .where(eq(scansTable.id, scanRow.id))
        .run();

      const teardownPayload: TeardownVpsJob = {
        type: "teardown_vps",
        vps_instance_id: vps.id,
        reason: targetStatus,
      };
      tx.insert(jobsTable)
        .values({
          id: ulid(ts),
          type: "teardown_vps",
          payloadJson: JSON.stringify(teardownPayload),
          status: "pending",
          scheduledAt: ts,
          attempts: 0,
          lastError: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    });

    // -------------------------------------------------------------------
    // 9. Emit terminal audit (own transaction).
    // -------------------------------------------------------------------
    const auditEvent =
      parsed.status === "done" ? "scan_completed" : "scan_failed";
    const auditOutcome = parsed.status === "done" ? "success" : "failure";
    await emitSignedAudit(
      db,
      {
        event: auditEvent,
        outcome: auditOutcome,
        ts,
        user_id: scanRow.userId,
        target_id: scanRow.targetId,
        scan_id: scanRow.id,
        vps_instance_id: vps.id,
        metadata: {
          inserted: storeResult.inserted,
          skipped: storeResult.skipped,
          ...(parsed.usage
            ? { usage_tokens: parsed.usage.tokens, usage_usd_cents: parsed.usage.usd_cents }
            : {}),
          ...(parsed.failure_reason
            ? { failure_reason: parsed.failure_reason }
            : {}),
        },
      },
      { key: signingKey },
    );

    return c.json(
      {
        ok: true,
        inserted: storeResult.inserted,
        skipped: storeResult.skipped,
      },
      200,
    );
  });

  return app;
}
