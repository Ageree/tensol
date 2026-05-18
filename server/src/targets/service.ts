/**
 * T029 — Targets service.
 *
 * Three public entry points used by `routes/targets.ts` (T031):
 *   - `listForProject(db, args)` — owner-scoped read of a single project's
 *     targets. Foreign-user / unknown project → 404 (NOT empty list).
 *   - `createTarget(db, args, opts)` — guard the URL via `lib/url-guard.ts`,
 *     normalise it, insert, then emit `target_created`.
 *   - `deleteTarget(db, args, opts)` — owner-scoped delete via a project
 *     JOIN, then emit `target_deleted`.
 *
 * Ownership semantics:
 *   - All three entry points collapse "row exists but caller is foreign"
 *     into the SAME `{ ok:false, code:404 }` response as "row does not
 *     exist". Mirrors `projects/service.ts` (T028): a 403 would leak
 *     id existence, allowing project-/target-id enumeration.
 *
 * URL normalisation rules (see Target.url contract):
 *   - Host is lowercased (`Example.COM` → `example.com`).
 *   - Trailing slash on the root path (`/`) is removed
 *     (`https://example.com/` → `https://example.com`).
 *   - Path on non-root URLs and query strings are preserved verbatim
 *     (`/some/path?q=1` stays `/some/path?q=1`).
 *   - Port is preserved when present (`:443`, `:8080`, …).
 *   - IPv6 hosts keep their square brackets (matches `URL.host` shape).
 *   - All other heuristics (private-IP, localhost, unsupported scheme)
 *     are delegated to `guardTargetUrl` — we do NOT duplicate them here.
 *
 * Audit pattern (mirrors T028 / `auth/magic-link.ts`):
 *   The DB mutation happens inside `withTx`; `emitSignedAudit` runs AFTER
 *   the tx commits. Reason: `emitSignedAudit` opens its own
 *   `BEGIN IMMEDIATE` and bun:sqlite cannot nest `BEGIN`s. Trade-off
 *   documented in `projects/service.ts` (best-effort tamper-evident audit
 *   per Constitution V).
 *
 * Time injection: `opts.now` honoured for deterministic tests; falls back
 * to `lib/time.now()` in production.
 */
import { and, desc, eq } from "drizzle-orm";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import { projects as projectsTable, targets as targetsTable } from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import { guardTargetUrl } from "../lib/url-guard.ts";

/**
 * Public Target shape. Snake_case to mirror the SQL columns + OpenAPI
 * contract (`specs/001-backend-v2/contracts/openapi.yaml`).
 *
 * NOTE: The Drizzle schema (T010) does NOT carry a `hostname` or
 * `verified_method` column. We derive `hostname` from the stored `url`
 * inside `rowToTarget` so callers do not have to re-parse. If a future
 * data-model revision adds those columns, this helper is the single place
 * to update.
 */
export interface Target {
  readonly id: string;
  readonly project_id: string;
  readonly url: string;
  readonly hostname: string;
  readonly status: "unverified" | "verified" | "expired";
  readonly verified_at: number | null;
  readonly created_at: number;
}

export interface ServiceErr {
  readonly ok: false;
  readonly code: 400 | 404;
  readonly reason: string;
}

export interface ServiceOk<T> {
  readonly ok: true;
  readonly value: T;
}

export type ServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface ListArgs {
  readonly userId: string;
  readonly projectId: string;
}

export interface CreateArgs {
  readonly userId: string;
  readonly projectId: string;
  readonly url: string;
}

export interface DeleteArgs {
  readonly userId: string;
  readonly targetId: string;
}

export interface ServiceOpts {
  readonly signingKey: string;
  readonly now?: () => number;
}

/** Internal: produce a stable hostname for the public Target shape. */
function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    // The stored url passed through `guardTargetUrl`, so this branch is
    // unreachable in practice. Returning "" rather than throwing keeps
    // `listForProject` resilient to any future schema drift.
    return "";
  }
}

function rowToTarget(row: {
  id: string;
  projectId: string;
  url: string;
  status: "unverified" | "verified" | "expired";
  verifiedAt: number | null;
  createdAt: number;
}): Target {
  return {
    id: row.id,
    project_id: row.projectId,
    url: row.url,
    hostname: hostnameOf(row.url),
    status: row.status,
    verified_at: row.verifiedAt,
    created_at: row.createdAt,
  };
}

/**
 * Normalise an already-guarded `URL`:
 *   - lowercase host
 *   - drop trailing slash on the root path only (preserve other paths)
 *   - preserve port, path, query, fragment
 *
 * We rebuild the string manually rather than use `url.toString()` because
 * the WHATWG URL serialiser always re-adds `/` for an empty path, which
 * defeats the trailing-root-slash trim that the contract requires.
 */
function normaliseUrl(url: URL): string {
  const protocol = url.protocol; // includes trailing ':' (e.g. "https:")
  // `url.host` keeps the port and IPv6 brackets. Lowercase it — IPv6
  // letters and host letters are both case-insensitive.
  const host = url.host.toLowerCase();
  // Trim a lone trailing slash on root path; preserve every other path.
  const pathname = url.pathname === "/" ? "" : url.pathname;
  return `${protocol}//${host}${pathname}${url.search}${url.hash}`;
}

