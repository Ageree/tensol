/**
 * T051 — Server boot path with reconcile-on-startup.
 *
 * Layout
 *   This file exposes three pieces so tests (and the future docker entry
 *   point) can compose the same boot sequence used at runtime:
 *
 *     - `bootstrap(deps)` — runs reconcileInFlight against the supplied
 *       VPS provider and returns the reconcile counts. Pure orchestration,
 *       no listener, no migrations, no env-var reads. Test-friendly.
 *
 *     - `createApp(deps)` — assembles the Hono app with /healthz plus
 *       every route subrouter wired in (auth, scans, webhooks). Pure
 *       factory, no listener. Legacy projects/targets/auth-proof routes
 *       removed in T016; replaced by `/v1/scan-orders/*` (T034+).
 *
 *     - `main()` — wires the production composition: loadConfig, createDb,
 *       apply migrations, createHetznerProvider, bootstrap, createRunner +
 *       start, createApp, and finally `Bun.serve`. Invoked only when this
 *       file runs as the process entry (`import.meta.main`).
 *
 * Why a separate `bootstrap` vs inlining inside `main`
 *   The integration test (`tests/integration/reconcile.test.ts`) needs to
 *   prove that boot reconciles every `running` scan BEFORE the HTTP
 *   listener accepts traffic. Spinning up `Bun.serve` in a unit test
 *   makes the harness environment-coupled (PORT contention, async socket
 *   teardown, etc.). Extracting the reconcile step into an awaitable
 *   factory means the test can drive the exact contract — "reconcile
 *   completes before listen()" — without paying for a real server.
 *
 * Migration application
 *   We read the on-disk SQL files under `migrations/*.sql` and execute
 *   them sequentially against the freshly-opened SQLite handle. The
 *   helper is idempotent: it sniffs whether the canonical `users` table
 *   already exists and skips re-applying the SQL if so. This makes the
 *   boot path safe to re-invoke on a warm DB (the production scenario).
 *
 * NOT in this file
 *   - Migration GENERATION (that's `bun run db:generate` via drizzle-kit).
 *   - Process-level signal handling (SIGTERM/SIGINT graceful shutdown):
 *     T067 / Phase 6 will lift that into a dedicated module.
 */
import { Hono } from "hono";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { loadConfig, type Config } from "./config.ts";
import { createDb, type DB } from "./db/client.ts";
import { reconcileInFlight, type ReconcileResult } from "./scans/reconcile.ts";
import type { VpsProvider } from "./vps/provider.ts";
import { createHetznerProvider } from "./vps/hetzner.ts";
import { createRunner, type Dispatcher } from "./jobs/runner.ts";
import { createSpawnVpsHandler } from "./jobs/handlers/spawn-vps.ts";
import { createDispatchScanHandler } from "./jobs/handlers/dispatch-scan.ts";
import { createTeardownVpsHandler } from "./jobs/handlers/teardown-vps.ts";
import { createSpawnYandexVmHandler } from "./jobs/handlers/spawn-yandex-vm.ts";
import { createTeardownYandexVmHandler } from "./jobs/handlers/teardown-yandex-vm.ts";
import { createRenderPdfHandler } from "./jobs/handlers/render-pdf.ts";
import { createSendScanCompleteTelegramHandler } from "./jobs/handlers/send-scan-complete-telegram.ts";
import { createScanTimeoutWatcher } from "./jobs/handlers/scan-timeout-watcher.ts";
import { createYandexCloudProvider } from "./vps/yandex.ts";
import { refundFreeQuickQuota } from "./free-tier/service.ts";
import { createLoggingTelegramNotifier } from "./notify/telegram-placeholder.ts";
import { S3Client } from "@aws-sdk/client-s3";
import { createEmailClient } from "./email/resend-client.ts";
import { createAuthRoutes } from "./routes/auth.ts";
import { createScansRouter } from "./routes/scans.ts";
import { createScanOrdersRouter } from "./routes/scan-orders.ts";
import { createWebhookRoutes } from "./routes/webhooks.ts";
import { createScanOrdersService } from "./scan-orders/service.ts";
import { createRequireAuth } from "./auth/middleware.ts";

