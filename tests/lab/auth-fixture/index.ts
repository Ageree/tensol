// Sprint 15 — lab auth fixture (Hono).
//
// Tiny form-login app for browser-auth integration tests. NEVER bundled
// into production — lives under tests/lab/ only.
//
// Endpoints:
//   GET  /             — HTML login form
//   POST /login        — accepts { username, password }, sets session cookie
//   GET  /protected    — 200 if session cookie present, 401 if not
//   GET  /healthz      — { ok: true }
//
// Valid credentials: LAB_USERNAME / LAB_PASSWORD (constants, test-only).

import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export const LAB_USERNAME = 'lab-user';
export const LAB_PASSWORD = 'lab-pass';
const SESSION_COOKIE = 'lab_session';
const SESSION_VALUE = 'authenticated';

export interface AuthLabApp {
  readonly app: Hono;
}

export const createAuthLabApp = (): AuthLabApp => {
  const app = new Hono();

  app.get('/', (c: Context) =>
    c.html(`<!doctype html>
<html>
<body>
  <form method="POST" action="/login">
    <input id="username" name="username" type="text" />
    <input id="password" name="password" type="password" />
    <button id="submit" type="submit">Login</button>
  </form>
</body>
</html>`),
  );

  app.post('/login', async (c: Context) => {
    const body = await c.req.parseBody();
    const { username, password } = body;
    if (username === LAB_USERNAME && password === LAB_PASSWORD) {
      setCookie(c, SESSION_COOKIE, SESSION_VALUE, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      });
      return c.redirect('/protected');
    }
    return c.html('<p>Invalid credentials</p>', 401);
  });

  app.get('/protected', (c: Context) => {
    const session = getCookie(c, SESSION_COOKIE);
    if (session === SESSION_VALUE) {
      return c.html('<div class="dashboard">Welcome</div>');
    }
    return c.html('<p>Unauthorized</p>', 401);
  });

  app.get('/healthz', (c: Context) => c.json({ ok: true }));

  return { app };
};

export interface AuthLabHandle {
  readonly port: number;
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

export const startAuthLab = async (port = 0): Promise<AuthLabHandle> => {
  const { app } = createAuthLabApp();
  const server = Bun.serve({ port, fetch: app.fetch });
  const actualPort = Number(server.port ?? port);
  return {
    port: actualPort,
    origin: `http://localhost:${actualPort}`,
    stop: async (): Promise<void> => {
      server.stop(true);
    },
  };
};
