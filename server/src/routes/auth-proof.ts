/**
 * T035 — `/api/targets/:id/auth-proof/*` routes. Closes Phase 3.3 (auth-proof).
 *
 * Public surface (mounted under `/api/targets` from `server.ts`):
 *   - POST /:id/auth-proof/challenge — issue an ownership challenge.
 *   - POST /:id/auth-proof/verify    — verify the active challenge.
 *
 * Why this subrouter is mounted next to the existing `routes/targets.ts`:
 *   The OpenAPI contract places these endpoints under
 *   `/api/targets/{targetId}/auth-proof/*`. Hono cannot cleanly nest a
 *   separate subrouter that introduces a `:id` segment, so we mount a SECOND
 *   subrouter under `/api/targets` (alongside `createTargetsRoutes`). The two
 *   subrouters do NOT share any state — each is its own Hono instance with
 *   its own `requireAuth` middleware. Hono dispatches by full path, so the
 *   two never collide (the existing routes match `DELETE /:id`, this one
 *   matches `POST /:id/auth-proof/*`).
 *
 * Factory pattern: mirrors `routes/auth.ts` (T026) and `routes/projects.ts`
 * (T030). Deps injected explicitly — Constitution VII.
 *
 * Audit emission: `auth_proof_issued`, `auth_proof_verified`, and
 * `auth_proof_failed` are ALL emitted from inside the service layer
 * (`auth-proof/challenge.ts` T032 + `auth-proof/verify.ts` T033). We MUST
 * NOT re-emit at the route boundary.
 *
 * Status code mapping:
 *   - Issue happy path                          → 201
 *   - Verify happy path (ok=true)               → 200
 *   - Verify {ok:false, code:410, reason}       → 410 { error: reason }
 *   - Verify {ok:false, code:422, reason, ..}   → 422 { error, attempted }
 *   - Ownership / not-found / bad id            → 404 { error: "not_found" }
 *   - Unauthenticated (no cookie)               → 401 (delegated to requireAuth)
 *
 * Ownership check: a single JOIN against `projects` (mirrors the pattern in
 * `targets/service.ts::deleteTarget`). Hidden-existence rule applies — a
 * foreign target returns 404, not 403, to prevent target-id enumeration.
 */
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import {
  createRequireAuth,
  type AuthVariables,
} from "../auth/middleware.ts";
import { issueChallenge } from "../auth-proof/challenge.ts";
import {
  verifyChallenge,
  type VerifyDeps,
} from "../auth-proof/verify.ts";
import type { DB } from "../db/client.ts";
import {
  projects as projectsTable,
  targets as targetsTable,
} from "../db/schema.ts";
import { now as defaultNow } from "../lib/time.ts";
import {
  TargetIdParamSchema,
  VerifyChallengeBodySchema,
} from "../schemas/auth-proof.ts";

export interface CreateAuthProofRoutesDeps {
  readonly db: DB;
  readonly signingKey: string;
  readonly now?: () => number;
  /**
   * Injectable probe dependencies. Production callers wire to
   * `node:dns/promises.resolveTxt` + `globalThis.fetch`. Tests pass fakes.
   */
  readonly verifyDeps: VerifyDeps;
}

/**
 * Look up a target the caller owns. Returns the target row on success, `null`
 * on either "row doesn't exist" or "row owned by someone else" — the route
 * collapses both into a single 404 (enumeration mitigation, mirrors
 * `targets/service.ts::deleteTarget`).
 */
function loadOwnedTarget(
  db: DB,
  args: { userId: string; targetId: string },
): { id: string; url: string } | null {
  const row = db
    .select({
      id: targetsTable.id,
      url: targetsTable.url,
    })
    .from(targetsTable)
    .innerJoin(projectsTable, eq(targetsTable.projectId, projectsTable.id))
    .where(
      and(
        eq(targetsTable.id, args.targetId),
        eq(projectsTable.userId, args.userId),
      ),
    )
    .get();
  return row ?? null;
}

export function createAuthProofRoutes(
  deps: CreateAuthProofRoutesDeps,
): Hono<{ Variables: AuthVariables }> {
  const { db, signingKey, verifyDeps } = deps;
  const clock = deps.now ?? defaultNow;
  const requireAuth = createRequireAuth({ db, now: clock });

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth);

  // -------------------------------------------------------------------------
  // POST /:id/auth-proof/challenge — issue a fresh ownership challenge.
  // -------------------------------------------------------------------------
  app.post("/:id/auth-proof/challenge", async (c) => {
    const paramParse = TargetIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) {
      // Malformed id → 404 to stay aligned with the foreign-owned envelope.
      return c.json({ error: "not_found" }, 404);
    }

    const user = c.get("user");
    const target = loadOwnedTarget(db, {
      userId: user.id,
      targetId: paramParse.data.id,
    });
    if (!target) {
      return c.json({ error: "not_found" }, 404);
    }

    // Derive the hostname here rather than re-parsing inside the service —
    // `targets.url` was normalised by `targets/service.ts::createTarget`
    // (T029), so `new URL(...)` is safe.
    const hostname = new URL(target.url).hostname;

    const instructions = await issueChallenge(
      db,
      { targetId: target.id, hostname },
      { signingKey, now: clock },
    );
    return c.json(instructions, 201);
  });

  // -------------------------------------------------------------------------
  // POST /:id/auth-proof/verify — verify the active challenge.
  // -------------------------------------------------------------------------
  app.post("/:id/auth-proof/verify", async (c) => {
    const paramParse = TargetIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) {
      return c.json({ error: "not_found" }, 404);
    }

    // Body is optional (hint-only). `parse(undefined)` succeeds because the
    // schema is `.optional().default({})`.
    let rawBody: unknown = undefined;
    try {
      // c.req.json() throws on an empty body; gracefully fall back.
      rawBody = await c.req.json();
    } catch {
      rawBody = undefined;
    }
    const bodyParse = VerifyChallengeBodySchema.safeParse(rawBody);
    if (!bodyParse.success) {
      const issue = bodyParse.error.issues[0];
      return c.json(
        {
          error: "invalid_request",
          field: issue?.path.join(".") ?? "body",
          message: issue?.message ?? "invalid request body",
        },
        400,
      );
    }

    const user = c.get("user");
    const target = loadOwnedTarget(db, {
      userId: user.id,
      targetId: paramParse.data.id,
    });
    if (!target) {
      return c.json({ error: "not_found" }, 404);
    }

    // Build VerifyOptions WITHOUT a `preferMethod` key when the hint is
    // absent — `exactOptionalPropertyTypes` rejects `preferMethod: undefined`.
    const prefer = bodyParse.data.prefer_method;
    const result = await verifyChallenge(
      db,
      { targetId: target.id },
      verifyDeps,
      prefer === undefined
        ? { signingKey, now: clock }
        : { signingKey, now: clock, preferMethod: prefer },
    );

    if (result.ok) {
      return c.json(
        {
          verified: true as const,
          method: result.method,
          attempted: result.attempted,
        },
        200,
      );
    }

    if (result.code === 410) {
      // Body intentionally omits `attempted` because the verifier exits
      // before running probes on the 410 path.
      return c.json({ error: result.reason }, 410);
    }

    // 422 — all probes failed. Surface the probe trail so the client can
    // show which methods were tried.
    return c.json({ error: result.reason, attempted: result.attempted }, 422);
  });

  return app;
}