/**
 * T066 — periodic watchdog cadence for the scan-timeout watcher (T064).
 * The watcher itself is cron-style (no payload job) — `tick()` is invoked
 * on a setInterval-style schedule from `main()`. Default 5 minutes per
 * tasks.md T126.
 */
const SCAN_TIMEOUT_WATCHER_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * T066 — adapt new-style handlers `(jobId, rawPayload) => Promise<void>` to
 * the legacy runner `Handler<P>` shape `(payload, ctx) => Promise<void>`.
 *
 * The 002 handlers (T056/T058/T060/T062) deliberately decouple payload
 * normalization from the runner's typed dispatch — they accept the raw
 * parsed JSON and run dual-case (camelCase + snake_case) normalization
 * inside the handler. The runner, by contrast, still hands them the
 * typed payload object first + a context bag second (legacy contract).
 * This adapter bridges the two without touching either side's signature.
 */
function adaptNewStyle(
  inner: (jobId: string, rawPayload: unknown) => Promise<void>,
): (payload: unknown, ctx: { jobId: string; attempts: number }) => Promise<void> {
  return (payload, ctx) => inner(ctx.jobId, payload);
}

/**
 * Default filesystem path for the production SQLite handle.
 *
 * The config schema (T005) does not include a DATABASE_PATH knob because
 * the project's deployment model is single-binary with a fixed data dir.
 * If T067 / Phase 6 needs the path configurable we'll lift it into the
 * Zod schema then; for now this single constant is the source of truth.
 */
const DEFAULT_DATABASE_PATH = "./data/tensol.db";

/** Default location of migration `.sql` files relative to this module. */
const DEFAULT_MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

/**
 * Conditional-spread helper for `now?: () => number` props.
 *
 * Why this helper exists
 *   `tsconfig.json` sets `exactOptionalPropertyTypes: true`, which means
 *   `{ now: undefined }` is NOT assignable to a target whose `now` is
 *   typed as `now?: () => number` (the target expects either `() => number`
 *   present OR the key absent — never the explicit `undefined`). Spreading
 *   `maybeNow(now)` into a deps literal preserves "absent when undefined"
 *   semantics while keeping callsites readable.
 */
function maybeNow(now?: () => number): { now?: () => number } {
  return now === undefined ? {} : { now };
}

/** Same shape as `maybeNow` but for an arbitrary optional string field. */
function maybeProp<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

// ===========================================================================
// bootstrap — reconcile-on-startup
// ===========================================================================

export interface BootstrapDeps {
  readonly db: DB;
  readonly vpsProvider: VpsProvider;
  readonly signingKey: string;
  readonly now?: () => number;
}

export interface BootstrapResult {
  readonly reconcileResult: ReconcileResult;
}

/**
 * Run the boot-time reconciliation. Call this AFTER opening the DB +
 * applying migrations and BEFORE starting the HTTP listener.
 *
 * Reconcile errors propagate to the caller — the production `main()`
 * treats a reconcile failure as a hard boot failure (better to refuse
 * to start than serve traffic with an unreconciled state).
 */
export async function bootstrap(
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const reconcileResult = await reconcileInFlight(deps.db, {
    vpsProvider: deps.vpsProvider,
    signingKey: deps.signingKey,
    ...maybeNow(deps.now),
  });
  return { reconcileResult };
}

// ===========================================================================
// createApp — Hono assembly
// ===========================================================================

export interface CreateAppDeps {
  readonly db: DB;
  readonly signingKey: string;
  /** Session cookie HMAC secret (separate from audit signing key). */
  readonly sessionCookieSecret: string;
  /** Magic-link email base URL (also used as webhook callback origin). */
  readonly baseUrl: string;
  /** Email delivery mode + creds. */
  readonly emailMode: "stdout" | "resend";
  readonly resendApiKey?: string;
  readonly isProd: boolean;
  readonly now?: () => number;
}

/**
 * Compose the Hono app. The factory does not start a listener — pass
 * the returned app's `fetch` to `Bun.serve` once the rest of the boot
 * path is wired.
 */
