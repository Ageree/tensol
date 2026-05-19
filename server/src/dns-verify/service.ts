/**
 * T034 — DNS-verify service: token generation + polling state machine.
 *
 * Sits on top of T032's pure resolver (`resolveTxtAgreed`) and adds:
 *   - token generation (`tensol-verify-<26-char-ulid>`)
 *   - per-order persistence of attempt counts + verification timestamp
 *   - signed audit emission on state change (Constitution X NON-NEGOTIABLE)
 *   - 30-min hard timeout per data-model.md E2 + spec FR-010
 *   - `TENSOL_DEV_DNS_BYPASS=true` shortcut for local end-to-end testing
 *
 * Constitution II (NON-NEGOTIABLE): scope-of-authorization. The user must
 * prove they control the primary domain before any scan launches. This
 * service is the persistent state machine that gates that proof.
 *
 * Why a separate service layer (vs. the pure resolver):
 *   - the resolver is stateless and unit-testable in isolation;
 *   - this layer owns DB writes, audit emission, and timeout semantics —
 *     all of which belong to the order's lifecycle, not to DNS itself.
 *
 * Notes on the schema:
 *   - 0010 migration has NO `dns_last_error` column. We surface the most
 *     recent error on the `lastError` field of the result so the route can
 *     show it to the user, but we do NOT persist it. The next poll will
 *     either succeed or surface the same/new error.
 *   - `dnsVerifyRequestedAt` is the timeout anchor (set when the wizard
 *     moves status from draft → dns_pending). If a caller invokes this
 *     against an order whose `dnsVerifyRequestedAt` is null, we fall back
 *     to `now()` so first-poll never instantly times out.
 */

import { eq, sql } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import { scanOrders } from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { emitSignedAudit } from "../audit/emit.ts";
import { resolveTxtAgreed } from "./resolver.ts";

/** 30-min hard cap per data-model E2 state machine + spec FR-010. */
export const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;

/** Minimum elapsed time before `TENSOL_DEV_DNS_BYPASS=true` short-circuits.
 *  Matches the brief ("auto-pass after 5 sec elapsed since started_at").
 *  Rationale for a small wait (not 0): the wizard UI shows a "checking..."
 *  state; a 0-ms bypass would flash through the state instantly and hide
 *  layout bugs in the spinner/copy block. */
export const DEV_BYPASS_MIN_ELAPSED_MS = 5_000;

/** Public shape of `checkVerification` result. `lastError` is null on the
 *  success / no-error paths; on `timeout` it is the literal string
 *  `"timeout"` so the route layer can branch on it without parsing. */
export interface CheckVerificationResult {
  readonly verified: boolean;
  readonly attempts: number;
  readonly remainingSec: number;
  readonly lastError: string | null;
}

/** DI surface for `checkVerification`. `resolver` and `now` are overridable
 *  in tests; `key` is the HMAC signing key for audit rows (caller threads
 *  the boot-time config value in, per emit.ts module-doc rationale). */
export interface CheckVerificationOpts {
  readonly key: string;
  readonly resolver?: typeof resolveTxtAgreed;
  readonly now?: () => number;
}

/**
 * Generate a per-order verification token.
 *
 * Format: `tensol-verify-<26-char-Crockford-32-ULID>`, total 40 chars.
 *
 * The token uses a fresh ULID rather than being derived from `orderId` so
 * that even if an orderId is leaked (e.g. via a 4xx response or audit
 * snippet), an attacker cannot recompute the expected DNS-TXT value. The
 * `orderId` parameter is accepted for future-proofing (per-order salting
 * or deterministic regeneration) but is intentionally unused today.
 *
 * @param _orderId reserved — see rationale above.
 */
export function generateToken(_orderId: string): string {
  return `tensol-verify-${ulid()}`;
}

interface OrderRow {
  readonly id: string;
  readonly userId: string;
  readonly primaryDomain: string;
  readonly dnsVerifyToken: string;
  readonly dnsVerifyRequestedAt: number | null;
  readonly dnsVerifiedAt: number | null;
  readonly dnsCheckAttempts: number;
}

function loadOrder(db: DB, orderId: string): OrderRow {
  const row = db
    .select({
      id: scanOrders.id,
      userId: scanOrders.userId,
      primaryDomain: scanOrders.primaryDomain,
      dnsVerifyToken: scanOrders.dnsVerifyToken,
      dnsVerifyRequestedAt: scanOrders.dnsVerifyRequestedAt,
      dnsVerifiedAt: scanOrders.dnsVerifiedAt,
      dnsCheckAttempts: scanOrders.dnsCheckAttempts,
    })
    .from(scanOrders)
    .where(eq(scanOrders.id, orderId))
    .all()[0];
  if (!row) {
    throw new Error(`checkVerification: scan_order not found: ${orderId}`);
  }
  return row;
}

