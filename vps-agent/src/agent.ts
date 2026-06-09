/**
 * vps-agent Hono server (T073).
 *
 * Single-binary entry point that runs on an ephemeral scanner VM spawned
 * per-scan by the Sthrip backend. The lifecycle is:
 *
 *   1. cloud-init starts this server with TENSOL_SIGN_KEY + TENSOL_SCAN_ID
 *      bound into the environment.
 *   2. Backend POSTs a signed `/scan` request — agent verifies the HMAC,
 *      validates the body, returns `202 Accepted` immediately, and kicks off
 *      the Decepticon scan in the background.
 *   3. When the scan resolves, the agent POSTs the result to the supplied
 *      `webhook_url`. V2 dispatch uses the terminal scan-complete runner;
 *      legacy dispatch uses `sendCallback`.
 *   4. Agent self-shuts-down via the injected `exitImpl` so the cloud-init
 *      destroy hook can tear the VPS down.
 *
 * Design choices:
 * - All side-effecting deps (`runScan`, `sendCallback`, `exitImpl`, `now`)
 *   are injected through `createAgent({...})`. Production wiring (real
 *   `runDecepticonScan`, `sendCallback`, `process.exit`) lives at the bottom
 *   of this file in the `if (import.meta.main)` block.
 * - Signature is verified BEFORE the JSON body is parsed: we read the raw
 *   request text first, HMAC-verify it, then parse. This matches the
 *   webhook contract (signature is over raw bytes) and ensures Zod errors
 *   never leak details to an unauthenticated caller.
 * - State is a simple discriminated union held in a `let`. The agent is
 *   single-scan per VPS, so we don't need a Map or queue.
 * - Callback failure still triggers self-shutdown (`exitImpl(1)`) so the
 *   VM doesn't leak; backend watchdogs cover the "callback never arrived"
 *   gap. V2 local runner failures exit zero when the failed terminal
 *   callback was delivered.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
	type CallbackResult,
	sendCallback as defaultSendCallback,
} from "./callback.ts";
import {
	type RunScanResult as LegacyRunScanResult,
	runDecepticonScan as defaultRunScan,
} from "./decepticon-runner.ts";
import {
	type RunScanResult as CompleteRunScanResult,
	type RunnerDeps,
	createDefaultRunnerDeps,
	runScan as defaultRunCompleteScan,
} from "./runner.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentState =
	| { phase: "idle" }
	| { phase: "running"; scan_id: string; started_at: number }
	| { phase: "callback_sent"; scan_id: string }
	| { phase: "shutdown_pending"; scan_id: string };

export type CreateAgentDeps = {
	/** Per-VM dispatch signing key used to verify POST /scan. */
	signKey: string;
	scanId: string;
	runScan: typeof defaultRunScan;
	sendCallback: typeof defaultSendCallback;
	/** Fleet V2 webhook secret used by /v1/webhooks/scan-complete callbacks. */
	webhookSecret?: string;
	evidencePrefix?: string;
	runCompleteScan?: (deps: RunnerDeps) => Promise<CompleteRunScanResult>;
	createCompleteScanDeps?: (args: CreateCompleteScanDepsArgs) => RunnerDeps;
	exitImpl?: (code: number) => void;
	now?: () => number;
	/**
	 * Override for compose file path (defaults to `/opt/tensol/docker-compose.yml`,
	 * which is where cloud-init drops the file in production). Tests don't care
	 * because they mock `runScan` entirely.
	 */
	composeFile?: string;
	/**
	 * Override for findings dir on the VPS host (defaults to
	 * `/opt/tensol/workspace/findings`).
	 */
	findingsDir?: string;
	/**
	 * Override for the Decepticon workspace root on the VPS host (defaults
	 * to `/opt/decepticon/workspace`). Bug #1 fix: the findings collector
	 * walks `<reconDir>/tensol-<scanId>/` recursively so Decepticon's
	 * narrative recon output (SUMMARY.md, report_<target>.md without
	 * frontmatter) rides the webhook to the server as `info` findings
	 * instead of being lost when the compose volume is torn down.
	 */
	reconDir?: string;
};

export type CreateCompleteScanDepsArgs = {
	readonly scanId: string;
	readonly scanOrderId: string;
	readonly webhookSecret: string;
	readonly webhookUrl: string;
	readonly evidenceBucket: string;
	readonly targetUrl: string;
	readonly profile: "recon" | "standard" | "max";
	readonly composeFile: string;
	readonly findingsDir: string;
	readonly reconDir: string;
	readonly evidencePrefix?: string;
	readonly langgraphUrl?: string;
};

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const ScanProfileSchema = z.enum(["recon", "standard", "max"]);

