/**
 * T023 — `requireAuth` middleware.
 *
 * Hono middleware that gates downstream handlers behind a valid session
 * cookie. On a successful auth check it binds two values into the Hono
 * context so handlers can read them with `c.get("user")` and
 * `c.get("session")`. On any failure it short-circuits with HTTP 401 and
 * a `{ error: "unauthenticated" }` envelope.
 *
 * Constructed via a factory (`createRequireAuth({db, now})`) rather than
 * a static export so callers (server boot + tests) inject the DB handle
 * explicitly. Constitution VII forbids reaching into a config singleton
 * from inside business logic; the factory keeps the same discipline for
 * middleware.
 *
 * Auth check semantics:
 *   1. `readSessionCookie(c)` — no cookie → 401.
 *   2. SELECT session by id — not found → 401.
 *   3. `now() >= session.expires_at` — expired → 401 (boundary is
 *      inclusive on the past side: expires_at == now is treated as
 *      already expired; matches sessions.created_at < expires_at + TTL
 *      invariant from data-model.md).
 *   4. SELECT user by session.user_id — orphan (deleted concurrently) →
 *      401. ON DELETE CASCADE on the FK normally prevents this, but a
 *      race window or a manual DB intervention could leave a dangling
 *      row; we MUST fail closed.
 *   5. Otherwise: bind `user` + `session` into the context and call
 *      `next()`.
 *
 * No audit emission here — successful auth on every request would flood
 * the chain; failed auth is observable via the standard request log.
 * Future tightening (rate-limit on 401, e.g.) is out of scope for T023.
 *
 * Expired session cleanup: we intentionally do NOT DELETE expired session
 * rows from inside this hot path. A scheduled job (T076 area) sweeps
 * `sessions` where `expires_at < now()` — keeping the middleware read-
 * only avoids surprising write amplification on every API request.
 */
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { DB } from "../db/client.ts";
import { sessions as sessionsTable, users as usersTable } from "../db/schema.ts";
import { now as defaultNow } from "../lib/time.ts";
import { readSessionCookie } from "./session.ts";

/** Subset of the user row exposed to downstream handlers. */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
}

/** Subset of the session row exposed to downstream handlers. */
export interface AuthSession {
  readonly id: string;
  readonly user_id: string;
  readonly expires_at: number;
}

/**
 * Hono `Variables` map contribution. Mount as:
 *   `new Hono<{ Variables: AuthVariables }>()`
 * so `c.get("user")` / `c.get("session")` type-check.
 */
export interface AuthVariables {
  user: AuthUser;
  session: AuthSession;
  [key: string]: unknown;
}

export interface CreateRequireAuthDeps {
  readonly db: DB;
  readonly now?: () => number;
}

function unauthenticated() {
  return { error: "unauthenticated" as const };
}

export function createRequireAuth(
  deps: CreateRequireAuthDeps,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  const clock = deps.now ?? defaultNow;
  const { db } = deps;

  return async (c, next) => {
    const sessionId = readSessionCookie(c);
    if (!sessionId) {
      return c.json(unauthenticated(), 401);
    }

    const sessionRow = db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .get();
    if (!sessionRow) {
      return c.json(unauthenticated(), 401);
    }

    if (clock() >= sessionRow.expiresAt) {
      return c.json(unauthenticated(), 401);
    }

    const userRow = db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, sessionRow.userId))
      .get();
    if (!userRow) {
      // Orphan session (user deleted between auth and now). Fail closed.
      return c.json(unauthenticated(), 401);
    }

    c.set("user", { id: userRow.id, email: userRow.email });
    c.set("session", {
      id: sessionRow.id,
      user_id: sessionRow.userId,
      expires_at: sessionRow.expiresAt,
    });
    await next();
  };
}
