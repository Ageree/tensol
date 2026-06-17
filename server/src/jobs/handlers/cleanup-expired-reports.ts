/**
 * T114 — `cleanup_expired_reports` periodic handler.
 *
 * Style: cron-style sweeper, NOT an event-driven job-payload handler. The
 * jobs runner (T066) invokes this on a wall-clock cadence (daily per
 * `specs/002-blackbox-mvp/tasks.md` T127), passing no payload — the handler
 * introspects the `evidence_artifacts` + `reports` tables directly.
 *
 * Lifecycle (per task brief + data-model E9/E10):
 *   1. Find expired rows:
 *        - `evidence_artifacts` WHERE expires_at < now, LIMIT batch
 *        - `reports`            WHERE expires_at < now AND bucket IS NOT NULL
 *                                                       AND key    IS NOT NULL,
 *          LIMIT (batch - already-collected)
 *      Combined batch size is capped at `PRUNE_BATCH_SIZE` so a single tick
 *      cannot monopolise the runner. Reports with NULL bucket/key are
 *      excluded — there's nothing in Object Storage to delete; we let those
 *      rows be cleaned up by their owning scan's lifecycle.
 *   2. For each expired row, in any order:
 *        a) call `storage.deleteObject({bucket, key})`
 *        b) if it succeeds → DELETE the row + emit signed audit
 *           (`evidence_pruned` / `report_pruned`) AFTER the DELETE tx commits
 *           (Constitution X: post-commit audit).
 *        c) if it fails    → log the error, increment `errors`, leave the
 *           row in place. The next tick will retry.
 *
 * Why audit event names are NOT in BLACKBOX_AUDIT_EVENTS:
 *   `BLACKBOX_AUDIT_EVENTS` is a TypeScript-side enum surface for new
 *   call sites that want literal narrowing; the SQL `audit_log.event`
 *   column is plain TEXT and accepts arbitrary strings. We add
 *   `evidence_pruned` / `report_pruned` here without extending the enum,
 *   matching the same precedent as `scan_failed` + metadata.reason='scan_timeout'
 *   substitution in T064/scan-timeout-watcher.
 *
 * Why audit emit is post-commit (not inside withTx):
 *   `emitSignedAudit` opens its own `BEGIN IMMEDIATE`. bun:sqlite does not
 *   support nested transactions. Per Constitution X, audit always emits
 *   AFTER the controlling tx commits.
 *
 * Return value: `{ processed, deleted, errors }` for observability.
 *   - `processed` = total rows the handler attempted to prune (succ + fail)
 *   - `deleted`   = rows whose object delete + row DELETE both succeeded
 *   - `errors`    = rows whose object delete threw (row left in place for retry)
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";

import type { DB } from "../../db/client.ts";
import { withTx } from "../../db/client.ts";
import {
  evidenceArtifacts as evidenceArtifactsTable,
  reports as reportsTable,
} from "../../db/schema.ts";
import { now as defaultNow } from "../../lib/time.ts";
import { emitSignedAudit } from "../../audit/emit.ts";

/** Hard cap on rows processed per tick. Keeps a single tick bounded. */
export const PRUNE_BATCH_SIZE = 100;

export interface CleanupExpiredStorageClient {
  deleteObject(cmd: {
    bucket: string;
    key: string;
  }): Promise<unknown>;
}

export interface CleanupExpiredReportsDeps {
  readonly db: DB;
  readonly storage: CleanupExpiredStorageClient;
  /** Default bucket for `evidence_artifacts` — used when row.bucket is the
   *  short alias and the canonical Object Storage bucket lives in env. The
   *  row's `bucket` column overrides this. */
  readonly bucket: string;
  readonly auditKey: string;
  readonly now?: () => number;
  /** Override batch size (testing only). */
  readonly batchSize?: number;
}

export interface CleanupExpiredReportsHandler {
  /**
   * Run one sweep over `evidence_artifacts` + `reports` (where eligible).
   * @param currentNow optional wall-clock override; defaults to `deps.now()`.
   * @returns `{processed, deleted, errors}`.
   */
  tick(currentNow?: number): Promise<{
    processed: number;
    deleted: number;
    errors: number;
  }>;
}

/** Internal representation of a row to prune; unified across both tables. */
interface PruneCandidate {
  readonly kind: "evidence" | "report";
  readonly id: string;
  readonly scanId: string;
  readonly bucket: string;
  readonly key: string;
}

/**
 * Build a `cleanup_expired_reports` handle closing over the injected deps.
 */
