import { startDevServer } from './helpers/dev-server.ts';
import { startBackend } from './helpers/backend-server.ts';

const BASE_URL = process.env.PW_BASE_URL ?? 'http://127.0.0.1:5175';

export default async function globalSetup(): Promise<void> {
  // T090 — Boot the in-memory Tensol backend before vite so the dev
  // proxy has somewhere to route /api/* requests. The backend port is
  // exported via VITE_DEV_API_TARGET so vite.config.ts picks it up when
  // it starts a fresh process.
  const backend = await startBackend();
  process.env.VITE_DEV_API_TARGET = backend.baseUrl;
  process.env.TENSOL_E2E_BACKEND_BASE_URL = backend.baseUrl;

  await startDevServer();
  // Pre-warm Vite's module graph so cold-start parallel workers don't race
  // against the initial esbuild prebundle. Without this, body.innerText can
  // briefly contain raw i18n key text before the lazy modules resolve.
  await fetch(BASE_URL).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
}
