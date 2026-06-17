/**
 * T135 — vps-agent scan orchestrator.
 *
 * `runScan` is the V2 (002-blackbox-mvp) orchestration entry point that runs
 * ON the ephemeral GCP VM spawned per scan. Lifecycle:
 *
 *   1. spawn Decepticon (`deps.decepticon.run`)
 *   2. collect findings/*.md from the findings dir
 *      (`deps.findingCollector.collect`)
 *   3. tar.gz the evidence dir (`deps.bundler.createTarGz`)
 *   4. upload the bundle to Google Cloud Storage
 *      (`deps.evidenceUploader.uploadEvidence`)
 *   5. POST a signed `WebhookScanCompleteBody` to the backend
 *      (`deps.fetcher` + `signWebhook`) — retried on 5xx / network errors,
 *      hard-fail on 4xx. Local runner failures before evidence upload send
 *      a signed terminal `status="failed"` callback instead.
 *   6. signal shutdown to the wrapper (`deps.shutdown`)
 *
 * The function NEVER throws — every failure mode is captured into the
 * discriminated-union return type. The caller (the wrapper script invoked
 * by cloud-init) exits zero for delivered terminal callbacks, including
 * delivered `status="failed"` callbacks, and non-zero only when the backend
 * was not notified.
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
 *   - Tests stay hermetic — no real docker socket, GCS endpoint, network, or
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
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type ScanProfile,
	runDecepticonScan as defaultRunDecepticonScan,
} from "./decepticon-runner.ts";
import { createEvidenceUploader } from "./evidence-upload.ts";
import {
	type CollectedFinding,
	type CollectionResult,
	collectFindings as defaultCollectFindings,
} from "./findings-collector.ts";
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
	| {
			ok: true;
			status: "completed";
			findings: number;
			uploadKey: string;
	  }
	| { ok: true; status: "failed"; error: string }
	| { ok: false; error: string };

export interface CreateDefaultRunnerDepsArgs {
	readonly scanId: string;
	readonly scanOrderId: string;
	/** V2 webhook signing secret (`TENSOL_WEBHOOK_SECRET`). */
	readonly signKey: string;
	readonly webhookUrl: string;
	readonly evidenceBucket: string;
	readonly targetUrl: string;
	readonly profile: ScanProfile;
	readonly findingsDir?: string;
	readonly evidenceDir?: string;
	readonly reconDir?: string;
	readonly composeFile?: string;
	readonly langgraphUrl?: string;
	readonly evidencePrefix?: string;
	readonly bundleOutPath?: string;
}

export interface CreateDefaultRunnerDepsOverrides {
	readonly runDecepticonScan?: typeof defaultRunDecepticonScan;
	readonly collectFindings?: (opts: {
		dir?: string;
		dirs?: string[];
	}) => Promise<CollectionResult>;
	readonly bundler?: Bundler;
	readonly evidenceUploader?: EvidenceUploader;
	readonly fetcher?: typeof fetch;
	readonly now?: () => number;
	readonly shutdown?: () => Promise<void>;
	readonly sleep?: (ms: number) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BUNDLE_OUT_PATH = "/tmp/evidence.tar.gz";
const DEFAULT_MAX_WEBHOOK_ATTEMPTS = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const MAX_FAILURE_REASON_LENGTH = 255;
const DEFAULT_FINDINGS_DIR = "/opt/tensol/workspace/findings";
const DEFAULT_EVIDENCE_DIR = "/opt/tensol/workspace";
const DEFAULT_RECON_DIR = "/opt/decepticon/workspace";
const DEFAULT_COMPOSE_FILE = "/opt/tensol/docker-compose.yml";

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

	// 1. Decepticon. Local failures post a terminal failed callback so the
	//    backend can mark the scan failed without waiting for the watchdog.
	let decepticonResult: DecepticonResult;
	try {
		decepticonResult = await deps.decepticon.run();
	} catch (err) {
		return postFailureWebhook({
			scanOrderId: deps.scanOrderId,
			reason: `decepticon_failed: ${describeError(err)}`,
			completedAt: now(),
			durationSeconds: 0,
			webhookUrl: deps.webhookUrl,
			signKey: deps.signKey,
			fetcher,
			now,
			sleep,
			maxAttempts,
			initialBackoffMs,
			shutdown: deps.shutdown,
		});
	}

	// 2. Collect findings from the markdown drop.
	let findings: readonly FindingFromAgent[];
	try {
		findings = await deps.findingCollector.collect(
			decepticonResult.findingsDir,
		);
	} catch (err) {
		return postFailureWebhook({
			scanOrderId: deps.scanOrderId,
			reason: `collect_failed: ${describeError(err)}`,
			completedAt: now(),
			durationSeconds: decepticonResult.durationSeconds,
			webhookUrl: deps.webhookUrl,
			signKey: deps.signKey,
			fetcher,
			now,
			sleep,
			maxAttempts,
			initialBackoffMs,
			shutdown: deps.shutdown,
		});
	}

