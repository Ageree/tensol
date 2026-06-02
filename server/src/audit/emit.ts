/**
 * T014 — emitSignedAudit: atomic, hash-chained audit-log writer.
 *
 * One public entry point — `emitSignedAudit(db, args, opts?)` — that:
 *   1. Opens a `BEGIN IMMEDIATE` transaction via `withTx` (T011).
 *   2. Reads the previous row's `signature` (NULL if the chain is empty).
 *   3. Builds an `AuditEntry` from the caller's args + an auto-generated
 *      `id` (ULID is NOT used for the row PK — that's an autoincrement
 *      INTEGER, see below; the entry's "id" concept lives only inside the
 *      canonical message via other columns).
 *   4. Computes `signature = signEntry(key, entry, prevSig)` (T013).
 *   5. INSERTs the new row with both `signature` and `prev_signature`.
 *   6. Returns the autoincrement row id + new signature.
 *
 * Why BEGIN IMMEDIATE is load-bearing: two concurrent emits would otherwise
 * race the SELECT-then-INSERT step and both observe the same `prevSig`,
 * producing two rows that claim to chain off the same predecessor — a
 * chain fork. IMMEDIATE acquires a RESERVED lock at BEGIN, so the second
 * caller waits (with JS retry in `withTx`) until the first commits. See
 * `db/client.ts` for the retry semantics.
 *
 * SURPRISE: `audit_log.id` is INTEGER PRIMARY KEY AUTOINCREMENT — it
 * doubles as the "seq" concept in tasks.md. There is NO separate `seq`
 * column. SQLite's AUTOINCREMENT guarantees monotonic ids that never
 * decrease, even across rollbacks (rolled-back ids are skipped, which is
 * fine for an audit chain — gaps are evidence of attempted-but-aborted
 * writes, not corruption).
 *
 * Per-row metadata canonicalisation (alpha-sorted top-level keys) is
 * delegated to `canonicalMessage` inside `signEntry`. We also persist the
 * same alpha-sorted JSON into the `metadata_json` column so out-of-band
 * verifiers can reconstruct the canonical message directly from the row
 * without re-canonicalising.
 *
 * Caller must supply the signing key:
 *   - In production, server boot reads `TENSOL_AUDIT_SIGNING_KEY` from
 *     `config.getConfig()` and threads it into every emit call.
 *   - In tests, pass `opts.key` directly — this avoids polluting the
 *     module-level config singleton.
 * Falling back to `getConfig()` silently would violate Constitution VII
 * (deterministic boot, no hidden env reads in business logic).
 */
import { sql } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import { auditLog } from "../db/schema.ts";
import { now } from "../lib/time.ts";
import { signEntry, type AuditEntry } from "./sign.ts";

/**
 * Blackbox-MVP audit event-type literals (data-model.md §E8).
 *
 * Source-of-truth list of 29 event names emitted by feature 002. (F2's
 * `exploit_attempted`, like feature-001 events, is emitted via the `string`
 * `EmitArgs.event` and intentionally lives OUTSIDE this 002-spec tuple.) Existing
 * feature-001 events (e.g. `auth_login_succeeded`, `target_created`,
 * `auth_proof_verified`) are NOT included here — `EmitArgs.event` remains
 * `string` for backward-compat, so 001 callers continue to type-check.
 *
 * Why a frozen tuple AND a union: the tuple gives us a runtime-iterable
 * list (for test parity assertions, future zod schemas, observability
 * dashboards), and the union gives us a compile-time type for new call
 * sites that want strict literal narrowing via
 * `event: BlackboxAuditEvent`.
 *
 * Constitution X: this extension changes ONLY the type-side surface area.
 * The 13-field signed-message shape in `sign.ts` is UNCHANGED — `event` is
 * still column 1, still arbitrary text from the signer's perspective.
 *
 * Grouped by domain for readability (scan_order → DNS → quota → scan run
 * → finding → report → email → inquiry → webhook). Order is preserved in
 * data-model.md §E8 prose; the test pins set-equality, not ordering.
 */
export const BLACKBOX_AUDIT_EVENTS = [
  // scan_orders lifecycle (4)
  "scan_order_created",
  "scan_order_attack_surface_updated",
  "scan_order_safety_updated",
  "scan_order_launched",
  // DNS verification (3)
  "dns_verify_requested",
  "dns_verified",
  "dns_verify_failed",
  // free-quota accounting (2)
  "free_quota_consumed",
  "free_quota_refunded",
  // VM lifecycle (3)
  "vm_provisioning",
  "vm_ready",
  "vm_teardown",
  // scan run lifecycle (4) — `scan_started`/`scan_completed`/`scan_failed`/
  // `scan_cancelled` are also referenced from feature 001 reconcile loop;
  // listing them here de-duplicates the spec, not the call sites.
  "scan_started",
  "scan_completed",
  "scan_failed",
  "scan_cancelled",
  // findings (1)
  "finding_ingested",
  // PDF report rendering (3)
  "pdf_render_requested",
  "pdf_rendered",
  "pdf_render_failed",
  // email delivery (3)
  "email_send_requested",
  "email_sent",
  "email_send_failed",
  // deep-engagement inquiry (4)
  "inquiry_received",
  "inquiry_telegram_sent",
  "inquiry_telegram_failed",
  "inquiry_status_changed",
  // Decepticon webhook ingress (2)
  "webhook_received",
  "webhook_invalid_signature",
  // 004-sthrip PR-review (9)
  "github_app_installed",
  "github_app_uninstalled",
  "github_app_suspended",
  "review_repo_enabled",
  "review_repo_disabled",
  "review_settings_changed",
  "review_finding_verified",
  "review_thread_resolved",
  "review_category_suppressed",
] as const;