export function createApp(deps: CreateAppDeps): Hono {
  const {
    db,
    signingKey,
    baseUrl,
    emailMode,
    resendApiKey,
    isProd,
    now,
  } = deps;

  const app = new Hono();

  // Health probe is registered before auth so load-balancers can probe
  // the process without holding a session.
  app.get("/healthz", (c) => c.json({ ok: true }));

  const email = createEmailClient({
    mode: emailMode,
    ...maybeProp("resendApiKey", resendApiKey),
  });

  app.route(
    "/api/auth",
    createAuthRoutes({
      db,
      email,
      signingKey,
      baseUrl,
      isProd,
      ...maybeNow(now),
    }),
  );
  // Legacy projects/targets/auth-proof route mounts removed (T016) — the
  // backing tables were dropped in migration 0010 (T011). DNS-TXT auth-
  // proof for the blackbox MVP arrives via `/v1/scan-orders/*` (T034+).
  app.route(
    "/api/webhooks",
    createWebhookRoutes({ db, signingKey, ...maybeNow(now) }),
  );

  // T071 — `/v1/scans/*` simplified read API (US1). Owner-scoped via
  // direct scans.user_id (no projects/targets JOIN — those tables were
  // dropped in 0010). Mounts BEFORE /v1/scan-orders to share the same
  // requireAuth middleware factory.
  const requireAuthForScans = createRequireAuth({ db, ...maybeNow(now) });
  app.route(
    "/v1/scans",
    createScansRouter({
      db,
      auditKey: signingKey,
      requireAuth: requireAuthForScans,
      ...maybeNow(now),
    }),
  );

  // T067 — /v1/scan-orders/* (US1 wizard surface). Constitution IX: every
  // route validates body via Zod; the service emits all signed audit rows.
  const scanOrdersService = createScanOrdersService({
    db,
    auditKey: signingKey,
    ...maybeNow(now),
  });
  const requireAuthForScanOrders = createRequireAuth({
    db,
    ...maybeNow(now),
  });
  app.route(
    "/v1/scan-orders",
    createScanOrdersRouter({
      service: scanOrdersService,
      requireAuth: requireAuthForScanOrders,
    }),
  );

  return app;
}

// ===========================================================================
// Migration helper — idempotent over an already-migrated SQLite handle
// ===========================================================================

/**
 * Apply every `.sql` file under `migrationsDir` to the open SQLite
 * connection. Idempotent: if the canonical `users` table already exists
 * we treat the schema as up to date and return without re-running SQL.
 *
 * Why a `users` table sniff and not a `__drizzle_migrations` ledger:
 *   drizzle-kit's bun-sqlite migrator writes its own bookkeeping table,
 *   but our deployment uses raw `.sql` files (no drizzle-kit at runtime)
 *   so we don't have that ledger. A presence check on the first business
 *   table covers our only two boot scenarios — fresh DB (no users table
 *   → apply) and warm DB (users table exists → skip).
 *
 * Schema drift between code and DB is NOT handled here — it surfaces
 * later as a query-time SQLite error and is best caught by the
 * verify-chain / integration test suite.
 */
