/**
 * T043 — Findings service (compatibility shim).
 *
 * Originally written against the **001-backend-v2** `findings` table shape
 * (8 columns including `dedup_key` and `evidence_json`). Migration 0010
 * (blackbox MVP) dropped that stub table and re-created `findings` with the
 * full E5 18-column shape used by the V2 webhook (`webhooks-scan-complete.ts`
 * + `findings/ingest.ts`).
 *
 * The V1 webhook (`/api/webhooks/scan-progress`) still uses this module
 * because it is the only path the vps-agent actually hits today (the V2
 * webhook is wired but vps-agent never POSTs to it — see
 * `server/src/jobs/handlers/spawn-scan-vm.ts` line 426). To keep the V1
 * path alive without losing data, `storeFindings` now writes into the
 * current 18-column schema while preserving its old call signature.
 *
 * Translation rules:
 *   - severity `info` (V1 wire enum)  → `informational` (DB CHECK enum)
 *   - external_id   → first 32 hex chars of `sha256(title)` — stable per
 *     (scan_id, title) so retries from the agent dedupe naturally.
 *   - target        → callers pass `target` (typically the scan_order's
 *     `primaryDomain`); empty string is allowed for diag findings.
 *   - cwe/mitre/evidence_keys JSON  → empty array defaults.
 *   - raw_yaml_json → JSON snapshot of `{severity, title, evidence?}` so
 *     the report renderer has SOMETHING to chew on even though the V1
 *     wire shape doesn't carry frontmatter.
 *
 * Idempotency: a duplicate webhook (same scan_id + identical title) is
 * detected via the deterministic `external_id` (sha256 of title). We do
 * a cheap SELECT-then-INSERT inside the per-row tx; race window is one
 * webhook delivery and acceptable for v1.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import { findings as findingsTable } from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import type { Finding, FindingSeverity } from "../schemas/webhook.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The DB-level severity enum (post-0010). Note the V1 wire enum uses
 * `info`; we translate `info` → `informational` at write time.
 */
type DbSeverity = "critical" | "high" | "medium" | "low" | "informational";

/**
 * Slim row returned to V1 callers (matches the legacy shape — id, title,
 * severity, etc.). NOTE the legacy `dedup_key` and `evidence_json` columns
 * are GONE from the schema; we return synthetic values so older callers
 * compile, but they map to the new columns under the hood.
 */
export type StoredFinding = {
  id: string;
  scan_id: string;
  /** Deterministic per (scan_id, title); replaces dropped dedup_key column. */
  dedup_key: string;
  severity: FindingSeverity;
  title: string;
  body_md: string;
  /** Always null in the new schema — kept for type compatibility. */
  evidence_json: string | null;
  created_at: number;
};

export type StoreFindingsArgs = {
  scanId: string;
  findings: Finding[];
  /**
   * Default target for findings that don't carry an `affected_target`
   * (V1 wire schema has no such field). The V1 webhook handler passes
   * the scan_order's `primaryDomain` here.
   *
   * Optional for backward-compat with the old test surface; falls back
   * to the empty string when omitted.
   */
  target?: string;
  /** Clock injection — defaults to `Date.now`. Tests use a frozen clock. */
  now?: () => number;
};

export type StoreFindingsResult = {
  inserted: number;
  skipped: number;
  /** Only the rows that were actually inserted in this call. */
  rows: StoredFinding[];
};

export type ListFindingsArgs = {
  scanId: string;
};

// ---------------------------------------------------------------------------
// External-id (dedup) helper
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic external_id from the title.
 *
 * Replaces the dropped `dedup_key` column. Two findings with identical
 * titles will collide on `(scan_id, external_id)`, which our pre-INSERT
 * SELECT uses to skip the duplicate.
 *
 * Length 32 hex chars (= 128 bits) is plenty to avoid accidental
 * collisions while staying well under typical text-column page limits.
 */
export function computeExternalId(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 32);
}

/**
 * Legacy export — kept so older imports compile. Returns the same
 * `${scan_id}:sha256(title)` shape used by the dropped dedup_key column.
 */
export function computeDedupKey(scanId: string, title: string): string {
  const hex = createHash("sha256").update(title).digest("hex");
  return `${scanId}:${hex}`;
}

// ---------------------------------------------------------------------------
// Severity translation
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<DbSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

/**
 * Map the V1 wire severity (`info`) onto the DB CHECK enum
 * (`informational`). All other values pass through unchanged.
 */
function toDbSeverity(s: FindingSeverity): DbSeverity {
  return s === "info" ? "informational" : (s as DbSeverity);
}

/**
 * Map the DB severity back onto the V1 wire enum for the return shape.
 * `informational` → `info`; everything else passes through.
 */
function toWireSeverity(s: DbSeverity): FindingSeverity {
  return s === "informational" ? "info" : (s as FindingSeverity);
}

