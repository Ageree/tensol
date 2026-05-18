/**
 * T030 — `/api/projects/*` routes. Closes Phase 3.2 (Projects/Targets CRUD).
 *
 * Public surface (mounted under `/api/projects` from `server.ts`):
 *   - GET    /                       — list caller's projects.
 *   - POST   /                       — body `{name}` → create.
 *   - DELETE /:id                    — delete (cascades to targets).
 *   - GET    /:projectId/targets     — list targets for one project.
 *   - POST   /:projectId/targets     — body `{url}` → create target.
 *
 * Why nested-targets live here:
 *   The OpenAPI contract uses `/api/projects/{projectId}/targets` for both
 *   GET and POST on targets. A separate `routes/targets.ts` subrouter would
 *   need its own `:projectId` segment, which Hono cannot express cleanly
 *   when the parent mount point is `/api/targets`. Co-locating the nested
 *   target endpoints inside the projects subrouter keeps mounting trivial:
 *     app.route("/api/projects", createProjectsRoutes(...));
 *     app.route("/api/targets",  createTargetsRoutes(...));   // DELETE only
 *
 * Factory pattern: mirrors `routes/auth.ts` (T026). All deps thread through
 * `deps` rather than reading a module-level singleton — Constitution VII.
 *
 * Auth-gating: every endpoint is owner-scoped, so `requireAuth` is mounted
 * on `*` at the subrouter level (vs. per-route in `auth.ts` where some
 * endpoints are public). Inside handlers we read `c.get("user")` to fetch
 * the bound identity.
 *
 * Status code mapping (kept aligned with service-layer contracts in
 * `projects/service.ts` T028 + `targets/service.ts` T029):
 *   - Service `{ok:false, code:404}` → HTTP 404 `{error: "not_found"}`.
 *   - Service `{ok:false, code:400, reason}` → HTTP 400 `{error: reason}`.
 *   - Project happy paths: 201 (create), 200 (list), 204 (delete).
 *   - Target happy paths: 201 (create), 200 (list).
 *
 * Audit emission: ALL of `project_created`, `project_deleted`,
 * `target_created`, `target_deleted` are emitted from inside the service
 * layer. We MUST NOT re-emit at the route boundary — doing so would create
 * duplicate signed chain rows.
 */
import { Hono } from "hono";

import {
  createRequireAuth,
  type AuthVariables,
} from "../auth/middleware.ts";
import type { DB } from "../db/client.ts";
import { now as defaultNow } from "../lib/time.ts";
import { CreateProjectBodySchema, ProjectIdParamSchema } from "../schemas/projects.ts";
import { CreateTargetBodySchema } from "../schemas/targets.ts";
import {
  create as createProject,
  deleteProject,
  listForUser,
} from "../projects/service.ts";
import {
  createTarget,
  listForProject,
} from "../targets/service.ts";

export interface CreateProjectsRoutesDeps {
  readonly db: DB;
  readonly signingKey: string;
  readonly now?: () => number;
}

/**
 * Tiny helper: surface Zod errors as a uniform `{error, field, message}`
 * envelope. Mirrors the shape `routes/auth.ts` uses for body-validation
 * failures so the frontend has a single error contract to parse.
 */
function badRequest(c: { json: (b: unknown, s: number) => Response }, opts: {
  error: string;
  field?: string;
  message?: string;
}): Response {
  return c.json(opts, 400);
}

export function createProjectsRoutes(
  deps: CreateProjectsRoutesDeps,
): Hono<{ Variables: AuthVariables }> {
  const { db, signingKey } = deps;
  const clock = deps.now ?? defaultNow;
  const requireAuth = createRequireAuth({ db, now: clock });

  const app = new Hono<{ Variables: AuthVariables }>();
  // Owner-scoped everywhere → gate the entire subrouter.
  app.use("*", requireAuth);

  // -------------------------------------------------------------------------
  // GET / — list caller's projects.
  // -------------------------------------------------------------------------
  app.get("/", async (c) => {
    const user = c.get("user");
    const projects = await listForUser(db, user.id);
    return c.json({ projects });
  });

  // -------------------------------------------------------------------------
  // POST / — create project.
  // -------------------------------------------------------------------------
  app.post("/", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return badRequest(c, { error: "invalid_json" });
    }
    const parsed = CreateProjectBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return badRequest(c, {
        error: "invalid_request",
        field: issue?.path.join(".") ?? "body",
        message: issue?.message ?? "invalid request body",
      });
    }

    const user = c.get("user");
    const project = await createProject(
      db,
      { userId: user.id, name: parsed.data.name },
      { signingKey, now: clock },
    );
    return c.json({ project }, 201);
  });

  // -------------------------------------------------------------------------
  // DELETE /:id — delete project (cascades to targets).
  // -------------------------------------------------------------------------
  app.delete("/:id", async (c) => {
    // ULID-shape gate; mismatched ids collapse to 404 (same as foreign-owned).
    const paramParse = ProjectIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) {
      return c.json({ error: "not_found" }, 404);
    }

    const user = c.get("user");
    const result = await deleteProject(
      db,
      { userId: user.id, projectId: paramParse.data.id },
      { signingKey, now: clock },
    );
    if (!result.ok) {
      return c.json({ error: result.reason }, result.code);
    }
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /:projectId/targets — list targets in a project.
  // -------------------------------------------------------------------------
  app.get("/:projectId/targets", async (c) => {
    const paramParse = ProjectIdParamSchema.safeParse({
      id: c.req.param("projectId"),
    });
    if (!paramParse.success) {
      return c.json({ error: "not_found" }, 404);
    }

    const user = c.get("user");
    const result = await listForProject(db, {
      userId: user.id,
      projectId: paramParse.data.id,
    });
    if (!result.ok) {
      return c.json({ error: result.reason }, result.code);
    }
    return c.json({ targets: result.value });
  });

  // -------------------------------------------------------------------------
  // POST /:projectId/targets — create target.
  // -------------------------------------------------------------------------
  app.post("/:projectId/targets", async (c) => {
    const paramParse = ProjectIdParamSchema.safeParse({
      id: c.req.param("projectId"),
    });
    if (!paramParse.success) {
      // Treat malformed parent id as not-found to stay consistent with the
      // foreign-owned case.
      return c.json({ error: "not_found" }, 404);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return badRequest(c, { error: "invalid_json" });
    }
    const parsed = CreateTargetBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return badRequest(c, {
        error: "invalid_request",
        field: issue?.path.join(".") ?? "body",
        message: issue?.message ?? "invalid request body",
      });
    }

    const user = c.get("user");
    const result = await createTarget(
      db,
      {
        userId: user.id,
        projectId: paramParse.data.id,
        url: parsed.data.url,
      },
      { signingKey, now: clock },
    );
    if (!result.ok) {
      return c.json({ error: result.reason }, result.code);
    }
    return c.json({ target: result.value }, 201);
  });

  return app;
}
