import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { NetworkPolicy } from "@vercel/sandbox";
import { z } from "zod";

export const PR_EXECUTION_ARTIFACT_KINDS = [
	"log",
	"screenshot",
	"api_trace",
	"generated_test",
	"video",
	"file",
] as const;

export type PrExecutionStatus =
	| "skipped"
	| "running"
	| "passed"
	| "failed"
	| "error";

export const PR_EXECUTION_SANDBOX_PROVIDERS = [
	"docker",
	"vercel-sandbox",
] as const;

export type PrExecutionSandboxProvider =
	(typeof PR_EXECUTION_SANDBOX_PROVIDERS)[number];

export interface PrExecutionArtifact {
	readonly kind: (typeof PR_EXECUTION_ARTIFACT_KINDS)[number];
	readonly label: string;
	readonly summaryMd: string;
	readonly inlineBody?: string | null;
	readonly mimeType?: string | null;
	readonly byteSize?: number | null;
	readonly createdAt?: number;
}

export interface PrExecutionResult {
	readonly status: PrExecutionStatus;
	readonly summaryMd: string;
	readonly artifacts: readonly PrExecutionArtifact[];
}

export interface PrExecutionInput {
	readonly reviewId: string;
	readonly repoId: string;
	readonly owner: string;
	readonly name: string;
	readonly prNumber: number;
	readonly headSha: string;
	readonly baseSha?: string | null | undefined;
}

export interface RunPrExecutionOptions {
	readonly input: PrExecutionInput;
	readonly sandboxProvider?: PrExecutionSandboxProvider;
	readonly dockerImage?: string;
	readonly githubToken?: string;
	readonly vercelSandbox?: VercelPrExecutionSandboxOptions;
	readonly timeoutMs?: number;
	readonly commandTimeoutMs?: number;
	readonly now?: () => number;
}

export interface VercelSandboxCredentials {
	readonly token: string;
	readonly teamId: string;
	readonly projectId: string;
}

export interface VercelPrExecutionSandboxOptions {
	readonly createSandbox?: (
		params: VercelSandboxCreateParams,
	) => Promise<VercelSandboxHandle>;
	readonly credentials?: VercelSandboxCredentials;
	readonly runtime?: string;
	readonly vcpus?: number;
	readonly setupNetworkPolicy?: NetworkPolicy;
}

interface VercelSandboxCreateParams {
	readonly name?: string;
	readonly runtime?: string;
	readonly timeout?: number;
	readonly resources?: { readonly vcpus: number };
	readonly networkPolicy?: NetworkPolicy;
	readonly env?: Readonly<Record<string, string>>;
	readonly tags?: Readonly<Record<string, string>>;
	readonly persistent?: boolean;
	readonly token?: string;
	readonly teamId?: string;
	readonly projectId?: string;
	readonly signal?: AbortSignal;
}

