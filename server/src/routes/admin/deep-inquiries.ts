/**
 * T121 — Operator-only admin routes for the US2 lead-gen funnel.
 *
 * Mounted at `/v1/admin/deep-inquiries` from `server.ts`:
 *
 *   GET    /v1/admin/deep-inquiries          → listInquiries (optional ?status=)
 *   PUT    /v1/admin/deep-inquiries/:id/status → setStatus (state-machine)
 *
 * Paths and shapes mirror `specs/002-blackbox-mvp/contracts/openapi.yaml`.
 *
 * Authorization model — two layers, in order:
 *   1. `requireAuth` (the SAME middleware as `/v1/scans` etc.) short-circuits
 *      with 401 when there is no cookie / no session row / expired session /
 *      orphan user. On success it binds `c.var.user` ({id, email}).
 *
 *   2. Operator gate (this file): compare `c.var.user.email` (lowercased)
 *      against the `operatorEmails` list (already lowercased+trimmed at
 *      config load time). Mismatch → 403 `{error: "forbidden"}`.
 *
 *   The two-step ordering matters: anonymous callers MUST get 401 (not 403)
 *   so the front-end can distinguish "session expired, please re-login" from
 *   "you're signed in but not authorized for this surface".
 *
 * Operator email source:
 *   The list arrives pre-normalized from `config.ts` (env var
 *   `TENSOL_OPERATOR_EMAILS` — comma-separated, parsed into a string[],
 *   lowercased, trimmed, empty entries dropped). When the env var is unset
 *   the list is empty and EVERY authenticated user falls through to the 403
 *   branch — the safe default is "no operators configured, deny all".
 *
 * Service-error → HTTP code mapping (mirrors `routes/deep-inquiries.ts`):
 *   - NOT_FOUND   → 404 `{error: "not_found",   message}`
 *   - CONFLICT    → 409 `{error: "conflict",    message}`
 *   - BAD_REQUEST → 400 `{error: "bad_request", message}`
 *   - Zod failure → 422 `{error: "validation_error", details:[{field,message}]}`
 *   - Invalid JSON→ 400 `{error: "invalid_json"}`
 *
 * Audit emission:
 *   The service layer (`DeepInquiriesService.setStatus`) emits
 *   `inquiry_status_changed` AFTER its tx commits per Constitution X. We
 *   forward `actorUserId = c.var.user.id` so the audit row carries operator
 *   attribution. The route NEVER double-emits.
 *
 * Constitution invariants:
 *   - II:  per-user authorization (operator gate by env list).
 *   - VI:  TDD pair — see `server/test/integration/admin-routes.test.ts`.
 *   - VII: file ≤ 800 LOC (this one ≈ 220).
 *   - IX:  every mutating route validates body via Zod (NON-NEGOTIABLE).
 *   - X:   audit emission lives in the service, not here.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";

import type { DeepInquiriesService } from "../../deep-inquiries/service.ts";
import type { AuthVariables } from "../../auth/middleware.ts";
import { DeepInquiryStatusEnum } from "../../schemas/deep-inquiries.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public DI surface
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateAdminDeepInquiriesRouterDeps {
  readonly service: DeepInquiriesService;
  /**
   * Pre-normalized operator email list (lowercased, trimmed, no empty
   * entries). Source-of-truth: `config.ts` parses `TENSOL_OPERATOR_EMAILS`
   * once at startup. We accept the parsed list rather than the raw env
   * string so the route stays pure and easy to test.
   *
   * Empty list = no operators configured = every authenticated user gets
   * 403 on this surface (safe default).
   */
  readonly operatorEmails: ReadonlyArray<string>;
  /**
   * The exact `requireAuth` middleware from `auth/middleware.ts`. We do NOT
   * construct it here so callers can share a single instance across all
   * admin surfaces and so tests can inject a fake when needed.
   */
  readonly requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Tagged service errors share `Error.code`. Narrow & map to HTTP at the route. */
type TaggedError = Error & {
  code?: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST";
};

interface ErrorEnvelope {
  readonly error: string;
  readonly message: string;
}

interface ValidationDetail {
  readonly field: string;
  readonly message: string;
}

const SAFE_ERROR_MESSAGE = "request could not be processed";

function zodIssuesToDetails(issues: z.ZodIssue[]): ValidationDetail[] {
  return issues.map((i) => ({
    field: i.path.length > 0 ? i.path.join(".") : "body",
    message: i.message,
  }));
}

