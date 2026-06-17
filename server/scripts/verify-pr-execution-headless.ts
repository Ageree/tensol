import type { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

import type { AuthVariables } from "../src/auth/middleware.ts";
import { type DB, createDb } from "../src/db/client.ts";
import { createRemotePrExecutionRunner } from "../src/review/execution/runner.ts";
import { createReviewService } from "../src/review/service.ts";
import { createConfigFeatureFlagsRouter } from "../src/routes/config-feature-flags.ts";
import { createReviewRouter } from "../src/routes/review.ts";
import { createAgent } from "../../vps-agent/src/agent.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "server", "migrations");
const USER_ID = "user_1";
const AUDIT_KEY = "headless-pr-execution-smoke-0123456789abcdef0123456789abcdef";
const WORKER_SECRET = "headless-pr-execution-worker-secret-0123456789abcdef";

async function loadPlaywright() {
	return import(
		pathToFileURL(
			join(ROOT, "apps", "site", "node_modules", "@playwright", "test", "index.js"),
		).href
	) as Promise<typeof import("@playwright/test")>;
}

function migrationSql(): string {
	return readdirSync(MIGRATIONS_DIR)
		.filter((file) => file.endsWith(".sql"))
		.sort()
		.map((file) =>
			readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(
				/-->\s*statement-breakpoint/g,
				"",
			),
		)
		.join("\n");
}

function freshDb(): DB {
	const db = createDb(":memory:");
	(db.$client as Database).exec(migrationSql());
	(db.$client as Database)
		.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
		.run(USER_ID, "headless@sthrip.dev", Date.now());
	return db;
}

function envWith(overrides: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...overrides };
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
	const started = Date.now();
	let lastError: unknown;
	while (Date.now() - started < timeoutMs) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
			lastError = new Error(`${url} returned ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(250);
	}
	throw lastError instanceof Error
		? lastError
		: new Error(`Timed out waiting for ${url}`);
}

async function seedReview(
	service: ReturnType<typeof createReviewService>,
	execution: ReturnType<typeof createRemotePrExecutionRunner>,
) {
	const repo = await service.upsertRepo({
		userId: USER_ID,
		owner: "acme",
		name: "checkout",
	});
	await service.updateRepoSettings({
		repoId: repo.id,
		userId: USER_ID,
		prExecutionEnabled: true,
	});
	const review = await service.createReview({
		repoId: repo.id,
		userId: USER_ID,
		kind: "pr",
		prNumber: 42,
		headSha: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
		baseSha: "0000000000000000000000000000000000000000",
	});
	await service.markReviewRunning(review.id);
	await service.finalizeReview(review.id, {
		score0to5: 5,
		summaryMd: "Static review passed; runtime evidence is attached below.",
		findings: [],
	});
	const executionResult = await execution.run({
		reviewId: review.id,
		repoId: repo.id,
		owner: repo.owner,
		name: repo.name,
		prNumber: 42,
		headSha: review.headSha ?? "",
		baseSha: review.baseSha,
		files: [],
	});
	await service.recordExecutionResult(review.id, executionResult);
	return { repoId: repo.id, reviewId: review.id };
}

async function main(): Promise<void> {
	process.env.STHRIP_PR_EXECUTION_ENABLED = "true";

	const db = freshDb();
	const service = createReviewService({
		db,
		auditKey: AUDIT_KEY,
		now: () => Date.now(),
	});
	const worker = createAgent({
		signKey: "",
		scanId: "",
		runScan: async () => ({
			status: "failed",
			failure_reason: "not_configured",
			findings: [],
			usage: null,
		}),
		sendCallback: async () => ({ ok: true, attempts: 1, status: 200 }),
		prExecutionSecret: WORKER_SECRET,
		runPrExecution: async (opts) => ({
			status: "passed",
			summaryMd:
				"Headless smoke passed via signed worker dispatch: local UI opened the review, toggled runtime settings, and rendered execution artifacts.",
			artifacts: [
				{
					kind: "generated_test",
					label: "Generated regression test",
					summaryMd: `The worker accepted signed head ${opts.input.headSha.slice(0, 12)} and returned a generated test artifact.`,
					inlineBody:
						"test('checkout happy path', async ({ page }) => { await page.goto('/checkout'); });",
					mimeType: "text/typescript",
					byteSize: 91,
					createdAt: Date.now(),
				},
				{
					kind: "log",
					label: "Signed worker log",
					summaryMd: "The local /pr-execution worker verified the HMAC envelope.",
					inlineBody:
						"[runtime] verified signed envelope\n[runtime] mocked GET /api/cart\n[runtime] clicked Pay\n[runtime] passed",
					mimeType: "text/plain",
					byteSize: 105,
					createdAt: Date.now(),
				},
			],
		}),
		now: () => Date.now(),
	});
	const workerServer = Bun.serve({
		hostname: "127.0.0.1",
		port: await freePort(),
		fetch: worker.app.fetch,
	});
	const execution = createRemotePrExecutionRunner({
		url: `http://127.0.0.1:${workerServer.port}/pr-execution`,
		secret: WORKER_SECRET,
		timeoutMs: 20_000,
	});
	const seeded = await seedReview(service, execution);

	const sitePort = await freePort();
	const siteUrl = `http://127.0.0.1:${sitePort}`;
	const auth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
		c.set("user", { id: USER_ID, email: "headless@sthrip.dev" });
		c.set("session", {
			id: "headless-session",
			user_id: USER_ID,
			expires_at: Date.now() + 60_000,
		});
		await next();
	};

	const api = new Hono<{ Variables: AuthVariables }>();
	api.use(
		"*",
		cors({
			origin: siteUrl,
			allowHeaders: ["content-type", "authorization"],
			allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
			credentials: true,
		}),
	);
	api.route("/v1/config/feature-flags", createConfigFeatureFlagsRouter());
	api.route(
		"/v1/review",
		createReviewRouter({
			db,
			service,
			requireAuth: auth,
			now: () => Date.now(),
		}),
	);

	const apiServer = Bun.serve({
		hostname: "127.0.0.1",
		port: await freePort(),
		fetch: api.fetch,
	});
	const apiBaseUrl = `http://127.0.0.1:${apiServer.port}`;

	const vite = Bun.spawn(["bun", "run", "dev", "--host", "127.0.0.1", "--port", String(sitePort)], {
		cwd: join(ROOT, "apps", "site"),
		stdout: "pipe",
		stderr: "pipe",
		env: envWith({
			VITE_API_BASE_URL: apiBaseUrl,
			VITE_E2E_AUTH_BYPASS: "true",
		}),
	});

	const { chromium, expect } = await loadPlaywright();
	const browser = await chromium.launch({ headless: true });
	try {
		await waitFor(siteUrl);
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

		await page.goto(`${siteUrl}/reviews`, { waitUntil: "networkidle" });
		await expect(page.getByText("Runtime execution")).toBeVisible();
		await expect(page.getByText("acme/checkout", { exact: true })).toBeVisible();
		await expect(page.getByText("passed").first()).toBeVisible();

		const runtimeCheckbox = page.getByLabel("Runtime execution");
		await expect(runtimeCheckbox).toBeChecked();
		await page.getByText("Runtime execution", { exact: true }).click();
		await expect(runtimeCheckbox).not.toBeChecked();
		await expect(page.getByText("Runtime execution", { exact: true })).toBeVisible();
		await page.getByText("Runtime execution", { exact: true }).click();
		await expect(runtimeCheckbox).toBeChecked();

		await page.goto(`${siteUrl}/reviews/${seeded.reviewId}`, {
			waitUntil: "networkidle",
		});
		await expect(page.getByText("Runtime evidence", { exact: true })).toBeVisible();
		await expect(page.getByText("Headless smoke passed")).toBeVisible();
		await expect(page.getByText("Generated regression test")).toBeVisible();
		await expect(page.getByText("Signed worker log")).toBeVisible();

		const screenshotPath = join(ROOT, ".omx", "state", "pr-execution-headless.png");
		await page.screenshot({ path: screenshotPath, fullPage: true });

		const repo = await service.getRepo(seeded.repoId);
		if (repo?.prExecutionEnabled !== 1) {
			throw new Error("Runtime execution checkbox did not persist through PATCH");
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					apiBaseUrl,
					siteUrl,
					reviewId: seeded.reviewId,
					screenshotPath,
				},
				null,
				2,
			),
		);
	} finally {
		await browser.close();
		vite.kill();
			apiServer.stop(true);
			workerServer.stop(true);
			(db.$client as Database).close();
		await Promise.allSettled([
			new Response(vite.stdout).text(),
			new Response(vite.stderr).text(),
		]);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
