/**
 * T090 — In-process Tensol backend launcher for Playwright E2E.
 *
 * Lives inside the `@tensol/server` workspace so its bare imports
 * (`hono`, `drizzle-orm`) resolve naturally against server/node_modules.
 *
 * Composes the real route factories from `../src/routes/*` against:
 *   - a fresh temp-file SQLite (migrations applied via `applyMigrationsOnce`)
 *   - a fake `VpsProvider` (no real Hetzner calls)
 *   - an injected fetchImpl for `dispatch_scan` that 202-accepts without
 *     reaching out to a real VPS
 *   - email mode `stdout` with a custom logger that captures every send so
 *     the spec can extract magic-link tokens deterministically without
 *     fighting child-process stdout buffering.
 *
 * T016: legacy projects/targets/auth-proof route mounts removed; will be
 * rewired around /v1/scan-orders for the blackbox MVP.
 *
 * The launcher binds `Bun.serve` on a dedicated port (default 3001) and
 * adds internal endpoints under `/__test/*` so the Playwright spec can
 * peek server state without provisioning a production-grade API surface.
 *
 * Why this file does NOT call `createApp`:
 *   `createApp` from `../src/server.ts` wires real
 *   `node:dns/promises.resolveTxt` for auth-proof verification. We need
 *   to swap in a fake DNS resolver so the E2E can verify a target
 *   without a public DNS record. We mirror `createApp`'s mount order
 *   exactly, just with our fake `verifyDeps`.
 *
 * MUST be executed under Bun (uses `bun:sqlite`, `Bun.serve`). The
 * Playwright globalSetup launches this file as `bun run` in a separate
 * child process so the Playwright runner itself (Node) is unaffected.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";

import { createDb } from "../src/db/client.ts";
import { applyMigrationsOnce } from "../src/server.ts";
import { createRunner, type Dispatcher } from "../src/jobs/runner.ts";
import { createSpawnVpsHandler } from "../src/jobs/handlers/spawn-vps.ts";
import { createDispatchScanHandler } from "../src/jobs/handlers/dispatch-scan.ts";
import { createTeardownVpsHandler } from "../src/jobs/handlers/teardown-vps.ts";
import type {
  SpawnVpsArgs,
  SpawnedVps,
  VpsProvider,
  VpsStatus,
} from "../src/vps/provider.ts";
import { createAuthRoutes } from "../src/routes/auth.ts";
import { createScansRoutes } from "../src/routes/scans.ts";
import { createWebhookRoutes } from "../src/routes/webhooks.ts";
import { createEmailClient } from "../src/email/resend-client.ts";
import {
  findings as findingsTable,
  vpsInstances as vpsInstancesTable,
} from "../src/db/schema.ts";

const SIGNING_KEY =
  "test-e2e-key-64-chars-hex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export interface TestServerHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly dbPath: string;
  stop(): Promise<void>;
}

/**
 * Fake VpsProvider — deterministic, no cloud calls.
 *
 * `spawnVps` returns a canned ID + IP; `getVpsStatus` always reports
 * 'running' so the spawn_vps handler short-circuits; `destroyVps` no-ops.
 */
function createFakeProvider(): VpsProvider {
  return {
    spawnVps: async (args: SpawnVpsArgs): Promise<SpawnedVps> => ({
      provider_server_id: `fake-${args.scanId.slice(0, 8)}`,
      ipv4: "203.0.113.42",
    }),
    getVpsStatus: async (_id: string): Promise<VpsStatus> => "running",
    destroyVps: async (_id: string): Promise<void> => {
      /* no-op */
    },
  };
}

/**
 * Boot the in-process test server. Caller is responsible for `stop()`-ing
 * the returned handle when the spec finishes.
 *
 * Note (T016): the prior `createFakeVerifyDeps()` helper (legacy auth-proof
 * stub) and its `auth_proofs` table consumer are gone. DNS-TXT verification
 * for the blackbox MVP gets a new fake in the rewritten /v1/scan-orders E2E.
 */
