/**
 * T135 — vps-agent scan orchestrator.
 *
 * `runScan` is the V2 (002-blackbox-mvp) orchestration entry point that runs
 * ON the ephemeral Yandex VM spawned per scan. Lifecycle:
 *
 *   1. spawn Decepticon (`deps.decepticon.run`)
 *   2. collect findings/*.md from the findings dir
 *      (`deps.findingCollector.collect`)
 *   3. tar.gz the evidence dir (`deps.bundler.createTarGz`)
 *   4. upload the bundle to Yandex Object Storage
 *      (`deps.evidenceUploader.uploadEvidence`)
 *   5. POST a signed `WebhookScanCompleteBody` to the backend
 *      (`deps.fetcher` + `signWebhook`) — retried on 5xx / network errors,
 *      hard-fail on 4xx
 *   6. signal shutdown to the wrapper (`deps.shutdown`)
 *
 * The function NEVER throws — every failure mode is captured into the
 * discriminated-union return type. The caller (the wrapper script invoked
 * by cloud-init) inspects `ok` to decide whether to exit zero or non-zero.
 *
 * Constitution invariants honoured here:
 *   - I: this file does not import from `external/decepticon/*` — Decepticon
 *        is exposed only through the injected `DecepticonAdapter` interface.
 *   - II (NON-NEGOTIABLE): the webhook signature is produced by `signWebhook`
 *        which is the byte-perfect mirror of the receiver's verifier.
 *   - VI: written test-first against `tests/runner.test.ts`.
 *   - VII: file ≤ 800 LOC (this file: ~310 LOC).
 *
 * Why DI-heavy:
 *   - Tests stay hermetic — no real docker socket, S3 endpoint, network, or
 *     filesystem outside the test temp dir is touched.
 *   - Production wiring is a thin adapter layer at the bottom of this file
 *     (`createDefaultRunnerDeps`) that bridges injected interfaces to the
 *     existing `decepticon-runner.ts`, `findings-collector.ts`,
 *     `evidence-upload.ts`, and `webhook-sign.ts` modules.
 *
 * Why a new V2 finding shape:
 *   - The existing `findings-collector.ts` emits the V1 shape
 *     (`{severity, title, body_md, evidence?}`). The V2 webhook contract
 *     (`server/src/schemas/webhook-scan-complete.ts`) requires
 *     `{raw_yaml_frontmatter, body_md, evidence_keys}` — so this runner
 *     declares the V2 type locally and the production adapter
 *     (out of scope for T135) maps V1 → V2.
 */
import { signWebhook } from "./webhook-sign.ts";

// ─────────────────────────────────────────────────────────────────────────────
// V2 finding shape — mirrors `WebhookScanCompleteBodySchema.findings[]`.
// ─────────────────────────────────────────────────────────────────────────────

export type FindingSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "informational";

export interface RawYamlFrontmatter {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly cvss_score?: number;
  readonly cvss_vector?: string;
  readonly cvss_version?: string;
  readonly cwe?: readonly string[];
  readonly mitre?: readonly string[];
  readonly affected_target?: string;
  readonly affected_component?: string;
  readonly confidence?: "verified" | "high" | "medium" | "low";
  readonly phase?: string;
  readonly agent?: string;
  readonly objective_id?: string;
  readonly discovered_at?: string | number;
  readonly remediation_priority?: string | number;
  // Forward-compat: unknown frontmatter keys flow through verbatim per
  // the V2 contract's `passthrough()` policy.
  readonly [extra: string]: unknown;
}

