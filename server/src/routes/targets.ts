/**
 * T030 — `/api/targets/*` routes. Closes Phase 3.2 (Projects/Targets CRUD).
 *
 * Public surface (mounted under `/api/targets` from `server.ts`):
 *   - DELETE /:id — delete a target the caller owns.
 *
 * Why this subrouter is so thin:
 *   The OpenAPI contract puts list-and-create of targets under
 *   `/api/projects/{projectId}/targets` (parent-scoped) and only DELETE
 *   under `/api/targets/{targetId}` (id-scoped because the URL alone is
 *   sufficient to locate the row). The list/create endpoints therefore
 *   live in `routes/projects.ts`; only the standalone DELETE lives here.
 *
 * Factory pattern: mirrors `routes/auth.ts` (T026) and `routes/projects.ts`
 * (this same task). Deps injected explicitly — Constitution VII.
 *
 * Status code mapping:
 *   - Service `{ok:false, code:404}` → HTTP 404 `{error: "not_found"}`.
 *   - Happy path: 204.
 *
 * Audit emission: `target_deleted` is emitted inside the service layer
 * (`targets/service.ts`). We MUST NOT re-emit at the route boundary.
 */
import { Hono } from "hono";

import {
  createRequireAuth,
  type AuthVariables,
} from "../auth/middleware.ts";
import type { DB } from "../db/client.ts";
import { now as defaultNow } from "../lib/time.ts";
import { TargetIdParamSchema } from "../schemas/targets.ts";
import { deleteTarget } from "../targets/service.ts";

export interface CreateTargetsRoutesDeps {
  readonly db: DB;
  readonly signingKey: string;
  readonly now?: () => number;
}

export function createTargetsRoutes(
  deps: CreateTargetsRoutesDeps,
): Hono<{ Variables: AuthVariables }> {
  const { db, signingKey } = deps;
  const clock = deps.now ?? defaultNow;
  const requireAuth = createRequireAuth({ db, now: clock });

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth);

  // -------------------------------------------------------------------------
  // DELETE /:id — delete target.
  // -------------------------------------------------------------------------
  app.delete("/:id", async (c) => {
    const paramParse = TargetIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) {
      // Malformed id → 404, same envelope as foreign-owned (enumeration
      // mitigation, mirrors `projects/service.ts` ownership-hiding logic).
      return c.json({ error: "not_found" }, 404);
    }

    const user = c.get("user");
    const result = await deleteTarget(
      db,
      { userId: user.id, targetId: paramParse.data.id },
      { signingKey, now: clock },
    );
    if (!result.ok) {
      return c.json({ error: result.reason }, result.code);
    }
    return c.body(null, 204);
  });

  return app;
}
