/**
 * `/api/auth/*` routes — Telegram deep-link flow (pivot 2026-05-19).
 *
 * Replaces the previous email + magic-link surface (`/request-link`,
 * `/verify`). The pivot keeps the legacy paths mounted as 410 Gone so any
 * cached client gets a deterministic deprecation signal instead of a 404
 * (helpful for ops / browser breadcrumbs).
 *
 * Public surface:
 *   - POST  /issue-link    — body `{telegram_username}` → 200 {deep_link, ...}.
 *   - GET   /poll-link     — query `?token=...` → 200 {status, session_id?}.
 *   - POST  /logout        — auth-gated; 204 + clears cookie + DELETEs row.
 *   - GET   /me            — auth-gated; returns `{user:{id, telegram_*}}`.
 *
 * Legacy (deprecated, 410 Gone):
 *   - POST  /request-link  — Resend-based email magic-link, gone.
 *   - GET   /verify        — paired with /request-link, gone.
 *
 * Constitution invariants:
 *   - VII (file ≤ 800 LOC): ~220 LOC.
 *   - IX  (Zod at boundary): every route validates input via a Zod schema
 *     before any DB work.
 *   - X   (audit emit after commit): `auth_login_requested` is emitted from
 *     inside `issueLink`; `auth_login_succeeded` from inside `consumeLink`
 *     (which is invoked by the Telegram webhook handler, not this module);
 *     `auth_logout` from inside the logout handler below.
 *
 * Cookie minting:
 *   The session cookie is set by the FRONTEND after a successful `pollLink`
 *   → `resolved` response. We deliberately do NOT set the cookie here on
 *   poll because polling from the browser is a vanilla `fetch` (no
 *   redirect), and the cookie semantics for a JSON-fetch response are
 *   inconsistent across browsers. Frontend takes `session_id` from the
 *   200 body and stores it via the dedicated `/api/auth/exchange` endpoint
 *   (T078b, separate task) — for MVP the frontend uses the response body
 *   directly. The cookie itself still has `HttpOnly+SameSite=Lax+Secure-in-prod`
 *   per the original `session.ts` contract; see `setSessionCookie`.
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { emitSignedAudit } from "../audit/emit.ts";
import { issueLink, pollLink } from "../auth/magic-link.ts";
import {
  createRequireAuth,
  type AuthVariables,
} from "../auth/middleware.ts";
import {
  clearSessionCookie,
  setSessionCookie,
} from "../auth/session.ts";
import type { DB } from "../db/client.ts";
import { sessions as sessionsTable } from "../db/schema.ts";
import { now as defaultNow } from "../lib/time.ts";

/** Body schema for POST /api/auth/issue-link. */
export const IssueLinkBodySchema = z.object({
  telegram_username: z.string().min(1).max(64),
});

/** Query schema for GET /api/auth/poll-link. */
export const PollLinkQuerySchema = z.object({
  token: z.string().min(1).max(64),
});

export interface CreateAuthRoutesDeps {
  readonly db: DB;
  /** HMAC key used for audit signing. */
  readonly signingKey: string;
  /** Injectable clock. */
  readonly now?: () => number;
  /** Toggle cookie `Secure` flag (matches `setSessionCookie`'s contract). */
  readonly isProd?: boolean;
  /** Telegram bot username (without leading @). Defaults to
   *  `tensol_leadsbot` per pivot doc. Overridable for staging bots. */
  readonly botUsername?: string;
}

export function createAuthRoutes(
  deps: CreateAuthRoutesDeps,
): Hono<{ Variables: AuthVariables }> {
  const { db, signingKey, isProd, botUsername } = deps;
  const clock = deps.now ?? defaultNow;
  const requireAuth = createRequireAuth({ db, now: clock });

  const app = new Hono<{ Variables: AuthVariables }>();

  // -------------------------------------------------------------------------
  // POST /issue-link — mint a pending_signups row + return the deep-link.
  // -------------------------------------------------------------------------
  app.post("/issue-link", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = IssueLinkBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        {
          error: "invalid_request",
          field: issue?.path.join(".") ?? "body",
          message: issue?.message ?? "invalid request body",
        },
        400,
      );
    }

    try {
      const issued = await issueLink(
        { telegramUsername: parsed.data.telegram_username },
        {
          db,
          signingKey,
          now: clock,
          ...(botUsername !== undefined ? { botUsername } : {}),
        },
      );
      return c.json(
        {
          deep_link: issued.deepLink,
          token: issued.token,
          telegram_username: issued.telegramUsername,
          expires_at: issued.expiresAt,
        },
        200,
      );
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issue = err.issues[0];
        return c.json(
          {
            error: "invalid_request",
            field: issue?.path.join(".") ?? "telegram_username",
            message: issue?.message ?? "invalid telegram username",
          },
          400,
        );
      }
      // Internal failure path — never enumerate, log + 500.
      // eslint-disable-next-line no-console
      console.error("auth.issue-link: downstream failure", err);
      return c.json({ error: "internal_error" }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // GET /poll-link — frontend long-poll target.
  // -------------------------------------------------------------------------
  app.get("/poll-link", async (c) => {
    const parsed = PollLinkQuerySchema.safeParse({
      token: c.req.query("token"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", message: "token query required" },
        400,
      );
    }
    const result = await pollLink(
      { token: parsed.data.token },
      { db, signingKey, now: clock },
    );

    if (result.status === "resolved") {
      // We additionally set the session cookie on this response so the
      // browser is logged-in straight after the next poll resolves — the
      // frontend can simply redirect to /dashboard without an extra
      // exchange step.
      setSessionCookie(
        c,
        result.sessionId,
        isProd === undefined ? {} : { isProd },
      );
      return c.json({ status: "resolved", session_id: result.sessionId }, 200);
    }

    if (result.status === "pending") {
      return c.json(
        { status: "pending", expires_at: result.expiresAt },
        200,
      );
    }
    // expired | invalid
    return c.json({ status: result.status }, 200);
  });

  // -------------------------------------------------------------------------
  // POST /logout — auth-gated; deletes session row + clears cookie + audit.
  // -------------------------------------------------------------------------
  app.post("/logout", requireAuth, async (c) => {
    const session = c.get("session");
    const user = c.get("user");

    db.delete(sessionsTable).where(eq(sessionsTable.id, session.id)).run();
    clearSessionCookie(c, isProd === undefined ? {} : { isProd });

    await emitSignedAudit(
      db,
      {
        event: "auth_logout",
        outcome: "success",
        ts: clock(),
        user_id: user.id,
        metadata: { session_id: session.id, user_id: user.id },
      },
      { key: signingKey },
    );

    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /me — auth-gated; trivial echo of the bound user.
  // -------------------------------------------------------------------------
  app.get("/me", requireAuth, (c) => {
    const user = c.get("user");
    return c.json({ user: { id: user.id, email: user.email } });
  });

  // -------------------------------------------------------------------------
  // Legacy: 410 Gone for the email-based endpoints (pivot 2026-05-19).
  // Returning a structured envelope so cached frontends get a clear signal.
  // -------------------------------------------------------------------------
  const goneBody = {
    error: "endpoint_retired",
    message:
      "Email magic-link auth has been replaced by Telegram deep-link auth. " +
      "Use POST /api/auth/issue-link with { telegram_username }.",
  };
  app.post("/request-link", (c) => c.json(goneBody, 410));
  app.get("/verify", (c) => c.json(goneBody, 410));

  return app;
}