export async function startTestServer(opts?: {
  port?: number;
}): Promise<TestServerHandle> {
  const port = opts?.port ?? 3001;

  // 1. Temp DB.
  const tmpRoot = mkdtempSync(join(tmpdir(), "tensol-e2e-"));
  const dataDir = join(tmpRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "tensol.db");

  const db = createDb(dbPath);
  const migrationsDir = join(import.meta.dir, "..", "migrations");
  applyMigrationsOnce(db, migrationsDir);

  // 2. Email — captured-line logger; the spec polls /__test/email-log.
  const emailLines: string[] = [];
  const email = createEmailClient({
    mode: "stdout",
    logger: (line: string) => {
      emailLines.push(line);
    },
  });

  // 3. Fake VPS provider + dispatch fetch.
  const vpsProvider = createFakeProvider();
  const dispatchFetchImpl: typeof fetch = async () =>
    new Response(null, { status: 202 });

  // 4. Compose app. Mirrors `createApp` mount order minus the real DNS
  //    resolver — we inject our fake `verifyDeps` instead.
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route(
    "/api/auth",
    createAuthRoutes({
      db,
      email,
      signingKey: SIGNING_KEY,
      baseUrl: `http://127.0.0.1:${port}`,
      isProd: false,
    }),
  );
  // Legacy projects/targets/auth-proof route mounts removed (T016) — the
  // backing tables were dropped in migration 0010 (T011). The MVP E2E
  // (T090+) will rewire via `/v1/scan-orders/*` once those routes exist.
  app.route(
    "/api/scans",
    createScansRoutes({ db, signingKey: SIGNING_KEY }),
  );
  app.route(
    "/webhooks",
    createWebhookRoutes({ db, signingKey: SIGNING_KEY }),
  );

  // 5. Internal-only test endpoints.
  app.get("/__test/email-log", (c) =>
    c.json({ lines: emailLines.slice() }),
  );
  app.post("/__test/email-log/clear", (c) => {
    emailLines.length = 0;
    return c.json({ ok: true });
  });

  // Peek the per-VPS HMAC sign_key for a scan. The webhook contract
  // requires the agent (here: the test) to sign the body with the same
  // key spawn_vps minted into vps_instances.sign_key. There is no
  // production endpoint that returns it (deliberately — it is a shared
  // secret), so the E2E exposes this peek route under the /__test prefix
  // which the listener never advertises outside test runs.
  app.get("/__test/vps-sign-key/:scanId", (c) => {
    const scanId = c.req.param("scanId");
    const row = db
      .select()
      .from(vpsInstancesTable)
      .where(eq(vpsInstancesTable.scanId, scanId))
      .orderBy(desc(vpsInstancesTable.createdAt))
      .limit(1)
      .get();
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ sign_key: row.signKey });
  });

  // Peek findings for a scan — used by the E2E to assert the webhook
  // landed a row before any production findings-listing endpoint exists.
  app.get("/__test/findings/:scanId", (c) => {
    const scanId = c.req.param("scanId");
    const rows = db
      .select()
      .from(findingsTable)
      .where(eq(findingsTable.scanId, scanId))
      .all();
    return c.json({ findings: rows });
  });

  // 6. Job runner. Watchdog OFF (would add noise to the audit chain).
  const dispatcher: Dispatcher = {
    spawn_vps: createSpawnVpsHandler({
      db,
      vpsProvider,
      signingKey: SIGNING_KEY,
    }),
    dispatch_scan: createDispatchScanHandler({
      db,
      signingKey: SIGNING_KEY,
      webhookBaseUrl: `http://127.0.0.1:${port}`,
      fetchImpl: dispatchFetchImpl,
    }),
    watchdog_scan: async () => {
      /* unused in E2E */
    },
    teardown_vps: createTeardownVpsHandler({
      db,
      vpsProvider,
      signingKey: SIGNING_KEY,
    }),
  };
  const runner = createRunner({
    db,
    dispatcher,
    signingKey: SIGNING_KEY,
    pollIntervalMs: 100,
    watchdogIntervalMs: 0,
  });
  runner.start();

  // 7. Listen.
  const server = Bun.serve({ port, fetch: app.fetch });

  return {
    port: server.port ?? port,
    baseUrl: `http://127.0.0.1:${server.port ?? port}`,
    dbPath,
    stop: async () => {
      await runner.stop();
      server.stop();
      (db.$client as Database).close();
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// ============================================================================
// CLI entry — `bun run server/scripts/e2e-test-server.ts`
// ============================================================================
// Playwright globalSetup runs this file as a child process so the backend
// is hosted out-of-process from the Node-based Playwright runner. The
// child writes a single-line "READY ${port}" sentinel to stdout once the
// listener is up, then idles on SIGINT/SIGTERM until the parent kills it.
if (import.meta.main) {
  const port = Number(process.env.TENSOL_E2E_PORT ?? "3001");
  const handle = await startTestServer({ port });
  // Sentinel for parent — flushed immediately because Bun does no
  // line-buffering on TTYless stdout writes.
  process.stdout.write(`READY ${handle.port}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(
      `[tensol-test-server] ${signal} — shutting down\n`,
    );
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Hold the loop open.
  setInterval(() => undefined, 1_000_000);
}
