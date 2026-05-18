/**
 * T026 — `/api/auth/*` routes. Closes Phase 3.1 (Magic-link auth).
 *
 * Public surface:
 *   - POST  /request-link  — body `{email}` → 204 (always, enumeration-safe).
 *   - GET   /verify?token  — 302 to `redirectAfterVerify` on success;
 *                            410 on invalid/used/expired token.
 *   - POST  /logout        — auth-gated; 204 + clears cookie + DELETEs row.
 *   - GET   /me            — auth-gated; returns `{user:{id,email}}`.
 *
 * Factory pattern: `createAuthRoutes(deps)` returns a Hono subrouter; the
 * caller (server.ts) mounts it under `/api/auth`. Dependencies are threaded
 * through `deps` instead of being read from the module-level config
 * singleton — Constitution VII (deterministic boot, no hidden env reads).
 *
 * Enumeration safety notes:
 *   - POST /request-link MUST return the same 204 No Content response for
 *     known and unknown emails. We therefore (a) always invoke `issueLink`
 *     (which is harmless against unknown emails since users are only
 *     materialised at verify), (b) always send the email through the
 *     injected client, and (c) catch every downstream error (DB, email
 *     transport) inside a try/catch — a 500 here would leak information
 *     about which inputs reach error paths.
 *   - GET /verify collapses {invalid, used, expired} into a single 410.
 *     `verifyLink` returns `code: 404` for invalid tokens, but we override
 *     to 410 at the HTTP boundary so a probing attacker cannot distinguish
 *     "this token was never issued" from "this token already fired".
 *
 * Auth-gating: `createRequireAuth(...)` is mounted ONLY on `/me` + `/logout`.
 * Mounting it at `*` would 401 the public endpoints. We attach the middleware
 * per-route so the bound `c.get("user")` / `c.get("session")` typings flow
 * into just the handlers that need them.
 *
 * Audit emissions:
 *   - `auth_login_requested` is emitted inside `issueLink` (T021).
 *   - `auth_login_succeeded` is emitted inside `verifyLink` (T021).
 *   - `auth_logout` is emitted from this module, after the session row is
 *     deleted (so a crash mid-delete cannot leave a phantom logout row).
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { emitSignedAudit } from "../audit/emit.ts";
import { issueLink, verifyLink } from "../auth/magic-link.ts";
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
import type { EmailClient } from "../email/resend-client.ts";
import { renderMagicLinkEmail } from "../email/templates/magic-link.ts";
import { now as defaultNow } from "../lib/time.ts";
import {
  RequestLinkBodySchema,
  VerifyLinkQuerySchema,
} from "../schemas/auth.ts";

export interface CreateAuthRoutesDeps {
  readonly db: DB;
  readonly email: EmailClient;
  /** HMAC key used for both audit signing and magic-link token hashing. */
  readonly signingKey: string;
  /** Origin used when constructing the magic-link URL in outgoing email.
   *  Typically `TENSOL_WEBHOOK_BASE_URL` from config. */
  readonly baseUrl: string;
  /** Injectable clock (T021 contract). */
  readonly now?: () => number;
  /** Toggle cookie `Secure` flag (matches `setSessionCookie`'s contract). */
  readonly isProd?: boolean;
  /** Where to send the browser after a successful verify. Defaults to
   *  `/dashboard` per the OpenAPI contract. */
  readonly redirectAfterVerify?: string;
}

/** Build the magic-link verify URL embedded in the outgoing email. */
function buildVerifyUrl(baseUrl: string, token: string): string {
  // `URLSearchParams` handles percent-encoding of the raw base64url token.
  // Concatenating `baseUrl + "/api/auth/verify?token=..."` is fine because
  // the token alphabet is URL-safe by construction (T021 randomToken).
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

export function createAuthRoutes(
  deps: CreateAuthRoutesDeps,
): Hono<{ Variables: AuthVariables }> {
  const {
    db,
    email,
    signingKey,
    baseUrl,
    isProd,
    redirectAfterVerify = "/dashboard",
  } = deps;
  const clock = deps.now ?? defaultNow;
  const requireAuth = createRequireAuth({ db, now: clock });

  const app = new Hono<{ Variables: AuthVariables }>();

  // -------------------------------------------------------------------------
  // POST /request-link — enumeration-safe, ALWAYS returns 204.
  // -------------------------------------------------------------------------
  app.post("/request-link", async (c) => {
    // Parse body. JSON parse errors and Zod failures both surface as 400.
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = RequestLinkBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      // Validation failure on body shape is a developer/client error, not
      // an attacker probe — surface a real 400 (not a fake 204) so misuse
      // is visible. Real probes use well-formed emails.
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

    const { email: normalisedEmail } = parsed.data;

    // From here on, every downstream error is swallowed → enumeration safety.
    // The only observable signal to the client must be the 204 status.
    try {
      const issued = await issueLink(db, normalisedEmail, {
        signingKey,
        now: clock,
      });
      const verifyUrl = buildVerifyUrl(baseUrl, issued.token);
      const rendered = renderMagicLinkEmail({
        email: normalisedEmail,
        verifyUrl,
        expiresAtMs: issued.expires_at,
      });
      await email.send({
        to: normalisedEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    } catch (err) {
      // Intentional: do NOT propagate. issueLink + email.send failures must
      // not become observable to the request-link caller. The error is
      // surfaced via process stderr only (no JSON error envelope).
      // eslint-disable-next-line no-console
      console.error("auth.request-link: downstream failure", err);
    }

    // 204 No Content — Hono's `c.body(null, 204)` produces the canonical
    // empty body the OpenAPI contract specifies.
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /verify?token — 302 on success, 410 on any failure.
  // -------------------------------------------------------------------------
  app.get("/verify", async (c) => {
    const queryParse = VerifyLinkQuerySchema.safeParse({
      token: c.req.query("token"),
    });
    if (!queryParse.success) {
      // Missing/malformed token → 410 (same as used/expired) to avoid the
      // 400-vs-410 oracle a probing attacker would exploit.
      return c.text("Gone", 410);
    }

    const result = await verifyLink(db, queryParse.data.token, {
      signingKey,
      now: clock,
    });
    if (!result.ok) {
      // verifyLink returns code:404 for "invalid" and code:410 for
      // used/expired; we collapse all three to 410 at the HTTP boundary.
      return c.text("Gone", 410);
    }

    // exactOptionalPropertyTypes: pass the option only when defined, so
    // `isProd: undefined` doesn't widen the callee's `isProd: boolean` slot.
    setSessionCookie(
      c,
      result.session.id,
      isProd === undefined ? {} : { isProd },
    );
    // 302 Found is the OpenAPI-specified redirect for verify; using
    // `c.redirect(url, 302)` lets Hono set Location + status atomically.
    return c.redirect(redirectAfterVerify, 302);
  });

  // -------------------------------------------------------------------------
  // POST /logout — auth-gated; deletes session row + clears cookie + audit.
  // -------------------------------------------------------------------------
  app.post("/logout", requireAuth, async (c) => {
    const session = c.get("session");
    const user = c.get("user");

    // Delete the session row first; emit audit only after the DELETE commits
    // so a crash here cannot leave a phantom `auth_logout` row pointing at
    // a session that still exists.
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

  return app;
}