export function applyMigrationsOnce(
  db: DB,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): { applied: boolean } {
  if (!existsSync(migrationsDir)) {
    throw new Error(`migrations directory not found: ${migrationsDir}`);
  }
  const raw = db.$client as Database;
  const usersExists = raw
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
    )
    .get();
  if (usersExists) {
    return { applied: false };
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no migration files found in ${migrationsDir}`);
  }
  const combined = files
    .map((f) =>
      readFileSync(join(migrationsDir, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
  raw.exec(combined);
  return { applied: true };
}

// ===========================================================================
// main — production composition
// ===========================================================================

/**
 * Production entry point. Wires every concrete dependency from `config.ts`
 * and starts a Bun listener once reconcile completes.
 *
 * Order matters:
 *   1. loadConfig — fail fast on missing env vars.
 *   2. createDb + applyMigrationsOnce — DB ready before any read/write.
 *   3. createHetznerProvider — VPS provider for reconcile + runner.
 *   4. bootstrap — reconcile every `running` scan BEFORE listener.
 *   5. createRunner + start — accept new jobs.
 *   6. Bun.serve — accept HTTP traffic.
 */
export async function main(): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
  const config: Config = loadConfig(
    process.env as Record<string, string | undefined>,
  );
  const db = createDb(DEFAULT_DATABASE_PATH);
  applyMigrationsOnce(db);

  const vpsProvider = createHetznerProvider({
    apiToken: config.HETZNER_API_TOKEN,
    location: config.HETZNER_LOCATION,
    serverType: config.HETZNER_SERVER_TYPE,
    image: config.HETZNER_IMAGE,
    sshKeyName: config.HETZNER_SSH_KEY_NAME,
    vpsAgentImage: config.TENSOL_VPS_AGENT_IMAGE,
    webhookBaseUrl: config.TENSOL_WEBHOOK_BASE_URL,
  });

  const { reconcileResult } = await bootstrap({
    db,
    vpsProvider,
    signingKey: config.TENSOL_AUDIT_SIGNING_KEY,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[tensol] reconcile: checked=${reconcileResult.checked} unchanged=${reconcileResult.unchanged} failed=${reconcileResult.failed} teardown_enqueued=${reconcileResult.teardown_enqueued}`,
  );

  // Wire job dispatcher + runner. We pass the same VPS provider so the
  // teardown handler can reach back into the cloud API for the rows the
  // reconciler just enqueued.
  //
  // T066 — wire the new 002 handlers alongside the legacy 4. New handlers
  // require external creds (Yandex, S3, Telegram); we read each optional
  // env var and degrade gracefully when missing — production deployments
  // populate `.env.yandex` per the handoff doc. Boot does NOT fail when
  // a 002 cred is missing; the handler itself throws at invoke time so
  // the runner's permanent-failure branch captures it in the audit log.
  const yandexProvider = createYandexCloudProvider();
  const evidenceBucket = process.env.TENSOL_EVIDENCE_BUCKET ?? "";
  const awsRegion = process.env.AWS_REGION ?? "ru-central1";
  const awsEndpoint =
    process.env.AWS_ENDPOINT_URL ?? "https://storage.yandexcloud.net";
  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "";
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "";
  const decepticonImage =
    process.env.DECEPTICON_IMAGE ?? "ghcr.io/purpleailab/decepticon:latest";
  const vpsZone = process.env.YANDEX_PROD_SUBNET_ZONE ?? "ru-central1-a";
  const evidencePrefix = process.env.TENSOL_EVIDENCE_PREFIX ?? "scans/";

  if (!evidenceBucket || !awsAccessKeyId || !awsSecretAccessKey) {
    // eslint-disable-next-line no-console
    console.warn(
      "[tensol] T066: S3/Object-Storage env vars missing — render_pdf + " +
        "send_scan_complete_telegram + spawn_yandex_vm will fail at invoke time. " +
        "Set TENSOL_EVIDENCE_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.",
    );
  }

  const s3 = new S3Client({
    region: awsRegion,
    endpoint: awsEndpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey,
    },
  });

  const telegramNotifier = createLoggingTelegramNotifier();
  // eslint-disable-next-line no-console
  console.warn(
    "[tensol] T066: TelegramNotifier = LoggingTelegramNotifier (placeholder). " +
      "T096 will replace with the production bot-API client.",
  );

  const spawnYandexVm = adaptNewStyle(
    createSpawnYandexVmHandler({
      db,
      provider: yandexProvider,
      auditKey: config.TENSOL_AUDIT_SIGNING_KEY,
      refundFreeQuickQuota,
      vpsZone,
      backendUrl: config.TENSOL_WEBHOOK_BASE_URL,
      webhookSecret: config.TENSOL_AUDIT_SIGNING_KEY,
      evidenceBucket,
      evidencePrefix,
      awsAccessKeyId,
      awsSecretAccessKey,
      awsEndpoint,
      awsRegion,
      signKey: config.TENSOL_AUDIT_SIGNING_KEY,
      decepticonImage,
      vpsAgentImage: config.TENSOL_VPS_AGENT_IMAGE,
    }),
  );
  const teardownYandexVm = adaptNewStyle(
    createTeardownYandexVmHandler({
      db,
      provider: yandexProvider,
      auditKey: config.TENSOL_AUDIT_SIGNING_KEY,
    }),
  );
  const renderPdf = adaptNewStyle(
    createRenderPdfHandler({
      db,
      s3,
      bucket: evidenceBucket,
      auditKey: config.TENSOL_AUDIT_SIGNING_KEY,
    }),
  );
  const sendScanCompleteTelegram = adaptNewStyle(
    createSendScanCompleteTelegramHandler({
      db,
      s3,
      telegramNotifier,
      auditKey: config.TENSOL_AUDIT_SIGNING_KEY,
    }),
  );

  const dispatcher: Dispatcher = {
    spawn_vps: createSpawnVpsHandler({
      db,
      vpsProvider,
      signingKey: config.TENSOL_AUDIT_SIGNING_KEY,
    }),
    dispatch_scan: createDispatchScanHandler({
      db,
      signingKey: config.TENSOL_AUDIT_SIGNING_KEY,
      webhookBaseUrl: config.TENSOL_WEBHOOK_BASE_URL,
    }),
    // T065 / Phase 6 will land the real watchdog handler. Until then we
    // mark watchdog jobs done immediately so the queue doesn't accrete
    // pending rows. The audit chain remains valid because nothing emits
    // watchdog audits at this stage.
    watchdog_scan: async () => {},
    teardown_vps: createTeardownVpsHandler({
      db,
      vpsProvider,
      signingKey: config.TENSOL_AUDIT_SIGNING_KEY,
    }),
    // T066 — 002 additions (E7). Adapted to legacy `(payload, ctx)` shape
    // via `adaptNewStyle`.
    spawn_yandex_vm: spawnYandexVm,
    teardown_yandex_vm: teardownYandexVm,
    render_pdf: renderPdf,
    send_scan_complete_telegram: sendScanCompleteTelegram,
    // `retry_telegram_notification` is a no-op-acknowledged placeholder
    // until T096 wires the real operator-alert dispatcher. Failed jobs
    // (vm spawn / teardown / pdf render) still INSERT rows of this kind;
    // the no-op marks them done so they don't accrete.
    retry_telegram_notification: async () => {},
  };
  const runner = createRunner({
    db,
    dispatcher,
    signingKey: config.TENSOL_AUDIT_SIGNING_KEY,
  });
  runner.start();

  // T066 — wire the scan-timeout watcher (T064) on a 5-minute cadence.
  // Cron-style: we invoke `tick()` directly via setInterval rather than
  // shoehorn it into the jobs table — the watcher itself manages
  // idempotency via a conditional UPDATE inside `tick()`.
  const watcher = createScanTimeoutWatcher({
    db,
    refundFreeQuickQuota: async (userId) => refundFreeQuickQuota(db, userId),
    auditKey: config.TENSOL_AUDIT_SIGNING_KEY,
  });
  const watcherTimer = setInterval(() => {
    watcher.tick().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(
        "[tensol] T066: scan-timeout-watcher tick failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, SCAN_TIMEOUT_WATCHER_INTERVAL_MS);
  // Unref so the interval doesn't keep the process alive on graceful
  // shutdown — `runner.stop()` already awaits any in-flight handler.
  if (typeof watcherTimer.unref === "function") watcherTimer.unref();

  const app = createApp({
    db,
    signingKey: config.TENSOL_AUDIT_SIGNING_KEY,
    sessionCookieSecret: config.TENSOL_SESSION_COOKIE_SECRET,
    baseUrl: config.TENSOL_WEBHOOK_BASE_URL,
    emailMode: config.EMAIL_PROVIDER,
    isProd: config.NODE_ENV === "production",
    ...maybeProp("resendApiKey", config.RESEND_API_KEY),
  });

  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
  });
  // eslint-disable-next-line no-console
  console.log(`[tensol] listening on :${server.port}`);

  // Bun.serve types `port` as `number | undefined` to accommodate unix
  // socket listeners. We always pass a numeric `config.PORT`, so the
  // value is guaranteed defined — coerce with a fallback to satisfy
  // exactOptionalPropertyTypes.
  return {
    port: server.port ?? config.PORT,
    stop: async () => {
      clearInterval(watcherTimer);
      await runner.stop();
      server.stop();
      (db.$client as Database).close();
    },
  };
}

// `bun run src/server.ts` runs main(); otherwise the file is import-only.
if (import.meta.main) {
  // eslint-disable-next-line no-console
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[tensol] boot failed:", err);
    process.exit(1);
  });
}