export interface FindingFromAgent {
  readonly raw_yaml_frontmatter: RawYamlFrontmatter;
  readonly body_md: string;
  readonly evidence_keys: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter interfaces — each owns one external system.
// ─────────────────────────────────────────────────────────────────────────────

export interface DecepticonResult {
  /** Directory on the VM where Decepticon wrote `*.md` finding files. */
  readonly findingsDir: string;
  /** Directory on the VM where Decepticon wrote HAR / screenshots / logs. */
  readonly evidenceDir: string;
  /** Wallclock duration of the Decepticon scan in seconds. */
  readonly durationSeconds: number;
  /** Optional observability metric — count of Decepticon log events. */
  readonly decepticonEventsCount?: number;
}

export interface DecepticonAdapter {
  run(): Promise<DecepticonResult>;
}

export interface FindingCollector {
  collect(findingsDir: string): Promise<readonly FindingFromAgent[]>;
}

export interface BundleResult {
  readonly path: string;
  readonly size: number;
}

export interface Bundler {
  createTarGz(srcDir: string, outPath: string): Promise<BundleResult>;
}

export interface UploadResult {
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
  readonly etag?: string | undefined;
}

export interface EvidenceUploader {
  uploadEvidence(args: {
    scanId: string;
    filePath: string;
  }): Promise<UploadResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner deps + return type.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunnerDeps {
  readonly scanId: string;
  readonly scanOrderId: string;
  readonly signKey: string;
  readonly webhookUrl: string;
  readonly evidenceBucket: string;
  readonly decepticon: DecepticonAdapter;
  readonly findingCollector: FindingCollector;
  readonly bundler: Bundler;
  readonly evidenceUploader: EvidenceUploader;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly shutdown?: () => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly bundleOutPath?: string;
  readonly maxWebhookAttempts?: number;
  readonly initialBackoffMs?: number;
}

export type RunScanResult =
  | { ok: true; findings: number; uploadKey: string }
  | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BUNDLE_OUT_PATH = "/tmp/evidence.tar.gz";
const DEFAULT_MAX_WEBHOOK_ATTEMPTS = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drive the full per-scan lifecycle on the VM. Never throws.
 */
export async function runScan(deps: RunnerDeps): Promise<RunScanResult> {
  const now = deps.now ?? (() => Date.now());
  const fetcher = deps.fetcher ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const bundleOutPath = deps.bundleOutPath ?? DEFAULT_BUNDLE_OUT_PATH;
  const maxAttempts = deps.maxWebhookAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS;
  const initialBackoffMs = deps.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;

  // 1. Decepticon — pre-webhook failures do NOT call shutdown(); the
  //    wrapper / cloud-init owns VM teardown for those paths.
  let decepticonResult: DecepticonResult;
  try {
    decepticonResult = await deps.decepticon.run();
  } catch (err) {
    return { ok: false, error: `decepticon_failed: ${describeError(err)}` };
  }

  // 2. Collect findings from the markdown drop.
  let findings: readonly FindingFromAgent[];
  try {
    findings = await deps.findingCollector.collect(decepticonResult.findingsDir);
  } catch (err) {
    return { ok: false, error: `collect_failed: ${describeError(err)}` };
  }

  // 3. tar.gz the evidence dir.
  let bundle: BundleResult;
  try {
    bundle = await deps.bundler.createTarGz(
      decepticonResult.evidenceDir,
      bundleOutPath,
    );
  } catch (err) {
    return { ok: false, error: `bundle_failed: ${describeError(err)}` };
  }

  // 4. Upload to S3 / Yandex Object Storage.
  let upload: UploadResult;
  try {
    upload = await deps.evidenceUploader.uploadEvidence({
      scanId: deps.scanId,
      filePath: bundle.path,
    });
  } catch (err) {
    return { ok: false, error: `upload_failed: ${describeError(err)}` };
  }

  // 5. Build + sign + POST the webhook. Post-webhook failures STILL call
  //    shutdown() so the VM doesn't leak — the backend watchdog will mark
  //    the scan as failed when the callback never arrives.
  const completedAt = now();
  const body = buildWebhookBody({
    scanOrderId: deps.scanOrderId,
    completedAt,
    durationSeconds: decepticonResult.durationSeconds,
    decepticonEventsCount: decepticonResult.decepticonEventsCount,
    evidenceBucket: deps.evidenceBucket,
    evidenceKey: upload.key,
    findings,
  });
  const bodyJson = JSON.stringify(body);

  const webhookOutcome = await postSignedWebhook({
    url: deps.webhookUrl,
    body: bodyJson,
    signKey: deps.signKey,
    fetcher,
    now,
    sleep,
    maxAttempts,
    initialBackoffMs,
  });

  // 6. Shutdown — always called after we attempted the webhook (success or
  //    fail). Errors thrown here are swallowed; teardown is best-effort.
  await safeShutdown(deps.shutdown);

  if (!webhookOutcome.ok) {
    return { ok: false, error: webhookOutcome.error };
  }
  return { ok: true, findings: findings.length, uploadKey: upload.key };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface BuildWebhookBodyArgs {
  readonly scanOrderId: string;
  readonly completedAt: number;
  readonly durationSeconds: number;
  readonly decepticonEventsCount: number | undefined;
  readonly evidenceBucket: string;
  readonly evidenceKey: string;
  readonly findings: readonly FindingFromAgent[];
}

function buildWebhookBody(args: BuildWebhookBodyArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {
    scan_order_id: args.scanOrderId,
    completed_at: args.completedAt,
    duration_seconds: args.durationSeconds,
    evidence_archive_url: `s3://${args.evidenceBucket}/${args.evidenceKey}`,
    findings: args.findings.map((f) => ({
      raw_yaml_frontmatter: f.raw_yaml_frontmatter,
      body_md: f.body_md,
      evidence_keys: f.evidence_keys,
    })),
  };
  if (args.decepticonEventsCount !== undefined) {
    out.decepticon_events_count = args.decepticonEventsCount;
  }
  return out;
}

interface PostSignedWebhookArgs {
  readonly url: string;
  readonly body: string;
  readonly signKey: string;
  readonly fetcher: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
}

type WebhookOutcome = { ok: true } | { ok: false; error: string };

/**
 * POST the signed body with exponential backoff on 5xx / network errors.
 *
 * Retry policy:
 *   - 2xx → success
 *   - 5xx → retry up to `maxAttempts` with exp backoff
 *   - 4xx → hard fail immediately (the payload is bad; retrying won't help)
 *   - thrown fetch (network) → retry like 5xx
 */
async function postSignedWebhook(
  args: PostSignedWebhookArgs,
): Promise<WebhookOutcome> {
  let lastError = "unknown_error";

  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    // Re-sign on every attempt so the timestamp matches the actual send. The
    // backend's ±5min drift window means a long retry chain with a stale
    // timestamp would otherwise be rejected.
    const timestampSeconds = Math.floor(args.now() / 1000);
    const sig = signWebhook({
      secret: args.signKey,
      body: args.body,
      timestamp: timestampSeconds,
    });

    let response: Response;
    try {
      response = await args.fetcher(args.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tensol-Signature": sig.signature,
        },
        body: args.body,
      });
    } catch (err) {
      lastError = `webhook_network_error: ${describeError(err)}`;
      if (attempt < args.maxAttempts) {
        await args.sleep(backoffMs(attempt, args.initialBackoffMs));
        continue;
      }
      return { ok: false, error: lastError };
    }

    if (response.status >= 200 && response.status < 300) {
      return { ok: true };
    }
    if (response.status >= 400 && response.status < 500) {
      // Hard-fail: the body or signature is bad. Retry won't help.
      return {
        ok: false,
        error: `webhook_rejected_${response.status}`,
      };
    }
    // 5xx or weird non-2xx — retry path.
    lastError = `webhook_${response.status}`;
    if (attempt < args.maxAttempts) {
      await args.sleep(backoffMs(attempt, args.initialBackoffMs));
    }
  }
  return { ok: false, error: lastError };
}

function backoffMs(attempt: number, initial: number): number {
  // 1→initial, 2→2*initial, 3→4*initial …  capped at 30s.
  const v = initial * 2 ** (attempt - 1);
  return Math.min(v, 30_000);
}

async function safeShutdown(
  shutdown: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!shutdown) return;
  try {
    await shutdown();
  } catch {
    // Best-effort — the wrapper will force-tear-down regardless.
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown";
}