	// 3. tar.gz the evidence dir.
	let bundle: BundleResult;
	try {
		bundle = await deps.bundler.createTarGz(
			decepticonResult.evidenceDir,
			bundleOutPath,
		);
	} catch (err) {
		return postFailureWebhook({
			scanOrderId: deps.scanOrderId,
			reason: `bundle_failed: ${describeError(err)}`,
			completedAt: now(),
			durationSeconds: decepticonResult.durationSeconds,
			webhookUrl: deps.webhookUrl,
			signKey: deps.signKey,
			fetcher,
			now,
			sleep,
			maxAttempts,
			initialBackoffMs,
			shutdown: deps.shutdown,
		});
	}

	// 4. Upload to Google Cloud Storage.
	let upload: UploadResult;
	try {
		upload = await deps.evidenceUploader.uploadEvidence({
			scanId: deps.scanId,
			filePath: bundle.path,
		});
	} catch (err) {
		return postFailureWebhook({
			scanOrderId: deps.scanOrderId,
			reason: `upload_failed: ${describeError(err)}`,
			completedAt: now(),
			durationSeconds: decepticonResult.durationSeconds,
			webhookUrl: deps.webhookUrl,
			signKey: deps.signKey,
			fetcher,
			now,
			sleep,
			maxAttempts,
			initialBackoffMs,
			shutdown: deps.shutdown,
		});
	}

