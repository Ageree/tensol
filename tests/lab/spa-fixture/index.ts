// Sprint 16 — SPA fixture for browser-worker SPA discovery tests.
//
// Simulates a single-page application that calls history.pushState after
// a short delay. Used by tests/integration/browser/spa-discovery.test.ts.
//
// Endpoints:
//   GET  /          — HTML + inline JS: pushState /about (100ms), /contact (200ms)
//   GET  /about     — HTML + inline JS: pushState /about/team (100ms) [depth-2]
//   GET  /about/team — static "Team page"
//   GET  /contact   — static "Contact page"
//   GET  /healthz   — { ok: true }
//
// P10: fileURLToPath(import.meta.url) for any path resolution.

import { fileURLToPath } from 'node:url';
import { type Context, Hono } from 'hono';

// Satisfy P10: keep a resolved __filename for callers that need absolute paths.
export const __filename = fileURLToPath(import.meta.url);

export interface SpaLabHandle {
  readonly port: number;
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

export interface SpaLabApp {
  readonly app: Hono;
}

export const createSpaLabApp = (): SpaLabApp => {
  const app = new Hono();

  // Root page: pushState /about and /contact after short delays.
  // The SPA_OBSERVER_SCRIPT injected via page.addInitScript() patches history.pushState
  // before this inline script runs, so the observer captures these calls automatically.
  app.get('/', (c: Context) =>
    c.html(`<!doctype html>
<html>
<head><title>SPA Root</title></head>
<body>
  <h1>SPA Root</h1>
  <a href="/about">About</a>
  <a href="/contact">Contact</a>
  <script>
    setTimeout(function() { history.pushState({}, '', '/about'); }, 100);
    setTimeout(function() { history.pushState({}, '', '/contact'); }, 200);
  </script>
</body>
</html>`),
  );

  // About page: pushState /about/team (depth-2 for B4 depth budget test).
  app.get('/about', (c: Context) =>
    c.html(`<!doctype html>
<html>
<head><title>About</title></head>
<body>
  <h1>About</h1>
  <a href="/about/team">Team</a>
  <script>
    setTimeout(function() { history.pushState({}, '', '/about/team'); }, 100);
  </script>
</body>
</html>`),
  );

  app.get('/about/team', (c: Context) =>
    c.html(`<!doctype html>
<html><head><title>Team</title></head><body><h1>Team page</h1></body></html>`),
  );

  app.get('/contact', (c: Context) =>
    c.html(`<!doctype html>
<html><head><title>Contact</title></head><body><h1>Contact page</h1></body></html>`),
  );

  app.get('/healthz', (c: Context) => c.json({ ok: true }));

  return { app };
};

export const startSpaLab = async (port = 0): Promise<SpaLabHandle> => {
  const { app } = createSpaLabApp();
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
