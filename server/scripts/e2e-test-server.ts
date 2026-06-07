/**
 * In-process Tensol backend launcher for Playwright E2E.
 *
 * The browser specs run under Node, while the backend uses Bun's SQLite
 * bindings. Global setup launches this file as a Bun child process and waits
 * for the READY sentinel on stdout.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";

import { createDb } from "../src/db/client.ts";
import { applyMigrationsOnce, createApp } from "../src/server.ts";
import { createRunner, type Dispatcher } from "../src/jobs/runner.ts";
import { createSpawnScanVmHandler } from "../src/jobs/handlers/spawn-scan-vm.ts";
import { createTeardownScanVmHandler } from "../src/jobs/handlers/teardown-scan-vm.ts";
import { createRenderPdfHandler } from "../src/jobs/handlers/render-pdf.ts";
import { refundFreeQuickQuota } from "../src/free-tier/service.ts";
import { FakeCloudProvider } from "../src/vps/fake-provider.ts";
import { createReviewService } from "../src/review/service.ts";
import { FakeLlmClient } from "../src/review/reviewer.ts";
import { createHttpGitHubClient } from "../src/review/github/client.ts";
import { postReviewResult } from "../src/review/poster.ts";
import type { ReviewResult } from "../src/review/types.ts";

const SIGNING_KEY =
  "test-e2e-key-64-chars-hex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_COOKIE_SECRET =
  "test-e2e-session-cookie-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WEBHOOK_SECRET = "e2e-webhook-test-secret";

export interface TestServerHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly dbPath: string;
  stop(): Promise<void>;
}

function adaptNewStyle(
  inner: (jobId: string, rawPayload: unknown) => Promise<void>,
): (payload: unknown, ctx: { jobId: string; attempts: number }) => Promise<void> {
  return (payload, ctx) => inner(ctx.jobId, payload);
}

function reviewIdFromPayload(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    throw new Error("review fixture job: payload is not an object");
  }
  const r = raw as Record<string, unknown>;
  const reviewId =
    (typeof r.reviewId === "string" && r.reviewId) ||
    (typeof r.review_id === "string" && r.review_id) ||
    "";
  if (!reviewId) {
    throw new Error(
      `review fixture job: payload missing reviewId (got ${JSON.stringify(raw)})`,
    );
  }
  return reviewId;
}

/**
 * Boot the test backend. Caller is responsible for `stop()`.
 */
