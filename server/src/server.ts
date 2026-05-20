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
 *       every route subrouter wired in (auth, scans, scan-orders, V1+V2
 *       webhooks, feature-flags). Pure factory, no listener. Legacy
 *       projects/targets/auth-proof routes removed in T016; replaced by
 *       `/v1/scan-orders/*` (T034+). The V2 callback `/v1/webhooks/
 *       scan-complete` (T069) + read-only `/v1/config/feature-flags`
 *       (T073) were wired in T074.
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
import { createCleanupOrphanVmsTask } from "./jobs/handlers/cleanup-orphan-vms.ts";
import { createCleanupExpiredReportsHandler } from "./jobs/handlers/cleanup-expired-reports.ts";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  sendMessage as sendTelegramMessage,
  createTelegramNotifier,
} from "./notify/telegram.ts";
import { createYandexCloudProvider } from "./vps/yandex.ts";
import { refundFreeQuickQuota } from "./free-tier/service.ts";
import { createLoggingTelegramNotifier } from "./notify/telegram-placeholder.ts";
import { S3Client } from "@aws-sdk/client-s3";
import { createEmailClient } from "./email/resend-client.ts";
import { createAuthRoutes } from "./routes/auth.ts";
import { createScansRouter } from "./routes/scans.ts";
import { createScanOrdersRouter } from "./routes/scan-orders.ts";
import { createDeepInquiriesRouter } from "./routes/deep-inquiries.ts";
import {
  createAdminDeepInquiriesRouter,
  parseOperatorEmails,
} from "./routes/admin/deep-inquiries.ts";
import { createWebhookRoutes } from "./routes/webhooks.ts";
import { createWebhookScanCompleteRouter } from "./routes/webhooks-scan-complete.ts";
import { createWebhookTelegramRouter } from "./routes/webhooks-telegram.ts";
import { createConfigFeatureFlagsRouter } from "./routes/config-feature-flags.ts";
import { createTestV2Router } from "./routes/__test_v2.ts";
import { createScanOrdersService } from "./scan-orders/service.ts";
import { createDeepInquiriesService } from "./deep-inquiries/service.ts";
import { createRequireAuth } from "./auth/middleware.ts";
import { readSessionCookie } from "./auth/session.ts";
import { sessions as sessionsTable } from "./db/schema.ts";
import { eq } from "drizzle-orm";
import { now as defaultNow } from "./lib/time.ts";
import {
  createRateLimit,
  RATE_LIMIT_AUTH,
  RATE_LIMIT_INQUIRY,
} from "./lib/rate-limit.ts";

/**
 * T066 — periodic watchdog cadence for the scan-timeout watcher (T064).
 * The watcher itself is cron-style (no payload job) — `tick()` is invoked
 * on a setInterval-style schedule from `main()`. Default 5 minutes per
 * tasks.md T126.
 */
const SCAN_TIMEOUT_WATCHER_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * T125 — periodic cadence for the orphan-VM cleanup task (T123).
 * Per research §R10: every 15 minutes. The task is internally idempotent
 * (each tick re-evaluates from scratch via `provider.listInstances`) so
 * overlapping ticks would be safe — we still serialize via setInterval
 * + unref to avoid pinning the event loop on shutdown.
 */
const CLEANUP_ORPHAN_VMS_INTERVAL_MS = 15 * 60 * 1_000;

/** Per-prefix grace windows (research §R10). 30 min for test instances,
 *  120 min for prod scan VMs (~30% margin over the 90-min scan timeout). */
const CLEANUP_ORPHAN_TEST_MIN_AGE_MS = 30 * 60 * 1_000;
const CLEANUP_ORPHAN_PROD_MIN_AGE_MS = 120 * 60 * 1_000;

/**
 * T127 — daily cadence for the cleanup-expired-reports cron (T114).
 *
 * The sweeper enumerates `evidence_artifacts` + `reports` rows whose
 * `expires_at < now`, S3-deletes the object, removes the row, and emits a
 * signed `evidence_pruned` / `report_pruned` audit. Per task brief: daily
 * — once every 24h is sufficient because each row's expiry resolution is
 * already coarse (~hour-scale).
 *
 * Cron-style (no payload job), mirrors the watcher + orphan-VM ticks above.
 * Skipped when S3 / bucket env not configured so the boot path stays
 * env-light for local dev.
 */
