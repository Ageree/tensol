/**
 * T039 — Scans service.
 *
 * Three public entry points used by `routes/scans.ts` (T040):
 *   - `startScan(db, args, opts)`  — auth-proof gate, INSERT scan row, INSERT
 *     `spawn_vps` job row (same `BEGIN IMMEDIATE` tx), emit `scan_started`
 *     audit AFTER commit.
 *   - `getScan(db, args)`          — owner-scoped read via projects JOIN.
 *   - `listScans(db, args)`        — owner-scoped list, newest first.
 *
 * Why we don't use `runner.enqueue()` for the spawn_vps job:
 *   `runner.enqueue` performs a bare `db.insert(...)` (no transaction wrapper),
 *   so calling it after `withTx(...)` commits the scan row would split the
 *   pair across two commits — a crash between them would leak orphan scans.
 *   Instead we INSERT the jobs row directly inside the same `withTx` block
 *   so the pair is atomic: either both rows commit or both roll back.
 *
 * Ownership semantics:
 *   - Foreign user → 404 (NOT 403) to hide existence (matches `targets`
 *     and `projects` services).
 *   - Auth-proof failure → 403 with a code that matches `AuthProofErrCode`
 *     from `auth-proof/middleware.ts` (`auth_proof_required` vs
 *     `auth_proof_stale`). The check is inlined here rather than delegated
 *     to the middleware because the middleware is HTTP-only and we want
 *     `startScan` to be testable against a bare DB.
 *
 * Audit pattern (mirrors `projects/service.ts` + `targets/service.ts`):
 *   Mutation inside `withTx`; `emitSignedAudit` runs AFTER the tx commits.
 *   bun:sqlite cannot nest `BEGIN`s, so the audit emit must happen outside.
 *   Constitution V accepts the resulting non-atomicity (best-effort
 *   tamper-evident audit).
 *
 * Schema surprises:
 *   - `scans.started_at` is INTEGER NOT NULL per `data-model.md`
 *     ("Set when status moves to queued"). We set it to `now()` at insert
 *     even though the row is `queued`, NOT `running` — this matches the
 *     documented invariant.
 *   - `scans` has no `created_at` column; `started_at` is the only timestamp
 *     and doubles as the row's birthday for ordering.
 */
import { and, desc, eq } from "drizzle-orm";
import { emitSignedAudit } from "../audit/emit.ts";
import { VERIFIED_TTL_MS } from "../auth-proof/middleware.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  jobs as jobsTable,
  projects as projectsTable,
  scans as scansTable,
  targets as targetsTable,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import type { SpawnVpsJob } from "../jobs/types.ts";

/** Public Scan shape — snake_case to mirror SQL columns + OpenAPI. */
export interface Scan {
  readonly id: string;
  readonly user_id: string;
  readonly target_id: string;
  readonly profile: "recon" | "standard" | "max";
  readonly status: "queued" | "running" | "completed" | "failed" | "cancelled";
  readonly failure_reason: string | null;
  readonly started_at: number;
  readonly completed_at: number | null;
  readonly usage_tokens: number | null;
  readonly usage_usd_cents: number | null;
}

export interface ServiceErr {
  readonly ok: false;
  readonly code: 403 | 404;
  readonly reason: string;
}

export interface ServiceOk<T> {
  readonly ok: true;
  readonly value: T;
}

export type ServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface StartScanArgs {
  readonly userId: string;
  readonly targetId: string;
  readonly profile: "recon" | "standard" | "max";
}

export interface GetScanArgs {
  readonly userId: string;
  readonly scanId: string;
}

export interface ListScansArgs {
  readonly userId: string;
}

export interface ScanServiceOpts {
  readonly signingKey: string;
  readonly now?: () => number;
}

function rowToScan(row: {
  id: string;
  userId: string;
  targetId: string;
  profile: "recon" | "standard" | "max";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  failureReason: string | null;
  startedAt: number;
  completedAt: number | null;
  usageTokens: number | null;
  usageUsdCents: number | null;
}): Scan {
  return {
    id: row.id,
    user_id: row.userId,
    target_id: row.targetId,
    profile: row.profile,
    status: row.status,
    failure_reason: row.failureReason,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    usage_tokens: row.usageTokens,
    usage_usd_cents: row.usageUsdCents,
  };
}

/**
 * Start a new scan. Gated behind:
 *   1. Target must exist AND belong (via project) to `args.userId`. Otherwise
 *      → 404 `not_found` (hides existence).
 *   2. Target must be `status='verified'` AND `verified_at` within
 *      `VERIFIED_TTL_MS`. Otherwise → 403 with the matching code from
 *      `AuthProofErrCode` (`auth_proof_required` / `auth_proof_stale`).
 *
 * Side effects (happy path):
 *   - INSERT into `scans` (`status='queued'`, `started_at=now`).
 *   - INSERT into `jobs` (`type='spawn_vps'`, `status='pending'`,
 *     `payload_json={"type":"spawn_vps","scan_id":<id>}`).
 *   - Both INSERTs in ONE `BEGIN IMMEDIATE` tx (atomic pair).
 *   - Emit `scan_started` audit AFTER tx commit.
 */
