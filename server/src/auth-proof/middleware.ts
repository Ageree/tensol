/**
 * T034 — `requireAuthProof` middleware.
 *
 * Gates downstream handlers behind a target whose ownership was proven
 * within the last `VERIFIED_TTL_MS` (90 days). The middleware is a
 * factory (`createRequireAuthProof({db, now})`) for the same reasons as
 * `requireAuth` (T023): explicit DB injection keeps the hot path off the
 * config singleton (Constitution VII) and lets tests stub the clock.
 *
 * Semantics:
 *   1. Resolve target id from the path. We read `:targetId` first and
 *      fall back to `:id` so the middleware can mount under either
 *      naming convention without forcing existing routes to rename.
 *   2. Missing param → 400 (would normally be caught by route schema;
 *      defensive guard for misconfigured mounts).
 *   3. SELECT target by id. Not found → 403 `target_not_found`. We
 *      deliberately do NOT return 404 here: 403 signals "not allowed
 *      to use this target" regardless of whether the row genuinely
 *      doesn't exist or merely doesn't belong to the caller — avoids
 *      leaking target-existence to unauthenticated probes. (Ownership
 *      proper is enforced by upstream services; this layer only checks
 *      verification freshness.)
 *   4. `status !== 'verified'` → 403 `auth_proof_required` + hint.
 *   5. `verified_at IS NULL` (defensive — should never happen because
 *      verify.ts writes both fields in the same tx) → 403 stale.
 *   6. `now() - verified_at >= VERIFIED_TTL_MS` → 403 `auth_proof_stale`
 *      + hint. The boundary is inclusive on the stale side, matching
 *      `requireAuth`'s `now >= expires_at` convention.
 *   7. Otherwise bind the target row into `c.set("target", ...)` and
 *      `next()`.
 *
 * Why no ownership check here:
 *   The spec (T034) says "checking targets.status='verified' AND now -
 *   verified_at < 90 days". Ownership is the responsibility of the
 *   project/target services (T029+) and is already enforced by the
 *   route handlers that mount this middleware in composition with
 *   `requireAuth`. Keeping concerns split keeps each middleware single-
 *   purpose and easy to test.
 */
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { DB } from "../db/client.ts";
import { targets as targetsTable } from "../db/schema.ts";
import { now as defaultNow } from "../lib/time.ts";

/** 90 days in milliseconds. Exported for tests + future re-use. */
export const VERIFIED_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Public failure codes returned in the JSON envelope. */
export type AuthProofErrCode =
  | "target_not_found"
  | "auth_proof_required"
  | "auth_proof_stale";

/** Subset of the target row exposed to downstream handlers via context. */
export interface AuthProofTarget {
  readonly id: string;
  readonly project_id: string;
  readonly url: string;
  readonly status: string;
  readonly verified_at: number | null;
}

/**
 * Hono `Variables` map contribution. Mount as:
 *   `new Hono<{ Variables: AuthProofVariables }>()`
 * so `c.get("target")` type-checks.
 */
export interface AuthProofVariables {
  target: AuthProofTarget;
  [key: string]: unknown;
}

export interface CreateRequireAuthProofDeps {
  readonly db: DB;
  readonly now?: () => number;
}

interface ErrBody {
  readonly error: AuthProofErrCode;
  readonly hint?: string;
}

function err(code: AuthProofErrCode, hint?: string): ErrBody {
  return hint === undefined ? { error: code } : { error: code, hint };
}

export function createRequireAuthProof(
  deps: CreateRequireAuthProofDeps,
): MiddlewareHandler<{ Variables: AuthProofVariables }> {
  const clock = deps.now ?? defaultNow;
  const { db } = deps;

  return async (c, next) => {
    // Read either :targetId (spec-canonical) or :id (legacy/short-form).
    const targetId = c.req.param("targetId") ?? c.req.param("id");
    if (!targetId) {
      // Defensive — should never reach here if route is mounted correctly.
      return c.json(err("target_not_found"), 403);
    }

    const row = db
      .select()
      .from(targetsTable)
      .where(eq(targetsTable.id, targetId))
      .get();

    if (!row) {
      return c.json(err("target_not_found"), 403);
    }

    if (row.status !== "verified") {
      return c.json(
        err(
          "auth_proof_required",
          "Re-verify ownership of this target before continuing.",
        ),
        403,
      );
    }

    if (row.verifiedAt === null || row.verifiedAt === undefined) {
      // Inconsistent row (status=verified but no timestamp). Treat as
      // stale: we cannot prove freshness without a timestamp.
      return c.json(
        err(
          "auth_proof_stale",
          "Re-verify ownership of this target before continuing.",
        ),
        403,
      );
    }

    if (clock() - row.verifiedAt >= VERIFIED_TTL_MS) {
      return c.json(
        err(
          "auth_proof_stale",
          "Re-verify ownership of this target (proof older than 90 days).",
        ),
        403,
      );
    }

    c.set("target", {
      id: row.id,
      project_id: row.projectId,
      url: row.url,
      status: row.status,
      verified_at: row.verifiedAt,
    });
    await next();
  };
}
