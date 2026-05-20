/**
 * T040 — dispatch_scan job handler.
 *
 * Once a VPS reports 'alive' (from spawn_vps), the backend POSTs the scan
 * request to it. The POST is HMAC-signed with the per-VPS sign_key that
 * cloud-init wrote onto the VPS, so the agent can verify the request came
 * from the legitimate backend before executing.
 *
 * Lifecycle:
 *   1. Read the vps_instances row by id → IPv4 + signKey + status. Bail
 *      out if missing (the runner will retry; if it's missing permanently,
 *      the runner exhausts attempts and audits 'job_failed').
 *   2. Read the scan + scan_order rows to build the request body. The body
 *      shape (canonical, sorted-by-handler):
 *        { profile, scan_id, target_url, webhook_url }
 *      The VPS already has its sign_key from cloud-init; we do NOT echo it
 *      back in the body.
 *
 *      NOTE: the legacy `targets` table was dropped in T012 (002-blackbox-mvp).
 *      The canonical V2 source for target URL is
 *      `scan_orders.primary_domain`, reached via `scans.scan_order_id`.
 *   3. Compute `X-Tensol-Signature = HMAC-SHA256(signKey, rawBody)`.
 *   4. fetch(`https://${ipv4}/scan`, …). Non-2xx OR network error → throw
 *      (runner retries). On 200, emit `decepticon_invoked` audit.
 *
 * TLS on raw IPv4:
 *   The VPS cert (if any) is self-signed because there's no DNS name.
 *   Production wires a fetch wrapper that disables CA validation for these
 *   internal calls — the application-layer HMAC carries the security
 *   guarantee, not the transport. Tests mock `fetchImpl` so this never
 *   matters in CI. The choice (https://, not http://) is deliberate: it
 *   keeps payload+signature out of cleartext on whatever path the VPS
 *   inbound traffic transits, even if the cert chain is self-signed.
 *
 * Audit metadata:
 *   Includes target_url, profile, provider_server_id implicitly via the
 *   vps_instance_id linkage. Sign_key MUST NEVER leak.
 */
import { eq } from "drizzle-orm";

import type { DB } from "../../db/client.ts";
import { scanOrders, scans, vpsInstances } from "../../db/schema.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { hmacSha256 } from "../../lib/crypto.ts";
import { emitSignedAudit } from "../../audit/emit.ts";
import type { DispatchScanJob, Handler } from "../types.ts";

export interface DispatchScanHandlerDeps {
  readonly db: DB;
  /** Audit-log signing key (NOT the VPS sign_key — that is per-instance). */
  readonly signingKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Backend base URL the VPS agent will use to call back via webhook. */
  readonly webhookBaseUrl: string;
}

export function createDispatchScanHandler(
  deps: DispatchScanHandlerDeps,
): Handler<DispatchScanJob> {
  const {
    db,
    signingKey,
    fetchImpl = fetch,
    now = defaultNow,
    webhookBaseUrl,
  } = deps;

  return async function dispatchScanHandler(
    job: DispatchScanJob,
  ): Promise<void> {
    // 1. Resolve vps_instance.
    const vps = db
      .select()
      .from(vpsInstances)
      .where(eq(vpsInstances.id, job.vps_instance_id))
      .get();
    if (!vps) {
      throw new Error(
        `dispatch_scan: vps_instance not found (id=${job.vps_instance_id})`,
      );
    }
    if (!vps.ipv4) {
      throw new Error(
        `dispatch_scan: vps_instance ${vps.id} has no IPv4 yet (cannot dispatch)`,
      );
    }

    // 2. Resolve scan + scan_order (V2: target URL lives on scan_orders.
    //    primary_domain, the legacy `targets` table was dropped in T012).
    const scan = db.select().from(scans).where(eq(scans.id, job.scan_id)).get();
    if (!scan) {
      throw new Error(`dispatch_scan: scan not found (id=${job.scan_id})`);
    }
    const order = db
      .select()
      .from(scanOrders)
      .where(eq(scanOrders.id, scan.scanOrderId))
      .get();
    if (!order) {
      throw new Error(
        `dispatch_scan: scan_order not found (id=${scan.scanOrderId}) for scan ${scan.id}`,
      );
    }

    // 3. Build canonical body. Alpha-sorted keys keep the signature
    //    deterministic so the agent can re-verify against a regenerated
    //    canonical body if its receiver re-stringifies first.
    //
    //    `target_url` is constructed from `scan_orders.primary_domain`. We
    //    prepend `https://` because the agent expects a URL, not a bare
    //    hostname; primary_domain is stored as a hostname per data-model.md.
    const targetUrl = `https://${order.primaryDomain}`;
    const body = {
      profile: scan.profile,
      scan_id: scan.id,
      target_url: targetUrl,
      webhook_url: `${webhookBaseUrl}/webhooks/scan-progress`,
    };
    const rawBody = JSON.stringify(body);
    const signature = hmacSha256(vps.signKey, rawBody);

    // 4. POST to the VPS.
    const url = `https://${vps.ipv4}/scan`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tensol-Signature": signature,
      },
      body: rawBody,
    });

    if (!res.ok) {
      throw new Error(
        `dispatch_scan: VPS ${vps.id} returned HTTP ${res.status} ${res.statusText}`,
      );
    }

    // 5. Audit success.
    await emitSignedAudit(
      db,
      {
        event: "decepticon_invoked",
        outcome: "success",
        ts: now(),
        scan_id: job.scan_id,
        vps_instance_id: job.vps_instance_id,
        metadata: {
          profile: scan.profile,
          target_url: targetUrl,
        },
      },
      { key: signingKey },
    );
  };
}
