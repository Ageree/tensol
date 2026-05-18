/**
 * T043 — Findings service.
 *
 * Spec refs:
 *   - `specs/001-backend-v2/data-model.md` § findings  (table shape + indexes)
 *   - `specs/001-backend-v2/contracts/webhook.md`      (wire schema, idempotency)
 *
 * Two operations:
 *
 *   - `storeFindings({scanId, findings[]})` — bulk-insert with
 *     `INSERT ... ON CONFLICT(dedup_key) DO NOTHING`. Idempotent: duplicate
 *     callbacks from a retrying VPS agent dedupe by `${scan_id}:sha256(title)`.
 *   - `listFindings({scanId})` — fetch all findings for a scan, ordered by
 *     severity descending (critical → info), ties broken by `created_at` asc.
 *
 * Dedup formula (per data-model.md L153):
 *
 *     dedup_key = scan_id + ":" + sha256_hex(title)
 *
 * Notes on shape:
 *   - The wire-schema `Finding` (from `schemas/webhook.ts`) does NOT carry
 *     `id`, `created_at`, or `dedup_key`. We mint those server-side here.
 *   - Evidence (`{request?, response?}`) is serialized to a JSON string in
 *     `evidence_json`; absent / empty evidence stores NULL.
 *
 * Concurrency:
 *   - The whole batch runs inside `withTx` so a partial failure rolls back
 *     cleanly. SQLite's `INSERT ... ON CONFLICT DO NOTHING` reports
 *     `changes() === 0` for skipped rows; we use that to drive the
 *     inserted/skipped counters.
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
 * Persisted finding row, snake_case to match the data-model column names
 * (rather than Drizzle's camelCase $inferSelect output). This is the shape
 * downstream consumers (`GET /scans/:id/findings`, report renderer) expect.
 */
export type StoredFinding = {
  id: string;
  scan_id: string;
  dedup_key: string;
  severity: FindingSeverity;
  title: string;
  body_md: string;
  evidence_json: string | null;
  created_at: number;
};

export type StoreFindingsArgs = {
  scanId: string;
  findings: Finding[];
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
// Dedup-key helper
// ---------------------------------------------------------------------------

/**
 * Compute the canonical dedup_key for a finding.
 *
 * Formula (data-model.md L153): `${scan_id}:${sha256_hex(title)}`.
 *
 * The title is hashed verbatim — no trim, no case-fold. Whitespace
 * normalization is the agent's job; whatever the agent reports IS the
 * canonical title, and two payloads with subtly different whitespace
 * legitimately count as two findings.
 */
export function computeDedupKey(scanId: string, title: string): string {
  const hex = createHash("sha256").update(title).digest("hex");
  return `${scanId}:${hex}`;
}

// ---------------------------------------------------------------------------
// Severity ordering for listFindings
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

// ---------------------------------------------------------------------------
// storeFindings
// ---------------------------------------------------------------------------

/**
 * Bulk-insert findings for a scan with idempotent `ON CONFLICT DO NOTHING`.
 *
 * Returns:
 *   - `inserted`: count of rows actually written (changes() === 1)
 *   - `skipped`:  count of rows that hit the unique `dedup_key` index
 *   - `rows`:     the freshly-inserted rows, in the order they were inserted
 *
 * Behaviour:
 *   - Empty `findings[]` → `{inserted: 0, skipped: 0, rows: []}` with no
 *     transaction (cheap fast-path).
 *   - Each row gets a freshly-minted ULID, a server-clock `created_at`,
 *     and a computed `dedup_key`.
 *   - Evidence shape: if both `request` and `response` are omitted,
 *     `evidence_json` is NULL (not `"{}"`); otherwise the object is
 *     JSON-stringified verbatim.
 *
 * Surprise: drizzle-orm's `onConflictDoNothing()` returning behaviour with
 * bun:sqlite does not surface aggregate row counts when used in a single
 * `.values(array)` call. We therefore loop and insert one row at a time,
 * reading the `{changes, lastInsertRowid}` object that bun:sqlite's
 * `.run()` returns. This is fine because (a) the batch is bounded at 1000
 * (schema cap) and (b) the whole batch runs inside one `BEGIN IMMEDIATE`
 * so it's still a single fsync.
 */
export async function storeFindings(
  db: DB,
  args: StoreFindingsArgs,
): Promise<StoreFindingsResult> {
  const { scanId, findings } = args;
  const now = args.now ?? (() => Date.now());

  if (findings.length === 0) {
    return { inserted: 0, skipped: 0, rows: [] };
  }

  const result: StoreFindingsResult = await withTx(db, async (tx) => {
    const insertedRows: StoredFinding[] = [];
    let skipped = 0;

    for (const f of findings) {
      const id = ulid();
      const createdAt = now();
      const dedupKey = computeDedupKey(scanId, f.title);
      const evidenceJson = serialiseEvidence(f.evidence);

      // bun:sqlite's `.run()` returns `{changes, lastInsertRowid}` (this
      // surface is preserved by Drizzle's bun-sqlite adapter). When the
      // ON CONFLICT clause skips the row, `changes === 0`.
      const runResult = tx
        .insert(findingsTable)
        .values({
          id,
          scanId,
          severity: f.severity,
          title: f.title,
          bodyMd: f.body_md,
          evidenceJson,
          createdAt,
          dedupKey,
        })
        .onConflictDoNothing({ target: findingsTable.dedupKey })
        .run() as unknown as { changes: number; lastInsertRowid: number | bigint };

      if (runResult.changes === 1) {
        insertedRows.push({
          id,
          scan_id: scanId,
          dedup_key: dedupKey,
          severity: f.severity,
          title: f.title,
          body_md: f.body_md,
          evidence_json: evidenceJson,
          created_at: createdAt,
        });
      } else {
        skipped += 1;
      }
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
 * (critical → high → medium → low → info), ties broken by `created_at` asc.
 *
 * SQLite does not natively know our severity ordering — alphabetic string
 * sort would give `critical < high < info < low < medium` which is wrong.
 * We use a `CASE` expression to map each severity to its rank.
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
    WHEN 'info' THEN 4
    ELSE 5
  END`;

  const rows = db
    .select()
    .from(findingsTable)
    .where(and(eq(findingsTable.scanId, args.scanId)))
    .orderBy(severityRankSql, asc(findingsTable.createdAt))
    .all();

  return rows.map((r) => ({
    id: r.id,
    scan_id: r.scanId,
    dedup_key: r.dedupKey,
    severity: r.severity,
    title: r.title,
    body_md: r.bodyMd,
    evidence_json: r.evidenceJson,
    created_at: r.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function serialiseEvidence(
  ev: Finding["evidence"] | undefined,
): string | null {
  if (!ev) return null;
  // Both halves optional per FindingEvidenceSchema. If both omitted, treat
  // as "no evidence" (NULL) rather than storing `{}`.
  if (ev.request === undefined && ev.response === undefined) return null;
  return JSON.stringify(ev);
}