export async function startScan(
  db: DB,
  args: StartScanArgs,
  opts: ScanServiceOpts,
): Promise<ServiceResult<Scan>> {
  const clock = opts.now ?? defaultNow;

  // Step 1: ownership-checked target lookup via projects JOIN.
  const targetRow = db
    .select({
      id: targetsTable.id,
      projectId: targetsTable.projectId,
      status: targetsTable.status,
      verifiedAt: targetsTable.verifiedAt,
      ownerUserId: projectsTable.userId,
    })
    .from(targetsTable)
    .innerJoin(projectsTable, eq(targetsTable.projectId, projectsTable.id))
    .where(eq(targetsTable.id, args.targetId))
    .get();

  if (!targetRow) {
    return { ok: false, code: 404, reason: "not_found" };
  }
  if (targetRow.ownerUserId !== args.userId) {
    // Hide existence — match projects/targets services.
    return { ok: false, code: 404, reason: "not_found" };
  }

  // Step 2: auth-proof freshness gate. Mirrors `auth-proof/middleware.ts`.
  if (targetRow.status !== "verified") {
    return { ok: false, code: 403, reason: "auth_proof_required" };
  }
  if (targetRow.verifiedAt === null || targetRow.verifiedAt === undefined) {
    // Defensive — verify.ts writes both columns together.
    return { ok: false, code: 403, reason: "auth_proof_stale" };
  }
  if (clock() - targetRow.verifiedAt >= VERIFIED_TTL_MS) {
    return { ok: false, code: 403, reason: "auth_proof_stale" };
  }

  // Step 3: atomic scan + spawn_vps job insert.
  const startedAt = clock();
  const scanId = ulid(startedAt);
  const jobId = ulid(startedAt);
  const spawnPayload: SpawnVpsJob = { type: "spawn_vps", scan_id: scanId };

  await withTx(db, async (tx) => {
    tx.insert(scansTable)
      .values({
        id: scanId,
        userId: args.userId,
        targetId: args.targetId,
        profile: args.profile,
        status: "queued",
        failureReason: null,
        startedAt,
        completedAt: null,
        usageTokens: null,
        usageUsdCents: null,
      })
      .run();

    tx.insert(jobsTable)
      .values({
        id: jobId,
        type: "spawn_vps",
        payloadJson: JSON.stringify(spawnPayload),
        status: "pending",
        scheduledAt: startedAt,
        attempts: 0,
        lastError: null,
        createdAt: startedAt,
        updatedAt: startedAt,
      })
      .run();
  });

  // Step 4: emit signed audit AFTER commit (bun:sqlite cannot nest BEGINs).
  await emitSignedAudit(
    db,
    {
      event: "scan_started",
      outcome: "success",
      ts: startedAt,
      user_id: args.userId,
      project_id: targetRow.projectId,
      target_id: args.targetId,
      scan_id: scanId,
      metadata: { profile: args.profile },
    },
    { key: opts.signingKey },
  );

  return {
    ok: true,
    value: {
      id: scanId,
      user_id: args.userId,
      target_id: args.targetId,
      profile: args.profile,
      status: "queued",
      failure_reason: null,
      started_at: startedAt,
      completed_at: null,
      usage_tokens: null,
      usage_usd_cents: null,
    },
  };
}

/**
 * Read one scan owned by `args.userId`. Foreign caller → 404
 * (hide existence). Ownership is enforced via the `projects.user_id`
 * column reachable through `scans.target_id → targets.project_id`.
 *
 * We could shortcut via the denormalised `scans.user_id`, but the JOIN
 * keeps the rule expressed at the relational boundary — if a future
 * migration ever drops the denorm column, this query still works.
 */
export async function getScan(
  db: DB,
  args: GetScanArgs,
): Promise<ServiceResult<Scan>> {
  const row = db
    .select({
      scan: scansTable,
      ownerUserId: projectsTable.userId,
    })
    .from(scansTable)
    .innerJoin(targetsTable, eq(scansTable.targetId, targetsTable.id))
    .innerJoin(projectsTable, eq(targetsTable.projectId, projectsTable.id))
    .where(eq(scansTable.id, args.scanId))
    .get();

  if (!row) {
    return { ok: false, code: 404, reason: "not_found" };
  }
  if (row.ownerUserId !== args.userId) {
    return { ok: false, code: 404, reason: "not_found" };
  }
  return { ok: true, value: rowToScan(row.scan) };
}

/**
 * List scans owned by `args.userId`, newest-first by `started_at`.
 *
 * Returns `[]` when the user has no scans (NOT an error condition).
 * Filtering on the denormalised `scans.user_id` column avoids a 2-table
 * JOIN on the hot list path; the column is populated by `startScan` so
 * this is consistent with the JOIN-based form used in `getScan`.
 */
export async function listScans(
  db: DB,
  args: ListScansArgs,
): Promise<readonly Scan[]> {
  const rows = db
    .select()
    .from(scansTable)
    .where(eq(scansTable.userId, args.userId))
    .orderBy(desc(scansTable.startedAt))
    .all();
  return rows.map(rowToScan);
}

// `and` is reserved for future filters (e.g. status-scoped list) — keep
// the import live so the eventual extension does not need a re-import.
void and;
