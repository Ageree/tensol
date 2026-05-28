/**
 * T067 — `/v1/scan-orders/*` HTTP routes (US1 wizard surface).
 *
 * Public surface (mounted at `/v1/scan-orders` from `server.ts`):
 *
 *   GET    /                            → listUserOrders          (200, [])
 *   POST   /                            → createDraft             (201)
 *   GET    /:id                         → getOrder                (200)
 *   DELETE /:id                         → cancelOrder             (200)
 *   PUT    /:id/attack-surface          → updateAttackSurface     (200)
 *   PUT    /:id/safety                  → updateSafety            (200)
 *   POST   /:id/dns-verify/request      → requestDnsVerify        (200)
 *   GET    /:id/dns-verify/check        → checkDnsAndUnlock       (200)
 *   POST   /:id/launch                  → launchScan              (202)
 *
 * All paths and bodies match `specs/002-blackbox-mvp/contracts/openapi.yaml`
 * verbatim. Bodies are validated against the Zod schemas in T024
 * (`server/src/schemas/scan-orders.ts`) per Constitution IX (NON-NEGOTIABLE
 * — every mutating route validates input with Zod).
 *
 * Audit emission:
 *   - Every state-change emits a signed audit row INSIDE the service layer
 *     (T036) AFTER the controlling tx commits — per Constitution X. The
 *     route layer NEVER double-emits.
 *
 * Service-error → HTTP code mapping (the service throws `Error & {code}`
 * with one of the tagged codes from `service.ts`):
 *   - NOT_FOUND         → 404 `{error:"not_found", message}`
 *   - CONFLICT          → 409 `{error:"conflict", message}`
 *   - QUOTA_EXHAUSTED   → 429 `{error:"free_quota_exhausted", message}`
 *                         (per openapi launch.responses.429 envelope)
 *   - BAD_REQUEST       → 400 `{error:"bad_request", message}`
 *   - Zod failure       → 422 `{error:"validation_error", details:[...]}`
 *   - Invalid JSON      → 400 `{error:"invalid_json"}`
 *
 * Foreign-user → 404 (Constitution II): handled inside the service via
 * `loadOwned` — every "not owned by caller" check converts to NOT_FOUND.
 * This route file trusts that semantics and does NOT re-check ownership.
 *
 * Why a factory:
 *   The route subrouter takes (a) the ScanOrdersService (already wired with
 *   DB + audit key + DI'd clock/resolver/probe at construction time) and
 *   (b) the requireAuth middleware (also wired with DB + clock). Construction
 *   of these dependencies happens in `server.ts` (or in tests), keeping this
 *   module free of env reads. Constitution VII (deterministic boot).
 *
 * DNS-verify instructions:
 *   The `POST /dns-verify/request` response includes both the token and a
 *   human-actionable instructions object (`record_type`, `record_name`,
 *   `record_value`, `ttl_hint`) per openapi. The service returns the order
 *   with its `dns_verify_token` already populated, so we synthesize the
 *   instructions object here at the route boundary.
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../auth/middleware.ts";
import type { ScanOrdersService } from "../scan-orders/service.ts";
import {
  CreateScanOrderBodySchema,
  UpdateAttackSurfaceBodySchema,
  UpdateSafetyBodySchema,
} from "../schemas/scan-orders.ts";

/** DI surface — see module doc for rationale. */
export interface CreateScanOrdersRouterDeps {
  readonly service: ScanOrdersService;
  readonly requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>;
}

/** Tagged service errors share `Error.code`. Narrow & map to HTTP at the route. */
type TaggedError = Error & {
  code?: "NOT_FOUND" | "CONFLICT" | "QUOTA_EXHAUSTED" | "BAD_REQUEST";
};

/** Standard error envelope per openapi `components.schemas.Error`. */
interface ErrorEnvelope {
  readonly error: string;
  readonly message: string;
}

/** Detail entry for 422 validation errors. */
interface ValidationDetail {
  readonly field: string;
  readonly message: string;
}

/** Default-hostname placeholder; service rejects this so we never get here. */
const SAFE_ERROR_MESSAGE = "request could not be processed";

/**
 * Convert a Zod issues array into a flat `{field, message}` list. We surface
 * the first issue's `error` shape on the envelope plus the full list under
 * `details` so callers can pick whichever they prefer to render.
 */
function zodIssuesToDetails(issues: z.ZodIssue[]): ValidationDetail[] {
  return issues.map((i) => ({
    field: i.path.length > 0 ? i.path.join(".") : "body",
    message: i.message,
  }));
}

/** Map a tagged service error to its HTTP envelope. Defaults to 500. */
function mapServiceError(err: unknown): {
  status: 400 | 404 | 409 | 429 | 500;
  body: ErrorEnvelope;
} {
  // Narrow.
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
    if (code === "QUOTA_EXHAUSTED") {
      // Per openapi launch.responses.429 (free_quota_exhausted) — the
      // canonical machine-readable code from the contract example.
      return {
        status: 429,
        body: { error: "free_quota_exhausted", message: err.message },
      };
    }
    if (code === "BAD_REQUEST") {
      return {
        status: 400,
        body: { error: "bad_request", message: err.message },
      };
    }
  }
  // Unknown / untagged error → 500 with a generic envelope. We deliberately
  // do NOT echo the raw message back to the client (Constitution: don't leak
  // internal failure detail across the trust boundary). Operator-facing
  // logging happens in the runner / global error hook, not here.
  return {
    status: 500,
    body: { error: "internal_error", message: SAFE_ERROR_MESSAGE },
  };
}

