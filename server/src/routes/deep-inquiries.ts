/**
 * T104 — `/v1/deep-inquiries` HTTP route (US2 lead-gen funnel).
 *
 * Public surface (mounted at `/v1/deep-inquiries` from `server.ts`):
 *
 *   POST   /                            → createInquiry            (201)
 *
 * The path matches `specs/002-blackbox-mvp/contracts/openapi.yaml`
 * (paths./v1/deep-inquiries.post, lines 607-646) verbatim. The body is
 * validated against `CreateInquiryBodySchema` (T024) per Constitution IX
 * NON-NEGOTIABLE — every mutating route validates input with Zod.
 *
 * Anonymous OR authenticated:
 *   This route is intentionally NOT gated by `requireAuth`. The Deep
 *   inquiry funnel is a lead-capture surface — anonymous visitors MUST
 *   be able to submit. When a valid session cookie IS present we pass
 *   the resolved userId through to the service so the persisted row
 *   gets `user_id` populated (per data-model.md §E6 the column is
 *   nullable specifically to support both paths).
 *
 *   We don't use `requireAuth` (which 401s on missing cookie). Instead
 *   `deps.getUserId(c)` is a soft cookie reader: it returns the
 *   user-id when the cookie maps to a non-expired session, otherwise
 *   `null`. Composition happens in `server.ts` — that's where the DB
 *   handle and clock are available to build the reader.
 *
 * Audit emission:
 *   - The service layer (`createInquiry`) emits `inquiry_received` AFTER
 *     the controlling tx commits per Constitution X. The route NEVER
 *     double-emits.
 *
 * Service-error → HTTP code mapping (mirrors `routes/scan-orders.ts`):
 *   - NOT_FOUND    → 404 `{error:"not_found", message}`
 *   - CONFLICT     → 409 `{error:"conflict", message}`
 *   - BAD_REQUEST  → 400 `{error:"bad_request", message}`
 *   - Zod failure  → 422 `{error:"validation_error", details:[...]}`
 *   - Invalid JSON → 400 `{error:"invalid_json"}`
 *
 * Response shape on success:
 *   `{ id, status: "received" }` — `id` matches the openapi 201
 *   response schema (object with required `id`); we add `status:
 *   "received"` as an acknowledgement breadcrumb for the front-end
 *   confirmation panel (no contract drift because openapi marks
 *   only `id` as required, additional properties are allowed).
 *
 * Constitution invariants:
 *   - II:  anonymous funnel supported — no 401 on missing cookie.
 *   - VII: file ≤ 800 LOC (this one is ~170).
 *   - IX:  Zod validation at the route boundary (NON-NEGOTIABLE).
 *   - X:   audit emission lives in the service, not here.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import type { DeepInquiriesService } from "../deep-inquiries/service.ts";
import { CreateInquiryBodySchema } from "../schemas/deep-inquiries.ts";

/** DI surface — see module doc for rationale. */
export interface CreateDeepInquiriesRouterDeps {
  readonly service: DeepInquiriesService;
  /**
   * Soft auth reader. Return the user-id when the request carries a valid
   * session cookie that maps to a non-expired session row, otherwise return
   * `null`. The default is `() => null` (pure anonymous) so tests that
   * don't care about the authenticated path can omit this dep.
   */
  readonly getUserId?: (c: Context) => string | null;
}

/** Tagged service errors share `Error.code`. Narrow & map to HTTP at the route. */
type TaggedError = Error & {
  code?: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST";
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

/** Default-message placeholder for untagged errors — don't leak internals. */
const SAFE_ERROR_MESSAGE = "request could not be processed";

/**
 * Convert a Zod issues array into a flat `{field, message}` list. We surface
 * the full list under `details` so callers can pick whichever field they
 * want to render alongside the offending input.
 */
function zodIssuesToDetails(issues: z.ZodIssue[]): ValidationDetail[] {
  return issues.map((i) => ({
    field: i.path.length > 0 ? i.path.join(".") : "body",
    message: i.message,
  }));
}

/** Map a tagged service error to its HTTP envelope. Defaults to 500. */
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
  // Untagged → 500 with a generic envelope. We deliberately do NOT echo
  // the raw message back to the client (Constitution: don't leak internal
  // failure detail across the trust boundary).
  return {
    status: 500,
    body: { error: "internal_error", message: SAFE_ERROR_MESSAGE },
  };
}

/**
 * Build the deep-inquiries subrouter. Mount at `/v1/deep-inquiries` in
 * server.ts.
 */
export function createDeepInquiriesRouter(
  deps: CreateDeepInquiriesRouterDeps,
): Hono {
  const { service } = deps;
  const getUserId = deps.getUserId ?? (() => null);
  const app = new Hono();

  // -------------------------------------------------------------------------
  // POST / — submit a Deep inquiry (anonymous OR authenticated).
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

    const parsed = CreateInquiryBodySchema.safeParse(rawBody);
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

    // Soft auth: forward userId to the service when a session is present.
    // Anonymous callers get `null` — the service writes `user_id IS NULL`.
    const userId = getUserId(c);

    try {
      const result = await service.createInquiry({
        body: parsed.data,
        userId,
      });
      return c.json({ id: result.id, status: "received" as const }, 201);
    } catch (err) {
      const mapped = mapServiceError(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  return app;
}