/**
 * List targets in `projectId`. Requires `userId` to own the project.
 *
 * Returns:
 *   - `{ ok:true, value:[...] }` newest-first when the caller owns the
 *     project (empty array if the project has no targets — NOT an error).
 *   - `{ ok:false, code:404 }` when the project does not exist OR is owned
 *     by someone else. Hide existence to prevent project-id enumeration.
 */
export async function listForProject(
  db: DB,
  args: ListArgs,
): Promise<ServiceResult<readonly Target[]>> {
  const project = db
    .select()
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.id, args.projectId),
        eq(projectsTable.userId, args.userId),
      ),
    )
    .get();

  if (!project) {
    return { ok: false, code: 404, reason: "not_found" };
  }

  const rows = db
    .select()
    .from(targetsTable)
    .where(eq(targetsTable.projectId, args.projectId))
    .orderBy(desc(targetsTable.createdAt))
    .all();

  return { ok: true, value: rows.map(rowToTarget) };
}

/**
 * Create a new target inside `args.projectId` owned by `args.userId`.
 *
 * Failure modes:
 *   - Project missing OR owned by someone else → `{ ok:false, code:404 }`.
 *   - URL rejected by `guardTargetUrl` (private IP, localhost, malformed,
 *     unsupported scheme) → `{ ok:false, code:400, reason }`.
 *
 * Side effects (happy path):
 *   - INSERT into `targets` with status="unverified", verified_at=null.
 *   - Emit `target_created` audit row with `metadata = { url:<normalised> }`.
 */
export async function createTarget(
  db: DB,
  args: CreateArgs,
  opts: ServiceOpts,
): Promise<ServiceResult<Target>> {
  // Verify project ownership FIRST. Foreign or missing → 404 (NOT 403)
  // before even parsing the URL — there's no point spending CPU on guard
  // checks for a project the caller can't see.
  const project = db
    .select()
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.id, args.projectId),
        eq(projectsTable.userId, args.userId),
      ),
    )
    .get();

  if (!project) {
    return { ok: false, code: 404, reason: "not_found" };
  }

  const guard = guardTargetUrl(args.url);
  if (!guard.ok) {
    return { ok: false, code: 400, reason: guard.reason };
  }

  const clock = opts.now ?? defaultNow;
  const createdAt = clock();
  const id = ulid(createdAt);
  const normalised = normaliseUrl(guard.url);

  await withTx(db, async (tx) => {
    tx.insert(targetsTable)
      .values({
        id,
        projectId: args.projectId,
        url: normalised,
        status: "unverified",
        verifiedAt: null,
        createdAt,
      })
      .run();
  });

  // Emit AFTER commit — see module-level comment.
  await emitSignedAudit(
    db,
    {
      event: "target_created",
      outcome: "success",
      ts: createdAt,
      user_id: args.userId,
      project_id: args.projectId,
      target_id: id,
      metadata: { url: normalised },
    },
    { key: opts.signingKey },
  );

  return {
    ok: true,
    value: {
      id,
      project_id: args.projectId,
      url: normalised,
      hostname: hostnameOf(normalised),
      status: "unverified",
      verified_at: null,
      created_at: createdAt,
    },
  };
}

/**
 * Delete a target the caller owns (via its parent project).
 *
 * Ownership boundary:
 *   - Unknown target id            → 404 not_found.
 *   - Target exists but belongs to a project owned by someone else
 *     → 404 not_found (NOT 403 — hide existence).
 *   - Target owned by caller       → DELETE + emit `target_deleted`.
 *
 * Audit row is ONLY emitted on the happy path — a failed delete must not
 * generate an audit row a probing attacker could flood the chain with.
 */
export async function deleteTarget(
  db: DB,
  args: DeleteArgs,
  opts: ServiceOpts,
): Promise<ServiceResult<{ readonly deleted: true }>> {
  const clock = opts.now ?? defaultNow;

  type TxOutcome =
    | { readonly kind: "deleted"; readonly projectId: string }
    | { readonly kind: "not_found" };

  const outcome = await withTx<TxOutcome>(db, async (tx) => {
    // JOIN to projects so the ownership check is a single round-trip.
    const row = tx
      .select({
        targetId: targetsTable.id,
        projectId: targetsTable.projectId,
        ownerUserId: projectsTable.userId,
      })
      .from(targetsTable)
      .innerJoin(projectsTable, eq(targetsTable.projectId, projectsTable.id))
      .where(eq(targetsTable.id, args.targetId))
      .get();

    if (!row) return { kind: "not_found" };
    if (row.ownerUserId !== args.userId) return { kind: "not_found" };

    tx.delete(targetsTable).where(eq(targetsTable.id, args.targetId)).run();
    return { kind: "deleted", projectId: row.projectId };
  });

  if (outcome.kind === "not_found") {
    return { ok: false, code: 404, reason: "not_found" };
  }

  await emitSignedAudit(
    db,
    {
      event: "target_deleted",
      outcome: "success",
      ts: clock(),
      user_id: args.userId,
      project_id: outcome.projectId,
      target_id: args.targetId,
      metadata: {},
    },
    { key: opts.signingKey },
  );

  return { ok: true, value: { deleted: true } };
}
