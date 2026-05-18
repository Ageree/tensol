/**
 * T028 — Projects service.
 *
 * Three public entry points used by `routes/projects.ts` (T030):
 *   - `listForUser(db, userId)` — owner-scoped read, newest first.
 *   - `create(db, args, opts)` — insert a row, then emit `project_created`.
 *   - `deleteProject(db, args, opts)` — owner-scoped delete with FK CASCADE
 *     to `targets`, then emit `project_deleted`.
 *
 * Ownership semantics:
 *   - `listForUser` filters strictly on `user_id` — there is no admin or
 *     cross-tenant code path. Callers that need different scope must build
 *     a separate query.
 *   - `deleteProject` collapses both "row does not exist" and "row exists
 *     but belongs to someone else" into the SAME `{ok:false, code:404}`
 *     response. This is a deliberate enumeration-mitigation: returning 403
 *     for a foreign-owned id would let an attacker probe project-id space
 *     to learn which ids are taken.
 *
 * Audit pattern (mirrors `auth/magic-link.ts`):
 *   The DB mutation happens inside `withTx`; the `emitSignedAudit` call
 *   runs AFTER the tx commits. Reason: `emitSignedAudit` opens its own
 *   `BEGIN IMMEDIATE` and bun:sqlite cannot nest `BEGIN`s. The mutation
 *   row + audit row are NOT atomic with each other, but failure modes are
 *   bounded:
 *     - Crash between mutation commit and audit emit → row exists without
 *       audit. The verify-chain CLI (T015) cannot detect this, but the
 *       chain itself stays linked. Acceptable per Constitution V (audit
 *       is best-effort tamper-evident, not synchronous data integrity).
 *     - Audit emit failure → the surface error bubbles up; callers see a
 *       5xx and can retry the entire operation.
 *
 * Time injection: `opts.now` is honoured for deterministic tests. The
 * helper falls back to `lib/time.now()` for production callers.
 */
import { desc, eq } from "drizzle-orm";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import { projects as projectsTable } from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";

/**
 * Public Project shape (snake_case to match data-model.md / OpenAPI).
 *
 * Note: the DB column is `user_id`, but at the public boundary we call it
 * `owner_user_id` (matches the OpenAPI contract — see
 * `specs/001-backend-v2/contracts/openapi.yaml`).
 */
export interface Project {
  readonly id: string;
  readonly owner_user_id: string;
  readonly name: string;
  readonly created_at: number;
}

export interface ServiceErr {
  readonly ok: false;
  readonly code: 404 | 403;
  readonly reason: string;
}

export interface ServiceOk<T> {
  readonly ok: true;
  readonly value: T;
}

export type ServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface CreateArgs {
  readonly userId: string;
  readonly name: string;
}

export interface DeleteArgs {
  readonly userId: string;
  readonly projectId: string;
}

export interface ServiceOpts {
  readonly signingKey: string;
  readonly now?: () => number;
}

/** Internal helper: convert a row from the `projects` table into the public
 *  `Project` shape. Centralised so the column-vs-API rename
 *  (`user_id` → `owner_user_id`) only lives in one place. */
function rowToProject(row: {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
}): Project {
  return {
    id: row.id,
    owner_user_id: row.userId,
    name: row.name,
    created_at: row.createdAt,
  };
}

/**
 * List projects owned by `userId`, newest first.
 *
 * Returns `[]` when the user has no projects (NOT an error condition).
 */
export async function listForUser(
  db: DB,
  userId: string,
): Promise<readonly Project[]> {
  const rows = db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId))
    .orderBy(desc(projectsTable.createdAt))
    .all();
  return rows.map(rowToProject);
}

/**
 * Create a new project owned by `args.userId`.
 *
 * Side effects:
 *   - INSERT into `projects` (id = fresh ULID).
 *   - Emit `project_created` audit row with `metadata = { name }`.
 *
 * Returns the new `Project` value. Throws on DB errors (FK violation,
 * I/O failure, etc.) — Zod-level validation of `args.name` is the caller's
 * responsibility (see `schemas/projects.ts` for the boundary schema).
 */
export async function create(
  db: DB,
  args: CreateArgs,
  opts: ServiceOpts,
): Promise<Project> {
  const clock = opts.now ?? defaultNow;
  const createdAt = clock();
  const id = ulid(createdAt);

  await withTx(db, async (tx) => {
    tx.insert(projectsTable)
      .values({
        id,
        userId: args.userId,
        name: args.name,
        createdAt,
      })
      .run();
  });

  // Emit audit AFTER the insert tx commits — see module-level comment.
  await emitSignedAudit(
    db,
    {
      event: "project_created",
      outcome: "success",
      ts: createdAt,
      user_id: args.userId,
      project_id: id,
      metadata: { name: args.name },
    },
    { key: opts.signingKey },
  );

  return {
    id,
    owner_user_id: args.userId,
    name: args.name,
    created_at: createdAt,
  };
}

/**
 * Delete a project that the caller owns. Cascades to `targets` via the
 * `targets.project_id` FK with `ON DELETE CASCADE` (relies on
 * `PRAGMA foreign_keys = ON` set by `createDb`).
 *
 * Ownership boundary:
 *   - Unknown id        → `{ ok:false, code:404, reason:"not_found" }`.
 *   - Owned by someone  → `{ ok:false, code:404, reason:"not_found" }`
 *     else              (NOT 403 — see module-level note on enumeration).
 *   - Owned by caller   → DELETE inside tx, emit `project_deleted` audit,
 *                         return `{ ok:true, value:{ deleted:true } }`.
 *
 * The audit row is ONLY emitted on the happy path: a failed delete must
 * not generate an audit row a probing attacker could try to flood.
 */
export async function deleteProject(
  db: DB,
  args: DeleteArgs,
  opts: ServiceOpts,
): Promise<ServiceResult<{ readonly deleted: true }>> {
  const clock = opts.now ?? defaultNow;

  // Outcome of the transactional ownership check + delete. The `kind`
  // discriminator drives the post-commit audit emission below.
  type TxOutcome =
    | { readonly kind: "deleted" }
    | { readonly kind: "not_found" };

  const outcome = await withTx<TxOutcome>(db, async (tx) => {
    const row = tx
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, args.projectId))
      .get();

    if (!row) return { kind: "not_found" };
    // Hide existence from a foreign owner — collapse 403 into 404 to
    // prevent project-id enumeration.
    if (row.userId !== args.userId) return { kind: "not_found" };

    tx.delete(projectsTable).where(eq(projectsTable.id, args.projectId)).run();
    return { kind: "deleted" };
  });

  if (outcome.kind === "not_found") {
    // No audit row on the failure path — see module-level comment.
    return { ok: false, code: 404, reason: "not_found" };
  }

  // Emit audit AFTER the delete tx commits.
  await emitSignedAudit(
    db,
    {
      event: "project_deleted",
      outcome: "success",
      ts: clock(),
      user_id: args.userId,
      project_id: args.projectId,
      metadata: {},
    },
    { key: opts.signingKey },
  );

  return { ok: true, value: { deleted: true } };
}