/** Compile-time union derived from {@link BLACKBOX_AUDIT_EVENTS}. New
 *  feature-002 callers can declare `event: BlackboxAuditEvent` for literal
 *  narrowing; legacy call sites continue to use `string` via `EmitArgs`. */
export type BlackboxAuditEvent = (typeof BLACKBOX_AUDIT_EVENTS)[number];

/** Public argument shape — snake_case field names mirror the SQL columns
 *  / data-model.md so call sites read 1:1 against the schema.
 *
 *  `event` is kept as `string` (not `BlackboxAuditEvent`) for backward-compat
 *  with feature-001 call sites that emit `auth_login_succeeded`,
 *  `target_created`, etc. Per Constitution X, the audit chain accepts any
 *  string in field 1 — the signed-message shape is what is frozen, not the
 *  enum membership. */
export interface EmitArgs {
  readonly event: string;
  readonly outcome: "success" | "failure" | "rejected";
  readonly ts?: number;
  readonly user_id?: string | null;
  readonly project_id?: string | null;
  readonly target_id?: string | null;
  readonly scan_id?: string | null;
  readonly vps_instance_id?: string | null;
  readonly auth_proof_id?: string | null;
  readonly finding_id?: string | null;
  readonly severity?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface EmitResult {
  readonly id: number;
  readonly signature: string;
}

export interface EmitOptions {
  /** Override the signing key (tests). Production callers should thread
   *  `config.TENSOL_AUDIT_SIGNING_KEY` in explicitly. */
  readonly key?: string;
}

/** Alpha-sort top-level keys to match the canonicalisation inside
 *  `canonicalMessage`. We store the same string in `metadata_json` so the
 *  row + signature triple is self-verifiable without re-sorting. */
function canonicaliseMetadata(m: Record<string, unknown>): string {
  if (!m || Object.keys(m).length === 0) return "{}";
  const sortedKeys = Object.keys(m).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) sorted[k] = m[k];
  return JSON.stringify(sorted);
}

/**
 * Atomically append a signed row to `audit_log`.
 *
 * Throws if `opts.key` is missing — callers MUST supply the signing key
 * explicitly (see module-level comment for rationale).
 *
 * Returns the autoincrement `id` (== seq) and the new row's `signature`.
 * Inside one transaction:
 *   BEGIN IMMEDIATE → SELECT prev → compute sig → INSERT → COMMIT.
 */
export async function emitSignedAudit(
  db: DB,
  args: EmitArgs,
  opts?: EmitOptions,
): Promise<EmitResult> {
  const key = opts?.key;
  if (!key) {
    throw new Error(
      "emitSignedAudit: signing key is required (pass opts.key)",
    );
  }

  const metadata = args.metadata ?? {};
  const ts = args.ts ?? now();

  const entry: AuditEntry = {
    event: args.event,
    ts,
    userId: args.user_id ?? null,
    projectId: args.project_id ?? null,
    targetId: args.target_id ?? null,
    scanId: args.scan_id ?? null,
    vpsInstanceId: args.vps_instance_id ?? null,
    authProofId: args.auth_proof_id ?? null,
    findingId: args.finding_id ?? null,
    severity: args.severity ?? null,
    outcome: args.outcome,
    metadataJson: metadata,
  };

  return await withTx(db, async (tx) => {
    // Read the latest row's signature. `id DESC LIMIT 1` is O(log N) via
    // the integer PK btree. We deliberately use raw SQL rather than a
    // Drizzle query builder for two reasons:
    //   1. The query is trivial and the raw form is unambiguous.
    //   2. `tx.select(...)` would also work, but driving directly through
    //      `tx.$client.prepare` would mean an extra abstraction layer
    //      while we already hold the Drizzle Tx handle.
    const prevRow = tx
      .select({ signature: auditLog.signature })
      .from(auditLog)
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1)
      .get();
    const prevSig = prevRow?.signature ?? null;

    const signature = signEntry(key, entry, prevSig);
    const metadataJson = canonicaliseMetadata(metadata);

    const inserted = tx
      .insert(auditLog)
      .values({
        ts: entry.ts,
        event: entry.event,
        userId: entry.userId,
        projectId: entry.projectId,
        targetId: entry.targetId,
        scanId: entry.scanId,
        vpsInstanceId: entry.vpsInstanceId,
        authProofId: entry.authProofId,
        findingId: entry.findingId,
        severity: entry.severity,
        outcome: entry.outcome,
        metadataJson,
        prevSignature: prevSig ?? "",
        signature,
      })
      .returning({ id: auditLog.id })
      .get();

    if (!inserted) {
      // SQLite always returns the RETURNING row on a successful INSERT;
      // a missing row would mean Drizzle silently dropped it. Fail loud
      // so the surprise surfaces in tests rather than later in chain
      // verification.
      throw new Error("emitSignedAudit: INSERT did not return id");
    }

    return { id: inserted.id, signature };
  });
}