function mapServiceError(err: unknown): {
  status: 400 | 404 | 409 | 500;
  body: ErrorEnvelope;
} {
  if (err instanceof Error) {
    const code = (err as TaggedError).code;
    if (code === "NOT_FOUND") {
      return {
        status: 404,
        body: { error: "not_found", message: err.message },
      };
    }
    if (code === "CONFLICT") {
      return {
        status: 409,
        body: { error: "conflict", message: err.message },
      };
    }
    if (code === "BAD_REQUEST") {
      return {
        status: 400,
        body: { error: "bad_request", message: err.message },
      };
    }
  }
  // Untagged → 500 with a generic envelope. We deliberately don't echo
  // the raw message across the trust boundary.
  return {
    status: 500,
    body: { error: "internal_error", message: SAFE_ERROR_MESSAGE },
  };
}

/** Body schema for `PUT .../:id/status`. `.strict()` rejects unknown keys. */
const PutStatusBodySchema = z
  .object({
    status: DeepInquiryStatusEnum,
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Public env-parsing helper (re-used by config.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `TENSOL_OPERATOR_EMAILS` env string into a normalized list.
 *
 *   "  Op@Tensol.com , alice@tensol.com,, "
 *     → ["op@tensol.com", "alice@tensol.com"]
 *
 * Pure, deterministic, safe to call on `undefined` (returns `[]`).
 */
export function parseOperatorEmails(
  raw: string | undefined | null,
): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Router factory
// ─────────────────────────────────────────────────────────────────────────────

export function createAdminDeepInquiriesRouter(
  deps: CreateAdminDeepInquiriesRouterDeps,
): Hono<{ Variables: AuthVariables }> {
  const { service, operatorEmails, requireAuth } = deps;

  // Normalize a copy once so the gate is robust against callers that pass a
  // list of mixed-case emails (config.ts already normalizes, but the type
  // is `ReadonlyArray<string>` — be defensive at the boundary).
  const normalized = new Set(
    operatorEmails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0),
  );

  const app = new Hono<{ Variables: AuthVariables }>();

  // 1) Strict auth — 401 on any auth failure.
  app.use("*", requireAuth);

  // 2) Operator gate — 403 on email not in list.
  app.use("*", async (c, next) => {
    const email = c.var.user?.email?.toLowerCase() ?? "";
    if (!email || !normalized.has(email)) {
      return c.json({ error: "forbidden", message: "operator role required" }, 403);
    }
    await next();
  });

  // ───────────────────────────────────────────────────────────────────────
  // GET / — list inquiries (optional ?status= filter)
  // ───────────────────────────────────────────────────────────────────────
  app.get("/", async (c) => {
    const rawStatus = c.req.query("status");
    let status: ReturnType<typeof DeepInquiryStatusEnum.parse> | undefined;
    if (rawStatus !== undefined && rawStatus !== "") {
      const parsed = DeepInquiryStatusEnum.safeParse(rawStatus);
      if (!parsed.success) {
        return c.json(
          {
            error: "validation_error",
            message: "query parameter ?status= must be a valid DeepInquiryStatus",
            details: zodIssuesToDetails(parsed.error.issues),
          },
          422,
        );
      }
      status = parsed.data;
    }

    try {
      const inquiries = await service.listInquiries(
        status ? { status } : {},
      );
      return c.json({ inquiries }, 200);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // PUT /:id/status — transition an inquiry's status
  // ───────────────────────────────────────────────────────────────────────
  app.put("/:id/status", async (c) => {
    const id = c.req.param("id");

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_json", message: "request body is not valid JSON" },
        400,
      );
    }

    const parsed = PutStatusBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: "validation_error",
          message: "request body failed schema validation",
          details: zodIssuesToDetails(parsed.error.issues),
        },
        422,
      );
    }

    try {
      await service.setStatus(id, parsed.data.status, {
        actorUserId: c.var.user.id,
      });
      // Re-fetch the row so the caller has the post-transition shape (and
      // can confirm the new status without a second round-trip). If the
      // row disappeared between the update and the read we degrade to a
      // bare 200 — the transition succeeded, the read is best-effort.
      const fresh = await service.getInquiry(id);
      return c.json({ ok: true, inquiry: fresh ?? null }, 200);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  return app;
}