const ScanRequestSchema = z
	.object({
		scan_id: z.string().min(1),
		target_url: z.string().url(),
		profile: ScanProfileSchema,
		webhook_url: z.string().url(),
		callback_version: z.enum(["v1", "v2"]).optional().default("v1"),
		scan_order_id: z.string().min(1).optional(),
		evidence_bucket: z.string().min(1).optional(),
	})
	.superRefine((value, ctx) => {
		if (value.callback_version !== "v2") return;
		if (!value.scan_order_id) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["scan_order_id"],
				message: "scan_order_id is required for callback_version=v2",
			});
		}
		if (!value.evidence_bucket) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["evidence_bucket"],
				message: "evidence_bucket is required for callback_version=v2",
			});
		}
	});

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

/**
 * Constant-time verify that `signatureHex` matches HMAC-SHA256(rawBody, key).
 *
 * Returns `false` for any malformed input (missing header, wrong length, bad
 * hex) instead of throwing — callers should map `false` → 401.
 */
function verifySignature(
	rawBody: string,
	signatureHex: string | null | undefined,
	key: string,
): boolean {
	if (!signatureHex) return false;
	const expected = createHmac("sha256", key).update(rawBody).digest("hex");

	// Both strings must be the same byte length for timingSafeEqual; if the
	// attacker supplies a wrong-length signature we can short-circuit safely
	// because length itself isn't a secret.
	if (signatureHex.length !== expected.length) return false;

	try {
		return timingSafeEqual(
			Buffer.from(signatureHex, "hex"),
			Buffer.from(expected, "hex"),
		);
	} catch {
		// Buffer.from with bad hex returns a truncated buffer; the length check
		// above usually catches that, but timingSafeEqual will throw on mismatch
		// so we defensively wrap.
		return false;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgent(deps: CreateAgentDeps): {
	app: Hono;
	getState: () => AgentState;
} {
	const {
		signKey,
		scanId: expectedScanId,
		runScan,
		sendCallback,
		webhookSecret = "",
		evidencePrefix,
		runCompleteScan = defaultRunCompleteScan,
		createCompleteScanDeps = (args) =>
			createDefaultRunnerDeps({
				scanId: args.scanId,
				scanOrderId: args.scanOrderId,
				signKey: args.webhookSecret,
				webhookUrl: args.webhookUrl,
				evidenceBucket: args.evidenceBucket,
				targetUrl: args.targetUrl,
				profile: args.profile,
				composeFile: args.composeFile,
				findingsDir: args.findingsDir,
				reconDir: args.reconDir,
				...(args.evidencePrefix ? { evidencePrefix: args.evidencePrefix } : {}),
				...(args.langgraphUrl ? { langgraphUrl: args.langgraphUrl } : {}),
			}),
		exitImpl = (code: number) => process.exit(code),
		now = () => Date.now(),
		composeFile = "/opt/tensol/docker-compose.yml",
		findingsDir = "/opt/tensol/workspace/findings",
		reconDir = "/opt/decepticon/workspace",
	} = deps;

	// Singleton state. Mutated only by handlers + the async scan worker.
	let state: AgentState = { phase: "idle" };
	const getState = (): AgentState => state;

	const app = new Hono();

	// -------------------------------------------------------------------------
	// GET /healthz (kept from T003)
	// -------------------------------------------------------------------------
	app.get("/healthz", (c) => c.json({ ok: true }));

	// -------------------------------------------------------------------------
	// GET /status — liveness for backend watchdog (T060)
	// -------------------------------------------------------------------------
	app.get("/status", (c) => c.json(state));

	// -------------------------------------------------------------------------
	// POST /scan — signed dispatch from backend
	// -------------------------------------------------------------------------
	app.post("/scan", async (c) => {
		// 1. Verify HMAC over raw body BEFORE parsing JSON. Untrusted callers
		//    must not be able to influence parser behaviour.
		const rawBody = await c.req.text();
		const sigHeader = c.req.header("X-Tensol-Signature") ?? null;
		if (!verifySignature(rawBody, sigHeader, signKey)) {
			return c.json({ error: "invalid_signature" }, 401);
		}

		// 2. Parse + Zod-validate.
		let parsed: z.infer<typeof ScanRequestSchema>;
		try {
			const json = JSON.parse(rawBody);
			parsed = ScanRequestSchema.parse(json);
		} catch (err) {
			const message =
				err instanceof z.ZodError ? "validation_error" : "invalid_json";
			return c.json({ error: message }, 400);
		}

		// 3. Cross-check scan_id against the env-bound expected id. Prevents a
		//    backend bug (or replay) from running a different scan on this VPS.
		if (parsed.scan_id !== expectedScanId) {
			return c.json({ error: "scan_id_mismatch" }, 400);
		}

		// 4. Idempotency: if a scan is already in flight, reject the second POST.
		if (state.phase !== "idle") {
			return c.json({ error: "scan_already_running", phase: state.phase }, 409);
		}
		if (parsed.callback_version === "v2" && webhookSecret.trim().length === 0) {
			return c.json({ error: "webhook_secret_missing" }, 500);
		}

		// 5. Transition to running and kick off async worker.
		const startedAt = now();
		state = {
			phase: "running",
			scan_id: parsed.scan_id,
			started_at: startedAt,
		};

		// Fire-and-forget: scan worker handles its own state transitions + exit.
		void runScanAsync({
			args: parsed,
			runScan,
			sendCallback,
			runCompleteScan,
			createCompleteScanDeps,
			signKey,
			webhookSecret: webhookSecret.trim(),
			evidencePrefix,
			composeFile,
			findingsDir,
			reconDir,
			exitImpl,
			setState: (next) => {
				state = next;
			},
		});

		return c.json({ accepted: true, scan_id: parsed.scan_id }, 202);
	});

	return { app, getState };
}

// ---------------------------------------------------------------------------
// Async scan worker
// ---------------------------------------------------------------------------

type RunScanAsyncArgs = {
	args: z.infer<typeof ScanRequestSchema>;
	runScan: typeof defaultRunScan;
	sendCallback: typeof defaultSendCallback;
	runCompleteScan: (deps: RunnerDeps) => Promise<CompleteRunScanResult>;
	createCompleteScanDeps: (args: CreateCompleteScanDepsArgs) => RunnerDeps;
	signKey: string;
	webhookSecret: string;
	evidencePrefix: string | undefined;
	composeFile: string;
	findingsDir: string;
	reconDir: string;
	exitImpl: (code: number) => void;
	setState: (next: AgentState) => void;
};

function requireV2Field(value: string | undefined, name: string): string {
	if (value === undefined || value === "") {
		throw new Error(`validated v2 scan missing ${name}`);
	}
	return value;
}

/**
 * Orchestrates the scan → callback → shutdown flow. Lives outside
 * `createAgent` for testability (although in practice all branches are
 * covered through the public `app.fetch` surface).
 */
async function runScanAsync(opts: RunScanAsyncArgs): Promise<void> {
	const {
		args,
		runScan,
		sendCallback,
		runCompleteScan,
		createCompleteScanDeps,
		webhookSecret,
		evidencePrefix,
		signKey,
		composeFile,
		findingsDir,
		reconDir,
		exitImpl,
		setState,
	} = opts;

	console.error(
		`[agent] runScanAsync start scan_id=${args.scan_id} target=${args.target_url} profile=${args.profile} webhook=${args.webhook_url}`,
	);

	if (args.callback_version === "v2") {
		let result: CompleteRunScanResult;
		try {
			const scanOrderId = requireV2Field(args.scan_order_id, "scan_order_id");
			const evidenceBucket = requireV2Field(
				args.evidence_bucket,
				"evidence_bucket",
			);
			result = await runCompleteScan(
				createCompleteScanDeps({
					scanId: args.scan_id,
					scanOrderId,
					webhookSecret,
					webhookUrl: args.webhook_url,
					evidenceBucket,
					targetUrl: args.target_url,
					profile: args.profile,
					composeFile,
					findingsDir,
					reconDir,
					...(evidencePrefix ? { evidencePrefix } : {}),
					...(process.env.DECEPTICON_LANGGRAPH_URL
						? { langgraphUrl: process.env.DECEPTICON_LANGGRAPH_URL }
						: {}),
				}),
			);
		} catch (err) {
			console.error(
				`[agent] runCompleteScan THREW (defensive synthesis): ${err instanceof Error ? err.message : String(err)}`,
			);
			result = {
				ok: false,
				error:
					err instanceof Error ? `runner_threw_${err.message}` : "runner_threw",
			};
		}

		console.error(
			`[agent] runCompleteScan returned: ok=${result.ok}${
				result.ok
					? result.status === "completed"
						? ` status=completed findings=${result.findings} upload_key=${result.uploadKey}`
						: ` status=failed error=${result.error}`
					: ` error=${result.error}`
			}`,
		);
		setState({ phase: "callback_sent", scan_id: args.scan_id });
		setState({ phase: "shutdown_pending", scan_id: args.scan_id });
		const exitCode = result.ok ? 0 : 1;
		console.error(`[agent] exitImpl invoked with code ${exitCode}`);
		exitImpl(exitCode);
		return;
	}

	let result: LegacyRunScanResult;
	try {
		result = await runScan({
			scanId: args.scan_id,
			targetUrl: args.target_url,
			profile: args.profile,
			findingsDir,
			reconDir,
			composeFile,
			// langgraph runs on host inside the compose `decepticon-net` network.
			// vps-agent runs on docker's default `bridge` network. To bridge them,
			// cloud-init starts the agent with `--add-host=host.docker.internal:
			// host-gateway` AND injects `DECEPTICON_LANGGRAPH_URL` env. Compose
			// binds :2024 on 0.0.0.0 (not 127.0.0.1) so this gateway-routed call
			// resolves. Falls back to the runner's `http://127.0.0.1:2024` default
			// when env unset (matches local dev where agent runs on host network).
			...(process.env.DECEPTICON_LANGGRAPH_URL
				? { langgraphUrl: process.env.DECEPTICON_LANGGRAPH_URL }
				: {}),
		});
	} catch (err) {
		console.error(
			`[agent] runScan THREW (defensive synthesis): ${err instanceof Error ? err.message : String(err)}`,
		);
		// runScan promised never to throw, but defensive-by-default: synthesize
		// a failed envelope so the callback can still fire.
		result = {
			status: "failed",
			failure_reason:
				err instanceof Error ? `runner_threw_${err.message}` : "runner_threw",
			findings: [],
			usage: null,
		};
	}

	console.error(
		`[agent] runScan returned: status=${result.status} failure_reason=${result.failure_reason ?? "<null>"} findings=${result.findings.length}`,
	);

	let callbackOutcome: CallbackResult;
	try {
		callbackOutcome = await sendCallback({
			webhookUrl: args.webhook_url,
			signKey,
			payload: {
				scan_id: args.scan_id,
				status: result.status,
				failure_reason: result.failure_reason,
				usage: result.usage,
				findings: result.findings,
			},
		});
	} catch (err) {
		console.error(
			`[agent] sendCallback THREW (defensive synthesis): ${err instanceof Error ? err.message : String(err)}`,
		);
		// sendCallback also promises never to throw, but treat any escape as
		// a hard callback failure.
		callbackOutcome = {
			ok: false,
			attempts: 0,
			lastError: err instanceof Error ? err.message : "callback_threw_unknown",
		};
	}

	const cbStatus = callbackOutcome.ok
		? `HTTP ${callbackOutcome.status}`
		: `lastStatus=${callbackOutcome.lastStatus ?? "<none>"} lastError=${callbackOutcome.lastError ?? "<none>"}`;
	console.error(
		`[agent] sendCallback delivered=${callbackOutcome.ok} attempts=${callbackOutcome.attempts} ${cbStatus}`,
	);

	setState({ phase: "callback_sent", scan_id: args.scan_id });
	setState({ phase: "shutdown_pending", scan_id: args.scan_id });

	const exitCode = callbackOutcome.ok ? 0 : 1;
	console.error(`[agent] exitImpl invoked with code ${exitCode}`);
	// Legacy exit code: 0 on clean delivery, 1 on callback failure (so logs /
	// teardown automation can disambiguate). Either way the VM tears itself
	// down; backend watchdog covers the "callback never arrived" gap.
	exitImpl(exitCode);
}

// ---------------------------------------------------------------------------
// Production entry point (only runs when invoked directly via `bun src/agent.ts`)
// ---------------------------------------------------------------------------

function readRequiredEnv(name: string): string {
	const v = process.env[name];
	if (!v || v.length === 0) {
		throw new Error(`${name} is required but not set in environment`);
	}
	return v;
}

let exported: { port: number; fetch: typeof Hono.prototype.fetch } | null =
	null;

if (import.meta.main) {
	// Surface any silent process death so docker logs show WHY the container
	// restarted (without these handlers an unhandledRejection or uncaughtException
	// would terminate bun with no observable trace, then `restart: unless-stopped`
	// would relaunch a fresh container with phase=idle and the original scan lost).
	process.on("unhandledRejection", (reason) => {
		console.error(
			`[agent] FATAL unhandledRejection: ${reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)}`,
		);
	});
	process.on("uncaughtException", (err) => {
		console.error(
			`[agent] FATAL uncaughtException: ${err.message}\n${err.stack}`,
		);
	});
	process.on("exit", (code) => {
		console.error(`[agent] process.exit code=${code}`);
	});

	const signKey = readRequiredEnv("TENSOL_SIGN_KEY");
	const scanId = readRequiredEnv("TENSOL_SCAN_ID");
	const webhookSecret = process.env.TENSOL_WEBHOOK_SECRET ?? "";
	const evidencePrefix = process.env.TENSOL_EVIDENCE_PREFIX;

	const { app } = createAgent({
		signKey,
		scanId,
		runScan: defaultRunScan,
		sendCallback: defaultSendCallback,
		webhookSecret,
		...(evidencePrefix ? { evidencePrefix } : {}),
	});

	const port = Number(process.env.PORT ?? 8080);
	exported = { port, fetch: app.fetch };
}

export default exported;
