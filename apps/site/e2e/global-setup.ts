import { startDevServer } from './helpers/dev-server.ts';

const BASE_URL = process.env.PW_BASE_URL ?? 'http://127.0.0.1:5175';

export default async function globalSetup(): Promise<void> {
  await startDevServer();
  // Pre-warm Vite's module graph so cold-start parallel workers don't race
  // against the initial esbuild prebundle. Without this, body.innerText can
  // briefly contain raw i18n key text before the lazy modules resolve.
  await fetch(BASE_URL).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
}