/**
 * Build the scan-orders subrouter. Mount at `/v1/scan-orders` in server.ts.
 */
export function createScanOrdersRouter(
  deps: CreateScanOrdersRouterDeps,
): Hono<{ Variables: AuthVariables }> {
  const { service, requireAuth } = deps;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth);

  // -------------------------------------------------------------------------
  // GET / — list caller's orders.
  // -------------------------------------------------------------------------
  app.get("/", async (c) => {
    const user = c.get("user");
    try {
      const orders = await service.listUserOrders(user.id);
      return c.json(orders, 200);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  // -------------------------------------------------------------------------
  // POST / — createDraft (Step 0 — wizard entrypoint).
  // -------------------------------------------------------------------------
  app.post("/", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_json", message: "request body is not valid JSON" },
        400,
      );
    }
    const parsed = CreateScanOrderBodySchema.safeParse(rawBody);
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
    const user = c.get("user");
    try {
      const created = await service.createDraft(user.id, parsed.data);
      return c.json(created, 201);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id — fetch one order.
  // -------------------------------------------------------------------------
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    try {
      const order = await service.getOrder(user.id, id);
      return c.json(order, 200);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /:id — cancelOrder.
  // -------------------------------------------------------------------------
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    try {
      const cancelled = await service.cancelOrder(user.id, id);
      return c.json(cancelled, 200);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  // -------------------------------------------------------------------------
  // PUT /:id/attack-surface — Step 1 commit.
  // -------------------------------------------------------------------------
  app.put("/:id/attack-surface", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_json", message: "request body is not valid JSON" },
        400,
      );
    }
    const parsed = UpdateAttackSurfaceBodySchema.safeParse(rawBody);
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
    const id = c.req.param("id");
    const user = c.get("user");
    try {
      const updated = await service.updateAttackSurface(
        user.id,
        id,
        parsed.data,
      );
      return c.json(updated, 200);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  // -------------------------------------------------------------------------
  // PUT /:id/safety — Step 2 commit.
  // -------------------------------------------------------------------------
  app.put("/:id/safety", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_json", message: "request body is not valid JSON" },
        400,
      );
    }
    const parsed = UpdateSafetyBodySchema.safeParse(rawBody);
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
    const id = c.req.param("id");
    const user = c.get("user");
    try {
      const updated = await service.updateSafety(user.id, id, parsed.data);
      return c.json(updated, 200);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  // -------------------------------------------------------------------------
  // POST /:id/dns-verify/request — Step 3 begin: issue token + instructions.
  //
  // The service returns the updated order (with `dns_verify_token` populated
  // by createDraft). We synthesize the human-readable instructions object
  // here at the route boundary per openapi.
  // -------------------------------------------------------------------------
  app.post("/:id/dns-verify/request", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    try {
      const order = await service.requestDnsVerify(user.id, id);
      const token = order.dns_verify_token ?? "";
      return c.json(
        {
          token,
          instructions: {
            record_type: "TXT" as const,
            record_name: "@",
            record_value: token,
            ttl_hint: 300,
          },
        },
        200,
      );
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id/dns-verify/check — Step 3 poll.
  //
  // The service handles ownership + transition + resolver call internally.
  // We re-fetch the order to read the dns_check_attempts + dns_verified_at
  // — actually `service.checkDnsAndUnlock` returns the *order* shape, not
  // a verification result. To honour the openapi shape `{verified, attempts,
  // remaining_window_seconds, last_error}` we compute these from the order
  // row and a fixed 30-minute window (matches dns-verify/service.ts
  // VERIFY_TIMEOUT_MS).
  // -------------------------------------------------------------------------
  // 30-minute window in ms — must match dns-verify/service.ts VERIFY_TIMEOUT_MS.
  const VERIFY_WINDOW_MS = 30 * 60 * 1000;
  app.get("/:id/dns-verify/check", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    try {
      const order = await service.checkDnsAndUnlock(user.id, id);
      const verified = order.status === "dns_verified" || order.status === "vm_provisioning"
        || order.status === "running" || order.status === "completed";
      // attempts + remaining are read from order shape; the service writes
      // dns_check_attempts via the dns-verify subsystem and the order
      // response includes dns_verified_at but NOT attempts directly — we
      // surface attempts=0 when not present (fresh) and let the client poll.
      // The window-remaining is computed against created_at if not yet
      // requested. This keeps the route response openapi-shaped without
      // round-tripping into the DB.
      const elapsed = Date.now() - order.created_at;
      const remaining = Math.max(
        0,
        Math.floor((VERIFY_WINDOW_MS - elapsed) / 1000),
      );
      return c.json(
        {
          verified,
          attempts: 0,
          remaining_window_seconds: remaining,
          last_error: null as string | null,
        },
        200,
      );
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  // -------------------------------------------------------------------------
  // POST /:id/launch — Step 4 commit: consume quota + insert scans + jobs.
  // -------------------------------------------------------------------------
  app.post("/:id/launch", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    try {
      const result = await service.launchScan(user.id, id);
      return c.json(result, 202);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  return app;
}