const CLEANUP_EXPIRED_REPORTS_INTERVAL_MS = 24 * 60 * 60 * 1_000;

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
  /**
   * T074 — HMAC-SHA256 secret for the V2 `/v1/webhooks/scan-complete`
   * endpoint (T069). Empty string in dev disables the route's signature
   * verification path (every inbound webhook 401s); production sets this
   * via TENSOL_WEBHOOK_SECRET.
   */
  readonly webhookSecret: string;
  /**
   * Pivot 2026-05-19 — Telegram bot webhook secret. Verified by
   * `webhooks-telegram.ts` before parsing the Update body. Empty in dev =
   * the handler drops every inbound (operator must configure setWebhook
   * with a matching --secret_token).
   */
  readonly telegramWebhookSecret: string;
  /**
   * T121 — pre-normalized operator email list (lowercased, trimmed). Source:
   * env `TENSOL_OPERATOR_EMAILS` parsed at startup via `parseOperatorEmails`.
   * Empty list = no operators configured = `/v1/admin/*` returns 403 for
   * every authenticated user (safe default).
   */
  readonly operatorEmails: ReadonlyArray<string>;
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
    webhookSecret,
    telegramWebhookSecret,
    operatorEmails,
    now,
  } = deps;
  // `baseUrl` is currently unused after the email magic-link removal but is
  // kept on the deps shape because operator-facing routes (PDF report links,
  // future webhooks) will pick it up shortly. Silence the unused warning.
  void baseUrl;

  const app = new Hono();

  // Health probe is registered before auth so load-balancers can probe
  // the process without holding a session.
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Pivot 2026-05-19 — email transport is no longer wired into auth (Resend
  // is unavailable to the operator). The factory remains exported because
  // future deep-inquiry confirmations may still ship via email; we deliberately
  // construct it lazily here ONLY if a downstream consumer needs it. For now
  // there are no in-tree consumers, so this is a no-op reference to keep the
  // import alive without instantiating any client.
  void createEmailClient;
  void emailMode;
  void resendApiKey;

  // T145 step-6a — per-IP rate-limit on /api/auth/* (telegram-link issuance
  // is the email-flood successor — same DoS surface). Applied as middleware
  // BEFORE the route mount so it covers every verb. 10 req/min/IP per
  // RATE_LIMIT_AUTH; legitimate retry patterns fit comfortably.
  app.use("/api/auth/*", createRateLimit(RATE_LIMIT_AUTH));
  app.route(
    "/api/auth",
    createAuthRoutes({
      db,
      signingKey,
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

  // T104 — `/v1/deep-inquiries` (US2 lead-gen funnel). Anonymous OR
  // authenticated: the soft `getUserId` reader resolves a session cookie
  // when present, otherwise returns null (anonymous path). The service
  // emits all signed audits.
  const deepInquiriesService = createDeepInquiriesService({
    db,
    auditKey: signingKey,
    ...maybeNow(now),
  });
  const clockForCookie = now ?? defaultNow;
  const getUserIdFromCookie = (c: import("hono").Context): string | null => {
    const sid = readSessionCookie(c);
    if (!sid) return null;
    const sessionRow = db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sid))
      .get();
    if (!sessionRow) return null;
    if (clockForCookie() >= sessionRow.expiresAt) return null;
    return sessionRow.userId;
  };
  // T145 step-6a — per-IP rate-limit on /v1/deep-inquiries (anonymous POST,
  // DB-write + signed-audit per call). 5 req/min/IP per RATE_LIMIT_INQUIRY;
  // tighter than auth because there is no legitimate retry pattern. Hono's
  // `/v1/deep-inquiries/*` glob matches the bare-path mount (`app.route` of
  // a router whose only handler is `app.post("/")`) — verified via probe;
  // see commit body for the test.
  app.use("/v1/deep-inquiries/*", createRateLimit(RATE_LIMIT_INQUIRY));
  app.route(
    "/v1/deep-inquiries",
    createDeepInquiriesRouter({
      service: deepInquiriesService,
      getUserId: getUserIdFromCookie,
    }),
  );

  // T121 — `/v1/admin/deep-inquiries` (operator-only triage surface). Auth
  // is strict (401 on missing/expired cookie) PLUS an operator-email gate
  // (403 when `user.email` is not in `operatorEmails`). The service emits
  // all signed audits.
  const requireAuthForAdmin = createRequireAuth({ db, ...maybeNow(now) });
  app.route(
    "/v1/admin/deep-inquiries",
    createAdminDeepInquiriesRouter({
      service: deepInquiriesService,
      operatorEmails,
      requireAuth: requireAuthForAdmin,
    }),
  );

  // T074 — `/v1/webhooks/scan-complete` (T069 production wiring). Single
  // fleet-wide HMAC secret; signature verification + body validation +
  // audit-log dedup live inside the router. NO auth middleware — vps-agent
  // authenticates via the X-Tensol-Signature header, not a session cookie.
  app.route(
    "/v1/webhooks",
    createWebhookScanCompleteRouter({
      db,
      webhookSecret,
      auditKey: signingKey,
      ...maybeNow(now),
    }),
  );

  // Pivot 2026-05-19 — `/v1/webhooks/telegram-update` (Telegram bot
  // delivery). Verifies the `X-Telegram-Bot-Api-Secret-Token` header
  // before parsing the body. Replies through the same bot using the
  // production `sendMessage` import; in dev (no token configured) the
  // notifier falls back to a no-op so boot doesn't halt.
  const telegramReplyNotifier = {
    async sendMessage(args: { chatId: number; text: string }): Promise<void> {
      try {
        await sendTelegramMessage(args.text, { chatId: args.chatId });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[tensol] telegram reply send failed (non-fatal):",
          err instanceof Error ? err.message : err,
        );
      }
    },
  };
  app.route(
    "/v1/webhooks",
    createWebhookTelegramRouter({
      db,
      signingKey,
      webhookSecret: telegramWebhookSecret,
      notifier: telegramReplyNotifier,
      ...maybeNow(now),
    }),
  );

  // T074 — `/v1/config/feature-flags` (T073). No DI; the route reads
  // `TENSOL_YOOKASSA_LIVE` via the T019 isYookassaLive() helper at
  // request time so flag flips take effect without a restart.
  app.route("/v1/config/feature-flags", createConfigFeatureFlagsRouter());

  // Post-loop step 2 — `/__test/v2/*` fixture seeders (T149 unblock).
  // ONLY mounted when NODE_ENV != "production". The factory does NOT
  // re-read the env — the boot path owns the gate. Each handler does
  // raw DB writes with NO audit emit (per spec: test endpoints must
  // not pollute the production audit chain).
  if (!isProd) {
    app.route(
      "/__test/v2",
      createTestV2Router({ db, ...maybeNow(now) }),
    );
    // eslint-disable-next-line no-console
    console.log(
      "[tensol] /__test/v2/* endpoints enabled (NODE_ENV != production)",
    );
  }

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

  // Post-loop Step 1 — production-wire the real Telegram notifier (T096)
  // when `TENSOL_TELEGRAM_BOT_TOKEN` is set; otherwise fall back to the
  // T066 logging placeholder so dev boots without Telegram creds still work
  // (the placeholder logs the would-be envelope + returns `{ messageId: null }`).
  const telegramBotToken = process.env.TENSOL_TELEGRAM_BOT_TOKEN ?? "";
  const telegramNotifier = telegramBotToken
    ? createTelegramNotifier({ botToken: telegramBotToken })
    : createLoggingTelegramNotifier();
  if (!telegramBotToken) {
    // eslint-disable-next-line no-console
    console.warn(
      "[tensol] TelegramNotifier = LoggingTelegramNotifier (placeholder). " +
        "Set TENSOL_TELEGRAM_BOT_TOKEN to activate the real bot-API client (T096).",
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "[tensol] TelegramNotifier = production bot-API client (T096 wired).",
    );
  }

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

  // T125 — wire the orphan-VM cleanup cron (T123) on a 15-minute cadence.
  // Skipped when no folder ids are configured (dev environments) so the
  // boot path stays env-light. The task is wired against the Yandex
  // provider whose `listInstances` we just shipped (T123 extension).
  const cleanupTestFolder = process.env.YANDEX_TEST_FOLDER_ID ?? "";
  const cleanupProdFolder = process.env.YANDEX_PROD_FOLDER_ID ?? "";
  const cleanupFolderIds = [cleanupTestFolder, cleanupProdFolder].filter(
    (f) => f !== "",
  );
  let cleanupTimer: Timer | null = null;
  if (cleanupFolderIds.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[tensol] T125: orphan-VM cleanup skipped — no YANDEX_TEST_FOLDER_ID " +
        "or YANDEX_PROD_FOLDER_ID configured",
    );
  } else if (!yandexProvider.listInstances) {
    // Defensive: should never trigger with the T123 yandex.ts shipped here.
    // eslint-disable-next-line no-console
    console.warn(
      "[tensol] T125: orphan-VM cleanup skipped — provider lacks listInstances",
    );
  } else {
    const listInstancesBound = yandexProvider.listInstances.bind(
      yandexProvider,
    );
    const cleanupTask = createCleanupOrphanVmsTask({
      provider: {
        listInstances: listInstancesBound,
        teardownVm: yandexProvider.teardownVm.bind(yandexProvider),
      },
      folderIds: cleanupFolderIds,
      namePrefixes: ["tensol-test-", "tensol-scan-"],
      minAgeMs: {
        "tensol-test-": CLEANUP_ORPHAN_TEST_MIN_AGE_MS,
        "tensol-scan-": CLEANUP_ORPHAN_PROD_MIN_AGE_MS,
      },
      sendAlert: async (text: string) => {
        await sendTelegramMessage(text);
      },
    });
    cleanupTimer = setInterval(() => {
      cleanupTask.tick().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(
          "[tensol] T125: cleanup-orphan-vms tick failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }, CLEANUP_ORPHAN_VMS_INTERVAL_MS);
    if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
  }

  // T127 — wire the cleanup-expired-reports cron (T114) on a daily cadence.
  // Skipped when S3 / bucket env vars are missing (dev environments) so the
  // boot path stays env-light. The sweeper is internally idempotent (each
  // tick re-queries `expires_at < now`); overlapping ticks would be safe but
  // we still serialize via setInterval + unref to avoid pinning the loop on
  // graceful shutdown. The handler accepts a narrow `deleteObject` adapter,
  // so we wrap the AWS-SDK S3Client.send() call here rather than expose the
  // full client surface inside the handler.
  let cleanupExpiredReportsTimer: Timer | null = null;
  if (!evidenceBucket || !awsAccessKeyId || !awsSecretAccessKey) {
    // eslint-disable-next-line no-console
    console.warn(
      "[tensol] T127: cleanup-expired-reports skipped — S3/Object-Storage env " +
        "vars missing (TENSOL_EVIDENCE_BUCKET, AWS_ACCESS_KEY_ID, " +
        "AWS_SECRET_ACCESS_KEY).",
    );
  } else {
    const cleanupExpiredReportsHandler = createCleanupExpiredReportsHandler({
      db,
      s3: {
        deleteObject: async (cmd) => {
          await s3.send(
            new DeleteObjectCommand({ Bucket: cmd.Bucket, Key: cmd.Key }),
          );
        },
      },
      bucket: evidenceBucket,
      auditKey: config.TENSOL_AUDIT_SIGNING_KEY,
    });
    cleanupExpiredReportsTimer = setInterval(() => {
      cleanupExpiredReportsHandler
        .tick()
        .then((result) => {
          // eslint-disable-next-line no-console
          console.log("[tensol] T127: cleanup-expired-reports tick:", result);
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(
            "[tensol] T127: cleanup-expired-reports tick failed:",
            err instanceof Error ? err.message : err,
          );
        });
    }, CLEANUP_EXPIRED_REPORTS_INTERVAL_MS);
    if (typeof cleanupExpiredReportsTimer.unref === "function") {
      cleanupExpiredReportsTimer.unref();
    }
  }

  const app = createApp({
    db,
    signingKey: config.TENSOL_AUDIT_SIGNING_KEY,
    sessionCookieSecret: config.TENSOL_SESSION_COOKIE_SECRET,
    baseUrl: config.TENSOL_WEBHOOK_BASE_URL,
    emailMode: config.EMAIL_PROVIDER,
    isProd: config.NODE_ENV === "production",
    webhookSecret: config.TENSOL_WEBHOOK_SECRET,
    telegramWebhookSecret: config.TENSOL_TELEGRAM_WEBHOOK_SECRET,
    operatorEmails: parseOperatorEmails(config.TENSOL_OPERATOR_EMAILS),
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
      if (cleanupTimer !== null) clearInterval(cleanupTimer);
      if (cleanupExpiredReportsTimer !== null) {
        clearInterval(cleanupExpiredReportsTimer);
      }
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