	// 5. Build + sign + POST the completed webhook. Post-webhook failures STILL
	//    call shutdown() so the VM doesn't leak; the backend watchdog handles
	//    the order only when the callback never arrives.
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
	return {
		ok: true,
		status: "completed",
		findings: findings.length,
		uploadKey: upload.key,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface BuildWebhookBodyArgs {
	readonly scanOrderId: string;
	readonly status?: "completed" | "failed";
	readonly failureReason?: string | null;
	readonly completedAt: number;
	readonly durationSeconds: number;
	readonly decepticonEventsCount: number | undefined;
	readonly evidenceBucket: string;
	readonly evidenceKey?: string | undefined;
	readonly findings: readonly FindingFromAgent[];
}

function buildWebhookBody(args: BuildWebhookBodyArgs): Record<string, unknown> {
	const out: Record<string, unknown> = {
		scan_order_id: args.scanOrderId,
		status: args.status ?? "completed",
		failure_reason: args.failureReason ?? null,
		completed_at: args.completedAt,
		duration_seconds: args.durationSeconds,
		findings: args.findings.map((f) => ({
			raw_yaml_frontmatter: f.raw_yaml_frontmatter,
			body_md: f.body_md,
			evidence_keys: f.evidence_keys,
		})),
	};
	if (args.evidenceKey !== undefined) {
		out.evidence_archive_url = `gs://${args.evidenceBucket}/${args.evidenceKey}`;
	}
	if (args.decepticonEventsCount !== undefined) {
		out.decepticon_events_count = args.decepticonEventsCount;
	}
	return out;
}

async function postFailureWebhook(args: {
	readonly scanOrderId: string;
	readonly reason: string;
	readonly completedAt: number;
	readonly durationSeconds: number;
	readonly webhookUrl: string;
	readonly signKey: string;
	readonly fetcher: typeof fetch;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly maxAttempts: number;
	readonly initialBackoffMs: number;
	readonly shutdown: (() => Promise<void>) | undefined;
}): Promise<RunScanResult> {
	const reason = truncateFailureReason(args.reason);
	const body = buildWebhookBody({
		scanOrderId: args.scanOrderId,
		status: "failed",
		failureReason: reason,
		completedAt: args.completedAt,
		durationSeconds: args.durationSeconds,
		decepticonEventsCount: undefined,
		evidenceBucket: "",
		findings: [],
	});
	const webhookOutcome = await postSignedWebhook({
		url: args.webhookUrl,
		body: JSON.stringify(body),
		signKey: args.signKey,
		fetcher: args.fetcher,
		now: args.now,
		sleep: args.sleep,
		maxAttempts: args.maxAttempts,
		initialBackoffMs: args.initialBackoffMs,
	});

	await safeShutdown(args.shutdown);

	if (!webhookOutcome.ok) {
		return {
			ok: false,
			error: `${reason}; failure_webhook_${webhookOutcome.error}`,
		};
	}
	return { ok: true, status: "failed", error: reason };
}

/**
 * Production adapter factory for the V2 runner.
 *
 * `runScan` above stays pure and DI-only; this factory is the narrow bridge
 * from VM runtime env + existing modules to those interfaces.
 */
export function createDefaultRunnerDeps(
	args: CreateDefaultRunnerDepsArgs,
	overrides: CreateDefaultRunnerDepsOverrides = {},
): RunnerDeps {
	const now = overrides.now ?? (() => Date.now());
	const findingsDir = args.findingsDir ?? DEFAULT_FINDINGS_DIR;
	const evidenceDir = args.evidenceDir ?? DEFAULT_EVIDENCE_DIR;
	const reconDir = args.reconDir ?? DEFAULT_RECON_DIR;
	const composeFile = args.composeFile ?? DEFAULT_COMPOSE_FILE;
	const runDecepticon = overrides.runDecepticonScan ?? defaultRunDecepticonScan;
	const collect = overrides.collectFindings ?? defaultCollectFindings;

	return {
		scanId: args.scanId,
		scanOrderId: args.scanOrderId,
		signKey: args.signKey,
		webhookUrl: args.webhookUrl,
		evidenceBucket: args.evidenceBucket,
		decepticon: {
			run: async () => {
				const startedAt = now();
				const result = await runDecepticon({
					scanId: args.scanId,
					targetUrl: args.targetUrl,
					profile: args.profile,
					findingsDir,
					composeFile,
					reconDir,
					...(args.langgraphUrl ? { langgraphUrl: args.langgraphUrl } : {}),
				});
				if (result.status !== "done") {
					throw new Error(result.failure_reason ?? "decepticon_failed");
				}
				return {
					findingsDir,
					evidenceDir,
					durationSeconds: Math.max(1, Math.ceil((now() - startedAt) / 1000)),
				};
			},
		},
		findingCollector: {
			collect: async () => {
				const result = await collect({
					dirs: [findingsDir, `${reconDir}/tensol-${args.scanId}`],
				});
				return result.findings.map(mapCollectedFindingToV2);
			},
		},
		bundler: overrides.bundler ?? createTarGzBundler(),
		evidenceUploader:
			overrides.evidenceUploader ??
			createEvidenceUploader({
				bucket: args.evidenceBucket,
				...(args.evidencePrefix ? { keyPrefix: args.evidencePrefix } : {}),
			}),
		...(overrides.fetcher ? { fetcher: overrides.fetcher } : {}),
		...(overrides.now ? { now: overrides.now } : {}),
		...(overrides.shutdown ? { shutdown: overrides.shutdown } : {}),
		...(overrides.sleep ? { sleep: overrides.sleep } : {}),
		...(args.bundleOutPath ? { bundleOutPath: args.bundleOutPath } : {}),
	};
}

function createTarGzBundler(): Bundler {
	return {
		async createTarGz(srcDir: string, outPath: string): Promise<BundleResult> {
			await mkdir(dirname(outPath), { recursive: true });
			const proc = Bun.spawn(["tar", "-czf", outPath, "-C", srcDir, "."], {
				stdout: "ignore",
				stderr: "pipe",
			});
			const stderr =
				proc.stderr === null ? "" : await new Response(proc.stderr).text();
			const code = await proc.exited;
			if (code !== 0) {
				throw new Error(
					`tar exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
				);
			}
			const info = await stat(outPath);
			return { path: outPath, size: info.size };
		},
	};
}

function mapCollectedFindingToV2(
	finding: CollectedFinding,
	index: number,
): FindingFromAgent {
	const id = createHash("sha256")
		.update(`${index}\n${finding.title}\n${finding.body_md}`)
		.digest("hex")
		.slice(0, 16);
	return {
		raw_yaml_frontmatter: {
			id: `v1-${id}`,
			severity:
				finding.severity === "info" ? "informational" : finding.severity,
			title: finding.title,
		},
		body_md: appendInlineEvidence(finding),
		evidence_keys: [],
	};
}

function appendInlineEvidence(finding: CollectedFinding): string {
	const request = finding.evidence?.request;
	const response = finding.evidence?.response;
	if (request === undefined && response === undefined) {
		return finding.body_md;
	}

	const parts = [finding.body_md, "", "## Inline evidence"];
	if (request !== undefined) {
		parts.push("", "### Request", "```http", request, "```");
	}
	if (response !== undefined) {
		parts.push("", "### Response", "```http", response, "```");
	}
	return parts.join("\n");
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

function truncateFailureReason(reason: string): string {
	if (reason.length <= MAX_FAILURE_REASON_LENGTH) return reason;
	return `${reason.slice(0, MAX_FAILURE_REASON_LENGTH - 3)}...`;
}
