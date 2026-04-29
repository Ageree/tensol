// Sprint 9 — lab XSS fixture (Hono).
//
// Standalone Hono app with deliberately vulnerable endpoints used by
// browser-worker integration tests. NEVER bundled into production:
//   - lives under tests/lab/, not apps/* or services/*
//   - workspace name @cyberstrike/lab-xss-fixture; not depended on by
//     any apps/* or services/* package
//   - bin/run.ts is the only external entry point (`bun run lab:xss`)
//
// Endpoints:
//   GET  /search?q=<reflected>   — vulnerable: <div>${q}</div> raw render
//   GET  /redirect-evil          — 302 to https://evil.example/ (deny probe)
//   GET  /healthz                — { ok: true }
//
// Hit-counters are exposed via getHitCounters() so ITs can assert that
// the worker NEVER fetched a denied destination (A-BR-NavBeforeFetch IT).

import { type Context, Hono } from 'hono';

export interface XssLabHitCounters {
  search: number;
  redirectEvil: number;
  healthz: number;
}

export interface XssLabApp {
  app: Hono;
  resetCounters: () => void;
  getCounters: () => XssLabHitCounters;
}

export const createXssLabApp = (): XssLabApp => {
  const counters: XssLabHitCounters = {
    search: 0,
    redirectEvil: 0,
    healthz: 0,
  };

  const app = new Hono();

  app.get('/healthz', (c: Context) => {
    counters.healthz += 1;
    return c.json({ ok: true });
  });

  app.get('/search', (c: Context) => {
    counters.search += 1;
    const q = c.req.query('q') ?? '';
    // INTENTIONALLY raw — this is the XSS sink. NEVER do this in real code.
    const body = `<!doctype html><html><head><title>lab</title></head><body><div>${q}</div></body></html>`;
    return c.html(body);
  });

  app.get('/redirect-evil', (c: Context) => {
    counters.redirectEvil += 1;
    return c.redirect('https://evil.example/', 302);
  });

  return {
    app,
    resetCounters: (): void => {
      counters.search = 0;
      counters.redirectEvil = 0;
      counters.healthz = 0;
    },
    getCounters: (): XssLabHitCounters => ({ ...counters }),
  };
};

export interface XssLabHandle {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly port: number;
  readonly origin: string;
  readonly getCounters: () => XssLabHitCounters;
  readonly resetCounters: () => void;
  readonly stop: () => Promise<void>;
}

export const startXssLab = async (port = 0): Promise<XssLabHandle> => {
  const lab = createXssLabApp();
  const server = Bun.serve({
    port,
    fetch: lab.app.fetch,
  });
  const actualPort = Number(server.port ?? port);
  return {
    server,
    port: actualPort,
    origin: `http://localhost:${actualPort}`,
    getCounters: lab.getCounters,
    resetCounters: lab.resetCounters,
    stop: async (): Promise<void> => {
      server.stop(true);
    },
  };
};
