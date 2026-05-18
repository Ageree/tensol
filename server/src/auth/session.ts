/**
 * T022 — session cookie I/O helpers.
 *
 * Thin wrappers around Hono's `setCookie / deleteCookie / getCookie` that
 * pin the cookie name + security flags in one place. The shape is just
 * I/O — session creation/validation/expiry lives in T021 (`magic-link.ts`,
 * `withTx`-backed inserts) and T023 (`requireAuth` middleware).
 *
 * Security flags:
 *   - `HttpOnly`     — JS cannot read the cookie (XSS mitigation).
 *   - `Secure`       — sent only over HTTPS in production; relaxed in
 *                      development so localhost flows work without a TLS
 *                      proxy. Toggled by `opts.isProd` (defaults to
 *                      `config.NODE_ENV === "production"`).
 *   - `SameSite=Lax` — CSRF mitigation; allows top-level GET navigations
 *                      (so magic-link redirects still attach the cookie)
 *                      but blocks cross-site POST.
 *   - `Path=/`       — visible to every route in the app.
 *
 * Max-Age defaults to 30 days to match `DEFAULT_SESSION_TTL_MS` in
 * `magic-link.ts`. Hono expects seconds (not ms), so we divide.
 */

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { getConfig } from "../config";

export const SESSION_COOKIE_NAME = "tensol_session";

const DEFAULT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolve the production flag. Callers may inject `isProd` explicitly
 * (preferred in tests) or let the helper consult the lazy config
 * singleton. Wrapping `getConfig` in try/catch keeps these helpers usable
 * from unit tests that never call `loadConfig`; in that case we default
 * to the safer non-prod mode (no Secure flag → testable over plain HTTP).
 */
function resolveIsProd(opts?: { isProd?: boolean }): boolean {
  if (opts?.isProd !== undefined) {
    return opts.isProd;
  }
  try {
    return getConfig().NODE_ENV === "production";
  } catch {
    return false;
  }
}

export function setSessionCookie(
  c: Context,
  sessionId: string,
  opts?: { isProd?: boolean; maxAgeMs?: number },
): void {
  const isProd = resolveIsProd(opts);
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS;

  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: isProd,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(
  c: Context,
  opts?: { isProd?: boolean },
): void {
  const isProd = resolveIsProd(opts);
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
    secure: isProd,
  });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}
