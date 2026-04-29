#!/usr/bin/env bun
// `bun run lab:xss` entrypoint. Boots the lab on http://localhost:5081.
//
// Sprint 9 product-spec line 421: lab fixture is reachable on
// localhost:5081 during IT and via this script. NEVER bundled into prod.

import { startXssLab } from '../index.ts';

// biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature.
const PORT = Number.parseInt(process.env['LAB_XSS_PORT'] ?? '5081', 10);

const main = async (): Promise<void> => {
  const handle = await startXssLab(PORT);
  process.stderr.write(`[lab-xss] listening on ${handle.origin}\n`);
  const shutdown = async (): Promise<void> => {
    await handle.stop();
    process.stderr.write('[lab-xss] stopped\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

await main();