export function createCleanupExpiredReportsHandler(
  deps: CleanupExpiredReportsDeps,
): CleanupExpiredReportsHandler {
  const {
    db,
    storage,
    bucket: defaultBucket,
    auditKey,
    now = defaultNow,
    batchSize = PRUNE_BATCH_SIZE,
  } = deps;

  return {
    async tick(currentNow?: number) {
      const ts = currentNow ?? now();
      const candidates = collectCandidates(db, ts, batchSize);

      if (candidates.length === 0) {
        return { processed: 0, deleted: 0, errors: 0 };
      }

      let deleted = 0;
      let errors = 0;

      for (const c of candidates) {
        const ok = await pruneOne({
          db,
          storage,
          defaultBucket,
          auditKey,
          ts,
          candidate: c,
        });
        if (ok) {
          deleted += 1;
        } else {
          errors += 1;
        }
      }

      return {
        processed: candidates.length,
        deleted,
        errors,
      };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Internals — query + per-row processing.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Collect up to `batchSize` candidates across both tables. We query evidence
 * first because it's the higher-volume table; if it doesn't fill the batch we
 * top up from `reports`. Both queries use `expires_at < now` and the indexed
 * `expires_at` columns.
 *
 * Reports must have non-null bucket + key — a pending-status report has
 * NULL columns and nothing for us to delete in Object Storage; its row will
 * vanish with its scan if the user cascades the deletion.
 */
function collectCandidates(
  db: DB,
  ts: number,
  batchSize: number,
): PruneCandidate[] {
  const evidenceRows = db
    .select({
      id: evidenceArtifactsTable.id,
      scanId: evidenceArtifactsTable.scanId,
      bucket: evidenceArtifactsTable.bucket,
      key: evidenceArtifactsTable.key,
    })
    .from(evidenceArtifactsTable)
    .where(lt(evidenceArtifactsTable.expiresAt, ts))
    .limit(batchSize)
    .all();

  const candidates: PruneCandidate[] = evidenceRows.map((r) => ({
    kind: "evidence" as const,
    id: r.id,
    scanId: r.scanId,
    bucket: r.bucket,
    key: r.key,
  }));

  const remaining = batchSize - candidates.length;
  if (remaining <= 0) {
    return candidates;
  }

  const reportRows = db
    .select({
      id: reportsTable.id,
      scanId: reportsTable.scanId,
      bucket: reportsTable.bucket,
      key: reportsTable.key,
    })
    .from(reportsTable)
    .where(
      and(
        lt(reportsTable.expiresAt, ts),
        isNotNull(reportsTable.bucket),
        isNotNull(reportsTable.key),
      ),
    )
    .limit(remaining)
    .all();

  for (const r of reportRows) {
    // bucket/key are nullable in schema but the WHERE clause excludes NULLs;
    // the `as string` narrows safely.
    candidates.push({
      kind: "report" as const,
      id: r.id,
      scanId: r.scanId,
      bucket: r.bucket as string,
      key: r.key as string,
    });
  }

  return candidates;
}

interface PruneOneArgs {
  readonly db: DB;
  readonly storage: CleanupExpiredStorageClient;
  readonly defaultBucket: string;
  readonly auditKey: string;
  readonly ts: number;
  readonly candidate: PruneCandidate;
}

/**
 * Delete a single candidate. Returns true on success, false on storage failure.
 *
 * Flow:
 *   1. Object delete (the slow / failable I/O happens FIRST so we never
 *      leave an orphan object behind a deleted row).
 *   2. DELETE row in a tx.
 *   3. Emit `evidence_pruned` / `report_pruned` audit AFTER tx commits.
 *
 * Storage throws → caller counts as error, row left in place for next-tick retry.
 */
async function pruneOne(args: PruneOneArgs): Promise<boolean> {
  const { db, storage, defaultBucket, auditKey, ts, candidate } = args;

  // Row-level bucket overrides the default; default applies if a legacy row
  // wrote an empty string (shouldn't happen per schema, but defensive).
  const bucket = candidate.bucket || defaultBucket;

  try {
    await storage.deleteObject({ bucket, key: candidate.key });
  } catch (err) {
    // Storage failure: leave the row in place; logging surface deferred to caller.
    // We intentionally do NOT emit a failure audit because the user did not
    // ask for the prune — this is a backend hygiene op. A failed storage call is
    // an operational error, not a security event.
    void err;
    return false;
  }

  // Object delete succeeded. Now DELETE the row.
  await withTx(db, async (tx) => {
    if (candidate.kind === "evidence") {
      tx.delete(evidenceArtifactsTable)
        .where(eq(evidenceArtifactsTable.id, candidate.id))
        .run();
    } else {
      tx.delete(reportsTable)
        .where(eq(reportsTable.id, candidate.id))
        .run();
    }
  });

  // Post-commit audit (Constitution X).
  await emitSignedAudit(
    db,
    {
      event: candidate.kind === "evidence" ? "evidence_pruned" : "report_pruned",
      outcome: "success",
      ts,
      scan_id: candidate.scanId,
      metadata: {
        artifact_id: candidate.id,
        bucket,
        key: candidate.key,
      },
    },
    { key: auditKey },
  );

  return true;
}