export async function startTestServer(opts?: {
  port?: number;
}): Promise<TestServerHandle> {
  const port = opts?.port ?? 3001;
  process.env.TENSOL_DEV_DNS_BYPASS = "true";

  const tmpRoot = mkdtempSync(join(tmpdir(), "tensol-e2e-"));
  const dataDir = join(tmpRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "tensol.db");

  const db = createDb(dbPath);
  const migrationsDir = join(import.meta.dir, "..", "migrations");
  applyMigrationsOnce(db, migrationsDir);

  const cloudProvider = new FakeCloudProvider();
  const fakeS3 = {
    send: async () => ({}),
  } as unknown as S3Client;
  const fakeReviewLlm = new FakeLlmClient(() =>
    JSON.stringify({
      summary: "E2E fixture review completed without findings.",
      verdicts: [],
    }),
  );
  const reviewService = createReviewService({
    db,
    auditKey: SIGNING_KEY,
  });
  const githubArtifactClient =
    process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY
      ? createHttpGitHubClient({
          appId: process.env.GITHUB_APP_ID,
          privateKeyPem: process.env.GITHUB_APP_PRIVATE_KEY,
          ...(process.env.GITHUB_APP_CLIENT_ID
            ? { clientId: process.env.GITHUB_APP_CLIENT_ID }
            : {}),
          ...(process.env.GITHUB_APP_CLIENT_SECRET
            ? { clientSecret: process.env.GITHUB_APP_CLIENT_SECRET }
            : {}),
        })
      : null;

  const spawnScanVm = adaptNewStyle(
    createSpawnScanVmHandler({
      db,
      provider: cloudProvider,
      auditKey: SIGNING_KEY,
      refundFreeQuickQuota,
      vpsZone: "europe-west1-b",
      backendUrl: `http://127.0.0.1:${port}`,
      webhookSecret: WEBHOOK_SECRET,
      evidenceBucket: "tensol-e2e-evidence",
      evidencePrefix: "scans/",
      awsAccessKeyId: "e2e-access-key",
      awsSecretAccessKey: "e2e-secret-key",
      awsEndpoint: "http://127.0.0.1:9",
      awsRegion: "e2e",
      signKey: SIGNING_KEY,
      decepticonImage: "ghcr.io/ageree/decepticon:e2e",
      openrouterApiKey: "e2e-openrouter-key",
      litellmMasterKey: "e2e-litellm-master-key",
      postgresPassword: "e2e-postgres-password",
      neo4jPassword: "e2e-neo4j-password",
      vpsAgentImage: "ghcr.io/ageree/vps-agent:e2e",
      fetchImpl: async () => new Response("{}", { status: 202 }),
      pollIntervalMs: 1,
      retryBackoffMs: 1,
      agentWaitBudgetMs: 250,
      agentProbeIntervalMs: 1,
      agentProbeTimeoutMs: 50,
    }),
  );
  const teardownScanVm = adaptNewStyle(
    createTeardownScanVmHandler({
      db,
      provider: cloudProvider,
      auditKey: SIGNING_KEY,
      pollIntervalMs: 1,
      retryBackoffMs: 1,
    }),
  );
  const renderPdf = adaptNewStyle(
    createRenderPdfHandler({
      db,
      s3: fakeS3,
      bucket: "tensol-e2e-reports",
      auditKey: SIGNING_KEY,
      renderPdf: async () => Buffer.from("%PDF-1.4\n% tensol e2e\n"),
      retryBackoffMs: 1,
    }),
  );
  const completeQueuedReview = async (payload: unknown): Promise<void> => {
    const reviewId = reviewIdFromPayload(payload);
    const review = await reviewService.getReview(reviewId);
    if (!review) throw new Error(`review fixture job: review not found (${reviewId})`);
    if (review.status === "completed") return;
    await reviewService.markReviewRunning(reviewId);
    const result: ReviewResult = {
      kind: review.kind,
      score0to5: 5,
      summaryMd: "E2E fixture review completed without findings.",
      findings: [],
    };
    const repo = review.repoId ? await reviewService.getRepo(review.repoId) : null;
    if (
      githubArtifactClient &&
      repo &&
      review.kind === "pr" &&
      review.prNumber != null &&
      review.headSha
    ) {
      await postReviewResult({
        result,
        ctx: {
          owner: repo.owner,
          name: repo.name,
          pr: review.prNumber,
          headSha: review.headSha,
          statusCheckEnabled: repo.statusCheckEnabled !== 0,
          mergeBlockOnCritical: repo.mergeBlockOnCritical !== 0,
          ...(repo.installationId !== null ? { installationId: repo.installationId } : {}),
        },
        github: githubArtifactClient,
      });
    }
    await reviewService.finalizeReview(reviewId, result);
  };

  const dispatcher: Dispatcher = {
    spawn_vps: async () => {},
    dispatch_scan: async () => {},
    watchdog_scan: async () => {},
    teardown_vps: async () => {},
    spawn_scan_vm: spawnScanVm,
    teardown_scan_vm: teardownScanVm,
    render_pdf: renderPdf,
    send_scan_complete_telegram: async () => {},
    retry_telegram_notification: async () => {},
    pr_review: completeQueuedReview,
    whitebox_scan: completeQueuedReview,
    resolve_threads: async () => {},
    index_repo: async () => {},
  };
  const runner = createRunner({
    db,
    dispatcher,
    signingKey: SIGNING_KEY,
    pollIntervalMs: 25,
    maxAttempts: 2,
    watchdogIntervalMs: 0,
  });
  runner.start();

  const app = createApp({
    db,
    signingKey: SIGNING_KEY,
    sessionCookieSecret: SESSION_COOKIE_SECRET,
    baseUrl: `http://127.0.0.1:${port}`,
    emailMode: "stdout",
    isProd: false,
    webhookSecret: WEBHOOK_SECRET,
    telegramWebhookSecret: "e2e-telegram-webhook-secret",
    operatorEmails: [],
    reviewLlm: fakeReviewLlm,
    githubAppWebhookSecret:
      process.env.GITHUB_APP_WEBHOOK_SECRET ?? "e2e-github-webhook-secret",
    githubAppSlug: process.env.GITHUB_APP_SLUG ?? "sthrip-e2e",
  });

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

if (import.meta.main) {
  const port = Number(process.env.TENSOL_E2E_PORT ?? "3001");
  const handle = await startTestServer({ port });
  process.stdout.write(`READY ${handle.port}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[tensol-test-server] ${signal} - shutting down\n`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  setInterval(() => undefined, 1_000_000);
}