// ---------------------------------------------------------------------------
// storeFindings
// ---------------------------------------------------------------------------

/**
 * Bulk-insert findings for a scan into the post-0010 18-column `findings`
 * table.
 *
 * Returns:
 *   - `inserted`: count of rows actually written
 *   - `skipped`:  count of rows that hit the (scan_id, external_id) dedup
 *   - `rows`:     the freshly-inserted rows in insertion order
 *
 * Behaviour:
 *   - Empty `findings[]` → `{inserted: 0, skipped: 0, rows: []}` (fast path).
 *   - Each row gets a freshly-minted ULID, a server-clock `created_at`,
 *     and a deterministic `external_id` (sha256 prefix of the title).
 *   - Severity `info` is translated to `informational` to satisfy the
 *     post-0010 CHECK constraint.
 *   - All NOT NULL columns are populated with sensible defaults; the
 *     raw evidence object is stashed under `raw_yaml_json` so the
 *     report renderer can still surface it.
 */
export async function storeFindings(
  db: DB,
  args: StoreFindingsArgs,
): Promise<StoreFindingsResult> {
  const { scanId, findings } = args;
  const now = args.now ?? (() => Date.now());
  const target = args.target ?? "";

  if (findings.length === 0) {
    return { inserted: 0, skipped: 0, rows: [] };
  }

  const result: StoreFindingsResult = await withTx(db, async (tx) => {
    const insertedRows: StoredFinding[] = [];
    let skipped = 0;

    for (const f of findings) {
      const externalId = computeExternalId(f.title);

      // Dedup probe: skip if a row with (scan_id, external_id) already
      // exists. This replaces the dropped UNIQUE(dedup_key) index.
      const existing = tx
        .select({ id: findingsTable.id })
        .from(findingsTable)
        .where(
          and(
            eq(findingsTable.scanId, scanId),
            eq(findingsTable.externalId, externalId),
          ),
        )
        .limit(1)
        .get();

      if (existing) {
        skipped += 1;
        continue;
      }

      const id = ulid();
      const createdAt = now();
      const dbSeverity = toDbSeverity(f.severity);

      // Build a forward-compat snapshot of the V1 wire payload so the
      // report renderer + downstream listers can reconstruct the full
      // finding even though the V1 wire shape lacks frontmatter.
      const rawYamlJson = JSON.stringify({
        severity: dbSeverity,
        title: f.title,
        ...(f.evidence ? { evidence: f.evidence } : {}),
      });

      // Surface which evidence halves were provided for analytics
      // without storing the (potentially huge) bodies a second time.
      const evidenceKeys: string[] = [];
      if (f.evidence?.request !== undefined) evidenceKeys.push("request");
      if (f.evidence?.response !== undefined) evidenceKeys.push("response");

      tx.insert(findingsTable)
        .values({
          id,
          scanId,
          externalId,
          severity: dbSeverity,
          title: f.title,
          target,
          cvssScore: null,
          cvssVector: null,
          cvssVersion: null,
          cweJson: "[]",
          mitreJson: "[]",
          confidence: null,
          phase: null,
          agent: null,
          bodyMd: f.body_md,
          rawYamlJson,
          evidenceKeysJson: JSON.stringify(evidenceKeys),
          discoveredAt: null,
          createdAt,
        })
        .run();

      insertedRows.push({
        id,
        scan_id: scanId,
        dedup_key: computeDedupKey(scanId, f.title),
        severity: f.severity,
        title: f.title,
        body_md: f.body_md,
        evidence_json: null,
        created_at: createdAt,
      });
    }

    return {
      inserted: insertedRows.length,
      skipped,
      rows: insertedRows,
    };
  });

  return result;
}

// ---------------------------------------------------------------------------
// listFindings
// ---------------------------------------------------------------------------

/**
 * Fetch all findings for a scan, ordered by severity descending
 * (critical → informational), ties broken by `created_at` asc.
 */
export async function listFindings(
  db: DB,
  args: ListFindingsArgs,
): Promise<StoredFinding[]> {
  const severityRankSql = sql`CASE ${findingsTable.severity}
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
    WHEN 'informational' THEN 4
    ELSE 5
  END`;

  const rows = db
    .select()
    .from(findingsTable)
    .where(and(eq(findingsTable.scanId, args.scanId)))
    .orderBy(severityRankSql, asc(findingsTable.createdAt))
    .all();

  // Silence "unused" lint warning on the rank table — it documents the
  // intended ordering even though we run the rank via raw SQL above.
  void SEVERITY_RANK;

  return rows.map((r) => ({
    id: r.id,
    scan_id: r.scanId,
    dedup_key: computeDedupKey(r.scanId, r.title),
    severity: toWireSeverity(r.severity as DbSeverity),
    title: r.title,
    body_md: r.bodyMd,
    evidence_json: null,
    created_at: r.createdAt,
  }));
}