interface VercelSandboxHandle {
	readonly name: string;
	readonly cwd?: string;
	runCommand(params: VercelRunCommandParams): Promise<VercelCommandResult>;
	updateNetworkPolicy(
		networkPolicy: NetworkPolicy,
		opts?: { readonly signal?: AbortSignal },
	): Promise<NetworkPolicy>;
	stop(opts?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

interface VercelRunCommandParams {
	readonly cmd: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

interface VercelCommandResult {
	readonly exitCode: number;
	output(
		stream?: "stdout" | "stderr" | "both",
		opts?: { readonly signal?: AbortSignal },
	): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_DOCKER_IMAGE = "node:22-bookworm";
const DEFAULT_VERCEL_RUNTIME = "node24";
const DEFAULT_VERCEL_VCPUS = 2;
const DEFAULT_BUN_BOOTSTRAP_PACKAGE = "bun@1.3.14";
const VERCEL_WORKSPACE = "/vercel/sandbox";
const LOG_LIMIT = 24_000;
const FULL_COMMIT_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

const DEFAULT_VERCEL_SETUP_NETWORK_POLICY: NetworkPolicy = {
	allow: [
		"github.com",
		"*.github.com",
		"*.githubusercontent.com",
		"codeload.github.com",
		"objects.githubusercontent.com",
		"registry.npmjs.org",
		"*.npmjs.org",
		"registry.yarnpkg.com",
		"*.yarnpkg.com",
		"registry.pnpm.io",
		"get.pnpm.io",
		"nodejs.org",
		"*.nodejs.org",
		"bun.sh",
		"*.bun.sh",
	],
};

const PrExecutionInputSchema = z.object({
	reviewId: z.string().min(1),
	repoId: z.string().min(1),
	owner: z.string().min(1).max(100),
	name: z.string().min(1).max(100),
	prNumber: z.number().int().positive(),
	headSha: z.string().regex(FULL_COMMIT_SHA_RE),
	baseSha: z.string().regex(FULL_COMMIT_SHA_RE).nullable().optional(),
	files: z.unknown().optional(),
});

export const PrExecutionEnvelopeSchema = z.object({
	type: z.literal("pr_execution"),
	iat: z.number().int().positive(),
	exp: z.number().int().positive(),
	nonce: z.string().min(16).max(128),
	aud: z.literal("sthrip-pr-worker"),
	input: PrExecutionInputSchema,
});

function readTrimmedEnv(
	env: Record<string, string | undefined>,
	name: string,
): string | undefined {
	const value = env[name];
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function readVercelSandboxCredentials(
	env: Record<string, string | undefined> = process.env,
): VercelSandboxCredentials | undefined {
	const token = readTrimmedEnv(env, "VERCEL_TOKEN");
	const teamId = readTrimmedEnv(env, "VERCEL_TEAM_ID");
	const projectId = readTrimmedEnv(env, "VERCEL_PROJECT_ID");
	if (token === undefined && teamId === undefined && projectId === undefined) {
		return undefined;
	}

	const missing: string[] = [];
	if (token === undefined) missing.push("VERCEL_TOKEN");
	if (teamId === undefined) missing.push("VERCEL_TEAM_ID");
	if (projectId === undefined) missing.push("VERCEL_PROJECT_ID");
	if (missing.length > 0) {
		throw new Error(
			[
				"Explicit Vercel Sandbox credentials require VERCEL_TOKEN,",
				"VERCEL_TEAM_ID, and VERCEL_PROJECT_ID together.",
				`Missing: ${missing.join(", ")}.`,
			].join(" "),
		);
	}

	return {
		token: token!,
		teamId: teamId!,
		projectId: projectId!,
	};
}

export function signPrExecutionPayload(body: string, secret: string): string {
	const digest = createHmac("sha256", secret).update(body).digest("hex");
	return `sha256=${digest}`;
}

export function verifyPrExecutionSignature(
	body: string,
	secret: string,
	header: string | null | undefined,
): boolean {
	if (!header?.startsWith("sha256=")) return false;
	const expected = Buffer.from(signPrExecutionPayload(body, secret));
	const received = Buffer.from(header);
	return (
		expected.length === received.length && timingSafeEqual(expected, received)
	);
}

export function parsePrExecutionSandboxProvider(
	value: string | null | undefined,
): PrExecutionSandboxProvider | undefined {
	if (value === undefined || value === null || value.trim() === "") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "docker" || normalized === "vercel-sandbox") {
		return normalized;
	}
	throw new Error(
		`Unsupported STHRIP_PR_EXECUTION_SANDBOX_PROVIDER: ${value}`,
	);
}

export async function runPrExecution(
	opts: RunPrExecutionOptions,
): Promise<PrExecutionResult> {
	if (opts.sandboxProvider === "vercel-sandbox") {
		return runVercelSandboxPrExecution(opts);
	}
	return runDockerPrExecution(opts);
}

async function runDockerPrExecution(
	opts: RunPrExecutionOptions,
): Promise<PrExecutionResult> {
	const started = opts.now?.() ?? Date.now();
	const workspace = await mkdtemp(join(tmpdir(), "sthrip-pr-exec-"));
	const artifacts: PrExecutionArtifact[] = [];
	try {
		const env = await buildExecutionEnv(workspace);
		const commands = await buildCommandPlan(
			opts.input,
			workspace,
			opts.githubToken,
			opts.dockerImage ?? DEFAULT_DOCKER_IMAGE,
		);
		let failed = false;
		for (const command of commands) {
			const result = await runCommand(command, {
				cwd: workspace,
				env: { ...env, ...(command.env ?? {}) },
				timeoutMs: opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
			});
			artifacts.push(commandArtifact(command, result, opts.now?.() ?? Date.now()));
			if (result.exitCode !== 0) failed = true;
			if (
				(opts.now?.() ?? Date.now()) - started >
				(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
			) {
				failed = true;
				artifacts.push(
					timeoutArtifact(
						opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
						opts.now?.() ?? Date.now(),
					),
				);
				break;
			}
		}
		artifacts.push(generatedTestArtifact(opts.now?.() ?? Date.now()));
		return {
			status: failed ? "failed" : "passed",
			summaryMd: [
				"## Runtime evidence",
				"",
				failed
					? "The isolated worker found runtime/test failures."
					: "The isolated worker ran the branch command suite successfully.",
				"",
				`Commands run: ${commands.length}.`,
			].join("\n"),
			artifacts,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			status: "error",
			summaryMd: [
				"## Runtime evidence",
				"",
				"The isolated worker could not execute this branch.",
			].join("\n"),
			artifacts: [
				{
					kind: "log",
					label: "Worker error",
					summaryMd: "Worker setup failed before completing the command suite.",
					inlineBody: truncate(message, LOG_LIMIT),
					mimeType: "text/plain",
					byteSize: Buffer.byteLength(message, "utf8"),
					createdAt: opts.now?.() ?? Date.now(),
				},
			],
		};
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

async function runVercelSandboxPrExecution(
	opts: RunPrExecutionOptions,
): Promise<PrExecutionResult> {
	const started = opts.now?.() ?? Date.now();
	const artifacts: PrExecutionArtifact[] = [];
	let sandbox: VercelSandboxHandle | null = null;
	const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), timeout);
	let credentials: VercelSandboxCredentials | undefined;
	try {
		credentials =
			opts.vercelSandbox?.credentials ?? readVercelSandboxCredentials();
		const env = buildVercelExecutionEnv();
		const createSandbox =
			opts.vercelSandbox?.createSandbox ?? createDefaultVercelSandbox;
		sandbox = await createSandbox({
			name: vercelSandboxName(opts.input, started),
			runtime: opts.vercelSandbox?.runtime ?? DEFAULT_VERCEL_RUNTIME,
			timeout,
			resources: { vcpus: opts.vercelSandbox?.vcpus ?? DEFAULT_VERCEL_VCPUS },
			networkPolicy:
				opts.vercelSandbox?.setupNetworkPolicy ??
				DEFAULT_VERCEL_SETUP_NETWORK_POLICY,
			env,
			persistent: false,
			...(credentials ?? {}),
			tags: {
				app: "sthrip",
				kind: "pr-execution",
				review: safeTagValue(opts.input.reviewId),
				repo: safeTagValue(opts.input.repoId),
			},
			signal: abort.signal,
		});

		const setupResult = await runVercelCommand(
			sandbox,
			{ argv: ["sh", "-lc", setupRuntimeCommand()] },
			env,
			opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
			abort.signal,
		);
		if (setupResult.exitCode !== 0) {
			throw new Error(
				`Vercel Sandbox workspace setup failed: ${setupResult.output}`,
			);
		}

			const commands = [
				...buildCheckoutCommandPlan(opts.input, opts.githubToken),
				{ argv: ["sh", "-lc", setupRuntimeCommand()] },
				{ argv: ["sh", "-lc", installCommand()] },
				{ argv: ["sh", "-lc", testCommand(join(".", "package.json"))] },
			] satisfies CommandSpec[];
		let failed = false;
		for (const [index, command] of commands.entries()) {
			if (index === commands.length - 1) {
				await sandbox.updateNetworkPolicy("deny-all", { signal: abort.signal });
			}
			const result = await runVercelCommand(
				sandbox,
				command,
				{ ...env, ...(command.env ?? {}) },
				opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
				abort.signal,
			);
			artifacts.push(commandArtifact(command, result, opts.now?.() ?? Date.now()));
			if (result.exitCode !== 0) failed = true;
			if ((opts.now?.() ?? Date.now()) - started > timeout) {
				failed = true;
				artifacts.push(timeoutArtifact(timeout, opts.now?.() ?? Date.now()));
				break;
			}
		}
		artifacts.push(generatedTestArtifact(opts.now?.() ?? Date.now()));
		return {
			status: failed ? "failed" : "passed",
			summaryMd: [
				"## Runtime evidence",
				"",
				failed
					? "Vercel Sandbox found runtime/test failures."
					: "Vercel Sandbox ran the branch command suite successfully.",
				"",
				`Sandbox: ${sandbox.name}.`,
				`Commands run: ${commands.length}.`,
			].join("\n"),
			artifacts,
		};
	} catch (error) {
		const message = redactSecrets(
			error instanceof Error ? error.message : String(error),
			[opts.githubToken, credentials?.token].filter(
				(secret): secret is string => Boolean(secret),
			),
		);
		return {
			status: "error",
			summaryMd: [
				"## Runtime evidence",
				"",
				"Vercel Sandbox could not execute this branch.",
			].join("\n"),
			artifacts: [
				{
					kind: "log",
					label: "Vercel Sandbox error",
					summaryMd: "Managed sandbox setup failed before completing the command suite.",
					inlineBody: truncate(message, LOG_LIMIT),
					mimeType: "text/plain",
					byteSize: Buffer.byteLength(message, "utf8"),
					createdAt: opts.now?.() ?? Date.now(),
				},
			],
		};
	} finally {
		clearTimeout(timer);
		if (sandbox !== null) {
			try {
				await sandbox.stop();
			} catch {
				// Billing safety is best-effort here; Vercel still enforces the
				// sandbox timeout configured at creation time.
			}
		}
	}
}

interface CommandSpec {
	readonly argv: readonly string[];
	readonly containerName?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly redactions?: readonly string[];
}

async function buildCommandPlan(
	input: PrExecutionInput,
	workspace: string,
	githubToken?: string,
	dockerImage = DEFAULT_DOCKER_IMAGE,
): Promise<CommandSpec[]> {
	const commands = buildCheckoutCommandPlan(input, githubToken);
	commands.push(
		dockerSandboxCommand(workspace, dockerImage, "install", installCommand()),
	);
	commands.push(
		dockerSandboxCommand(
			workspace,
			dockerImage,
			"test",
			testCommand(join(".", "package.json")),
		),
	);
	return commands;
}

function buildCheckoutCommandPlan(
	input: PrExecutionInput,
	githubToken?: string,
): CommandSpec[] {
	const repoUrl = `https://github.com/${input.owner}/${input.name}.git`;
	const encodedCredential = githubToken
		? Buffer.from(
				`x-access-token:${githubToken}`,
				"utf8",
			).toString("base64")
		: null;
	const authHeader =
		encodedCredential === null ? null : `AUTHORIZATION: basic ${encodedCredential}`;
	const fetchEnv =
		authHeader === null
			? undefined
			: {
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
					GIT_CONFIG_VALUE_0: authHeader,
				};
	const redactions =
		authHeader === null
			? []
			: [githubToken ?? "", encodedCredential ?? "", authHeader].filter(Boolean);
	const commands: CommandSpec[] = [
		{ argv: ["git", "init", "."] },
		{ argv: ["git", "remote", "add", "origin", repoUrl] },
		{
			argv: ["git", "fetch", "--depth=1", "origin", input.headSha],
			...(fetchEnv === undefined ? {} : { env: fetchEnv }),
			redactions,
		},
		{ argv: ["git", "checkout", "--detach", "FETCH_HEAD"] },
		{ argv: ["sh", "-lc", verifyHeadCommand(input.headSha)] },
	];
	return commands;
}

async function buildExecutionEnv(workspace: string): Promise<Record<string, string>> {
	const home = join(workspace, ".home");
	const cache = join(workspace, ".cache");
	await mkdir(home, { recursive: true });
	await mkdir(cache, { recursive: true });
	const env: Record<string, string> = {
		CI: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		HOME: home,
		LANG: process.env.LANG ?? "C.UTF-8",
		LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
		NO_COLOR: "1",
		NPM_CONFIG_CACHE: join(cache, "npm"),
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: workspace,
		XDG_CACHE_HOME: cache,
		XDG_CONFIG_HOME: join(home, ".config"),
		npm_config_cache: join(cache, "npm"),
		npm_config_update_notifier: "false",
	};
	if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
		env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
	}
	return env;
}

function buildVercelExecutionEnv(): Record<string, string> {
	return {
		CI: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		HOME: `${VERCEL_WORKSPACE}/.home`,
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		NO_COLOR: "1",
		NPM_CONFIG_CACHE: `${VERCEL_WORKSPACE}/.cache/npm`,
		PATH: [
			`${VERCEL_WORKSPACE}/.home/.bun/bin`,
			`${VERCEL_WORKSPACE}/.home/.sthrip-tools/node_modules/.bin`,
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		].join(":"),
		TMPDIR: "/tmp",
		XDG_CACHE_HOME: `${VERCEL_WORKSPACE}/.cache`,
		XDG_CONFIG_HOME: `${VERCEL_WORKSPACE}/.home/.config`,
		npm_config_cache: `${VERCEL_WORKSPACE}/.cache/npm`,
		npm_config_update_notifier: "false",
	};
}

async function createDefaultVercelSandbox(
	params: VercelSandboxCreateParams,
): Promise<VercelSandboxHandle> {
	const { Sandbox } = await import("@vercel/sandbox");
	return Sandbox.create(params as Parameters<typeof Sandbox.create>[0]);
}

async function runVercelCommand(
	sandbox: VercelSandboxHandle,
	command: CommandSpec,
	env: Readonly<Record<string, string>>,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<CommandResult> {
	const [cmd, ...args] = command.argv;
	if (cmd === undefined) {
		throw new Error("empty vercel sandbox command");
	}
	try {
		const result = await sandbox.runCommand({
			cmd,
			args: [...args],
			cwd: VERCEL_WORKSPACE,
			env,
			timeoutMs,
			signal,
		});
		const output = truncate(await result.output("both", { signal }), LOG_LIMIT);
		return { exitCode: result.exitCode, output };
	} catch (error) {
		if (signal.aborted) {
			return {
				exitCode: 124,
				output: "command timed out",
			};
		}
		throw error;
	}
}

function setupRuntimeCommand(): string {
	return [
		"mkdir -p .home .cache/npm \"$HOME/.sthrip-tools\";",
		"if [ -f bun.lockb ] || [ -f bun.lock ]; then",
		"  if ! command -v bun >/dev/null 2>&1; then",
		`    if command -v npm >/dev/null 2>&1; then npm install --prefix "$HOME/.sthrip-tools" --no-audit --no-fund ${DEFAULT_BUN_BOOTSTRAP_PACKAGE};`,
		"    else echo 'bun lockfile found but no installer is available'; exit 1; fi;",
		"  fi;",
		"fi",
	].join(" ");
}

function installCommand(): string {
	return [
		"if [ -f bun.lockb ] || [ -f bun.lock ]; then",
		"  printf 'bun' > .sthrip-package-manager;",
		"  if command -v bun >/dev/null 2>&1; then bun install --frozen-lockfile --ignore-scripts;",
		"  else echo 'bun lockfile found but bun is unavailable; refusing install'; exit 1; fi;",
		"elif [ -f package-lock.json ]; then printf 'npm' > .sthrip-package-manager; npm ci --ignore-scripts;",
		"elif [ -f pnpm-lock.yaml ]; then printf 'pnpm' > .sthrip-package-manager; corepack pnpm install --frozen-lockfile --ignore-scripts || npx pnpm install --frozen-lockfile --ignore-scripts;",
		"elif [ -f yarn.lock ]; then printf 'yarn' > .sthrip-package-manager; corepack yarn install --frozen-lockfile --ignore-scripts || npx yarn install --frozen-lockfile --ignore-scripts;",
		"elif [ -f package.json ]; then echo 'package.json found without a trusted lockfile; refusing networked install'; exit 1;",
		"else printf 'none' > .sthrip-package-manager; echo 'no package manager metadata found; skipping install'; fi",
	].join(" ");
}

function testCommand(packageJsonPath: string): string {
	return [
		"if [ ! -f package.json ]; then echo 'no package.json found; skipping tests'; exit 0; fi",
		"node - <<'NODE'",
		"const { readFileSync, writeFileSync } = require('fs');",
		`const pkg = JSON.parse(readFileSync(${JSON.stringify(packageJsonPath)}, 'utf8'));`,
		"let pm = 'npm';",
		"try { pm = readFileSync('.sthrip-package-manager', 'utf8').trim() || 'npm'; } catch {}",
		"const run = (name) => pm === 'bun' ? `bun run ${name}` : pm === 'pnpm' ? `pnpm run ${name}` : pm === 'yarn' ? `yarn run ${name}` : name === 'test' ? 'npm test' : `npm run ${name}`;",
		"const scripts = pkg.scripts || {};",
		"const cmds = ['set -e'];",
		"if (scripts.typecheck) cmds.push(run('typecheck'));",
		"if (scripts.test) cmds.push(run('test'));",
		"if (scripts.build) cmds.push(run('build'));",
		"if (scripts['test:e2e']) cmds.push(`CI=1 ${run('test:e2e')}`);",
		"writeFileSync('.sthrip-runtime-test-plan.sh', cmds.join('\\n'));",
		"if (cmds.length === 0) process.exit(0);",
		"NODE",
		"if [ -s .sthrip-runtime-test-plan.sh ]; then sh .sthrip-runtime-test-plan.sh; else echo 'no runnable package scripts found'; fi",
	].join("\n");
}

function verifyHeadCommand(headSha: string): string {
	return `actual="$(git rev-parse HEAD)" && test "$actual" = "${headSha.toLowerCase()}"`;
}

function dockerSandboxCommand(
	workspace: string,
	image: string,
	step: string,
	script: string,
): CommandSpec {
	const containerName = `${safeContainerName(workspace)}-${step}`;
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const gid = typeof process.getgid === "function" ? process.getgid() : 0;
	const userArgs = uid === 0 ? [] : ["--user", `${uid}:${gid}`];
	return {
		argv: [
			"docker",
			"run",
			"--rm",
			"--name",
			containerName,
			"--network",
			"none",
			"--security-opt",
			"no-new-privileges",
			"--cap-drop",
			"ALL",
			"--pids-limit",
			"256",
			"--memory",
			"2g",
			"--cpus",
			"2",
			...userArgs,
			"-v",
			`${workspace}:/workspace`,
			"-w",
			"/workspace",
			"-e",
			"CI=1",
			"-e",
			"HOME=/tmp/sthrip-home",
			"-e",
			"NPM_CONFIG_CACHE=/tmp/sthrip-cache/npm",
			"-e",
			"npm_config_cache=/tmp/sthrip-cache/npm",
			image,
			"sh",
			"-lc",
			`mkdir -p /tmp/sthrip-home /tmp/sthrip-cache/npm && ${script}`,
		],
		containerName,
	};
}

function safeContainerName(workspace: string): string {
	return basename(workspace).replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function generatedTestArtifact(
	createdAt: number,
): PrExecutionArtifact {
	const body = testCommand(join(".", "package.json"));
	return {
		kind: "generated_test",
		label: "Runtime command generator",
		summaryMd:
			"The worker ran this sandbox-local generator to derive the branch command plan from package scripts.",
		inlineBody: truncate(body, LOG_LIMIT),
		mimeType: "text/x-shellscript",
		byteSize: Buffer.byteLength(body, "utf8"),
		createdAt,
	};
}

function timeoutArtifact(timeoutMs: number, createdAt: number): PrExecutionArtifact {
	const body = `timeout_ms=${timeoutMs}`;
	return {
		kind: "log",
		label: "Runtime timeout",
		summaryMd: "PR execution stopped after the worker timeout budget.",
		inlineBody: body,
		mimeType: "text/plain",
		byteSize: Buffer.byteLength(body, "utf8"),
		createdAt,
	};
}

function vercelSandboxName(input: PrExecutionInput, startedAt: number): string {
	return [
		"sthrip-pr",
		input.reviewId,
		input.owner,
		input.name,
		String(input.prNumber),
		startedAt.toString(36),
	]
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 63)
		.replace(/^-|-$/g, "");
}

function safeTagValue(value: string): string {
	const trimmed = value.replace(/[^a-zA-Z0-9_.:-]/g, "-");
	return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
}

function commandArtifact(
	command: CommandSpec,
	result: CommandResult,
	createdAt: number,
): PrExecutionArtifact {
	const redactions = command.redactions ?? [];
	const shownCommand = redactCommand(command.argv, redactions).join(" ");
	const raw = [
		`$ ${shownCommand}`,
		`exit_code=${result.exitCode}`,
		"",
		redactSecrets(result.output, redactions),
	].join("\n");
	return {
		kind: "log",
		label: shownCommand.slice(0, 160),
		summaryMd:
			result.exitCode === 0
				? "Command completed successfully."
				: "Command failed in the isolated worker.",
		inlineBody: truncate(raw, LOG_LIMIT),
		mimeType: "text/plain",
		byteSize: Buffer.byteLength(raw, "utf8"),
		createdAt,
	};
}

interface CommandResult {
	readonly exitCode: number;
	readonly output: string;
}

async function runCommand(
	command: CommandSpec,
	opts: {
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
		readonly timeoutMs: number;
	},
): Promise<CommandResult> {
	const proc = Bun.spawn([...command.argv], {
		cwd: opts.cwd,
		detached: true,
		env: opts.env,
		killSignal: "SIGKILL",
		maxBuffer: LOG_LIMIT * 2,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	let forceKill: ReturnType<typeof setTimeout> | null = null;
	const timeout = setTimeout(() => {
		timedOut = true;
		killProcessGroup(proc.pid, "SIGTERM");
		if (command.containerName) removeDockerContainer(command.containerName, opts.env);
		forceKill = setTimeout(() => killProcessGroup(proc.pid, "SIGKILL"), 2_000);
	}, opts.timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const output = truncate([stdout, stderr].filter(Boolean).join("\n"), LOG_LIMIT);
		return {
			exitCode: timedOut && exitCode === 0 ? 124 : exitCode,
			output: timedOut
				? truncate(`${output}\n\n[sthrip] command timed out`, LOG_LIMIT)
				: output,
		};
	} finally {
		clearTimeout(timeout);
		if (forceKill !== null) clearTimeout(forceKill);
	}
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Process already exited.
		}
	}
}

function removeDockerContainer(
	containerName: string,
	env: Readonly<Record<string, string>>,
): void {
	try {
		Bun.spawn(["docker", "rm", "-f", containerName], {
			env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	} catch {
		// Docker may be absent or the container may already be gone.
	}
}

function redactCommand(command: readonly string[], redactions: readonly string[]): string[] {
	return command.map((part) => redactSecrets(part, redactions));
}

function redactSecrets(value: string, redactions: readonly string[]): string {
	let redacted = value;
	for (const secret of redactions) {
		if (secret !== "") redacted = redacted.split(secret).join("[redacted]");
	}
	return redacted;
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
