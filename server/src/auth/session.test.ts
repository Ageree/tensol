/**
 * T022 — session cookie helper tests.
 *
 * Verifies cookie attributes (HttpOnly, Secure, SameSite, Path, Max-Age)
 * via Hono's in-process request pipeline. Each test mounts a tiny route,
 * issues `app.request()`, and asserts on the `Set-Cookie` response header.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from "./session";

const SESSION_ID = "sess-123";
const MAX_AGE_30D_SEC = 30 * 24 * 60 * 60;

describe("setSessionCookie", () => {
  test("sets HttpOnly + Secure + SameSite=None + Path=/ + Max-Age on production", async () => {
    const app = new Hono();
    app.get("/set", (c) => {
      setSessionCookie(c, SESSION_ID, { isProd: true });
      return c.text("ok");
    });

    const res = await app.request("/set");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${SESSION_ID}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    // Prod is cross-origin (SPA on sthrip.dev / Vercel → api.tensol.ru), so
    // the session cookie must be SameSite=None (with Secure) to ride along
    // on cross-site credentialed fetches. Non-prod stays Lax (see below).
    expect(setCookie).toMatch(/SameSite=None/i);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`Max-Age=${MAX_AGE_30D_SEC}`);
  });

  test("omits Secure flag in non-prod (development/localhost)", async () => {
    const app = new Hono();
    app.get("/set", (c) => {
      setSessionCookie(c, SESSION_ID, { isProd: false });
      return c.text("ok");
    });

    const res = await app.request("/set");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${SESSION_ID}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  test("respects custom maxAgeMs (converted to seconds)", async () => {
    const app = new Hono();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    app.get("/set", (c) => {
      setSessionCookie(c, SESSION_ID, {
        isProd: true,
        maxAgeMs: TWO_HOURS_MS,
      });
      return c.text("ok");
    });

    const res = await app.request("/set");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`Max-Age=${TWO_HOURS_MS / 1000}`);
  });
});

describe("clearSessionCookie", () => {
  test("emits cookie that erases the session on logout (Max-Age=0 or expired Expires)", async () => {
    const app = new Hono();
    app.get("/clear", (c) => {
      clearSessionCookie(c, { isProd: true });
      return c.text("ok");
    });

    const res = await app.request("/clear");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(SESSION_COOKIE_NAME);
    expect(setCookie).toContain("Path=/");
    // Hono's deleteCookie sets Max-Age=0 and an Expires date in the past.
    const cleared =
      /Max-Age=0\b/i.test(setCookie ?? "") ||
      /Expires=Thu, 01 Jan 1970/i.test(setCookie ?? "");
    expect(cleared).toBe(true);
  });
});

describe("readSessionCookie", () => {
  test("returns sessionId from request Cookie header", async () => {
    const app = new Hono();
    app.get("/whoami", (c) => {
      const sid = readSessionCookie(c);
      return c.text(sid ?? "<none>");
    });

    const res = await app.request("/whoami", {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=read-me` },
    });
    const body = await res.text();
    expect(body).toBe("read-me");
  });

  test("returns undefined when no session cookie present", async () => {
    const app = new Hono();
    app.get("/whoami", (c) => {
      const sid = readSessionCookie(c);
      return c.text(sid ?? "<none>");
    });

    const res = await app.request("/whoami");
    const body = await res.text();
    expect(body).toBe("<none>");
  });
});

describe("set → read round-trip", () => {
  test("setSessionCookie value is recoverable via readSessionCookie on next request", async () => {
    const app = new Hono();
    app.get("/set", (c) => {
      setSessionCookie(c, "round-trip-sid", { isProd: false });
      return c.text("ok");
    });
    app.get("/who", (c) => c.text(readSessionCookie(c) ?? "<none>"));

    const setRes = await app.request("/set");
    const setCookie = setRes.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();

    // Pull just the `name=value` pair out of the Set-Cookie header to send
    // back as a Cookie header on the follow-up request.
    const cookiePair = (setCookie ?? "").split(";")[0]?.trim();
    expect(cookiePair).toBe(`${SESSION_COOKIE_NAME}=round-trip-sid`);

    const whoRes = await app.request("/who", {
      headers: { Cookie: cookiePair ?? "" },
    });
    expect(await whoRes.text()).toBe("round-trip-sid");
  });
});