/**
 * Poll the DNS resolver for the order's verification token and update
 * persistent state accordingly.
 *
 * Returns the latest verification snapshot. Idempotent on already-verified
 * orders (early return with no resolver call, no new audit row).
 *
 * State transitions emitted as signed audit:
 *   - `dns_verified` on successful TXT match (production OR dev bypass)
 *   - `dns_verify_failed` on 30-min hard timeout
 *
 * No audit row is emitted for ordinary "not yet, retry next poll" results
 * — those are recorded only as an attempt-counter increment, to keep the
 * audit chain free of poll-loop noise.
 */
export async function checkVerification(
  db: DB,
  orderId: string,
  opts: CheckVerificationOpts,
): Promise<CheckVerificationResult> {
  const now = opts.now?.() ?? Date.now();
  const row = loadOrder(db, orderId);

  // Early-return: already verified. No resolver call, no DB write, no
  // audit row — callers can poll freely.
  if (row.dnsVerifiedAt !== null) {
    return {
      verified: true,
      attempts: row.dnsCheckAttempts,
      remainingSec: 0,
      lastError: null,
    };
  }

  const started = row.dnsVerifyRequestedAt ?? now;
  const elapsedMs = now - started;
  const remainingMs = Math.max(VERIFY_TIMEOUT_MS - elapsedMs, 0);

  // Dev bypass: env=true AND ≥5s elapsed → auto-verify.
  // Strict 'true' match to avoid accidental enabling via `=1`, `=yes`, etc.
  const bypassEnabled = process.env.TENSOL_DEV_DNS_BYPASS === "true";
  if (bypassEnabled && elapsedMs >= DEV_BYPASS_MIN_ELAPSED_MS) {
    const newAttempts = row.dnsCheckAttempts + 1;
    db.update(scanOrders)
      .set({
        dnsVerifiedAt: now,
        dnsCheckAttempts: newAttempts,
        updatedAt: now,
      })
      .where(eq(scanOrders.id, orderId))
      .run();
    await emitSignedAudit(
      db,
      {
        event: "dns_verified",
        outcome: "success",
        ts: now,
        user_id: row.userId,
        metadata: {
          scan_order_id: orderId,
          mode: "dev_bypass",
          attempts: newAttempts,
        },
      },
      { key: opts.key },
    );
    return {
      verified: true,
      attempts: newAttempts,
      remainingSec: 0,
      lastError: null,
    };
  }

  // Hard timeout: 30 min from dns_verify_requested_at. Emit failure audit
  // and return without touching the resolver — there is no point checking
  // a window that has already closed.
  if (elapsedMs > VERIFY_TIMEOUT_MS) {
    await emitSignedAudit(
      db,
      {
        event: "dns_verify_failed",
        outcome: "failure",
        ts: now,
        user_id: row.userId,
        metadata: {
          scan_order_id: orderId,
          reason: "timeout",
          elapsed_ms: elapsedMs,
        },
      },
      { key: opts.key },
    );
    return {
      verified: false,
      attempts: row.dnsCheckAttempts,
      remainingSec: 0,
      lastError: "timeout",
    };
  }

  // Real DNS path. Errors from the resolver are caught and surfaced via
  // `lastError` rather than re-thrown — the route's poll loop must keep
  // running across transient DNS hiccups.
  const resolve = opts.resolver ?? resolveTxtAgreed;
  let txtRecords: readonly string[] | null = null;
  let lastError: string | null = null;
  try {
    txtRecords = await resolve(row.primaryDomain);
  } catch (e) {
    lastError = (e as Error).message;
  }

  const matched = txtRecords?.some((r) => r === row.dnsVerifyToken) ?? false;
  const newAttempts = row.dnsCheckAttempts + 1;

  if (matched) {
    db.update(scanOrders)
      .set({
        dnsVerifiedAt: now,
        dnsCheckAttempts: newAttempts,
        updatedAt: now,
      })
      .where(eq(scanOrders.id, orderId))
      .run();
    await emitSignedAudit(
      db,
      {
        event: "dns_verified",
        outcome: "success",
        ts: now,
        user_id: row.userId,
        metadata: {
          scan_order_id: orderId,
          mode: "real",
          attempts: newAttempts,
        },
      },
      { key: opts.key },
    );
    return {
      verified: true,
      attempts: newAttempts,
      remainingSec: 0,
      lastError: null,
    };
  }

  // Not yet — bump attempts, COALESCE the requested_at anchor so a manual
  // poll on a draft order doesn't permanently lose its timeout origin.
  db.update(scanOrders)
    .set({
      dnsCheckAttempts: newAttempts,
      dnsVerifyRequestedAt: sql`COALESCE(${scanOrders.dnsVerifyRequestedAt}, ${now})`,
      updatedAt: now,
    })
    .where(eq(scanOrders.id, orderId))
    .run();

  return {
    verified: false,
    attempts: newAttempts,
    remainingSec: Math.floor(remainingMs / 1000),
    lastError,
  };
}
