/**
 * GitHub App PR trigger smoke.
 *
 * This is the final live gate from
 * `.omx/plans/2026-06-06-unblock-github-pr-review-trigger.md`, packaged as a
 * repeatable runner. It intentionally uses the GitHub App path for webhook
 * delivery and installation tokens. A PAT is used only to create and clean up a
 * throwaway PR in the controlled test repo.
 *
 * Required:
 *   GITHUB_APP_ID
 *   GITHUB_APP_PRIVATE_KEY
 *   GITHUB_APP_WEBHOOK_SECRET
 *   GITHUB_TOKEN or GH_TOKEN
 *   TENSOL_PUBLIC_WEBHOOK_BASE_URL or TENSOL_WEBHOOK_BASE_URL
 *
 * Hook config:
 *   By default the script verifies the App hook URL but does not mutate it.
 *   Set E2E_PATCH_APP_HOOK=1 to temporarily patch URL/content_type/insecure_ssl.
 *   The webhook secret must already match GITHUB_APP_WEBHOOK_SECRET; GitHub does
 *   not expose the previous secret, so this runner never mutates it.
 *
 * Backend:
 *   TENSOL_E2E_BACKEND_BASE_URL defaults to http://127.0.0.1:3000
 *   The backend must expose /__test/v2 helpers for setup seeding.
 *
 * Example:
 *   TENSOL_PUBLIC_WEBHOOK_BASE_URL=https://example.ngrok-free.app \
 *   TENSOL_E2E_BACKEND_BASE_URL=http://127.0.0.1:3000 \
 *   GITHUB_TOKEN=$(gh auth token) \
 *   bun run scripts/e2e/github-app-pr-trigger-smoke.ts
 */
import { buildAppJwt } from "../../src/review/github/sign.ts";

const GITHUB_API = "https://api.github.com";
const OWNER = env("E2E_OWNER") || "Ageree";
const REPO = env("E2E_REPO") || "sthrip-review-testbed";
const BASE_BRANCH = env("E2E_BASE_BRANCH") || "main";
const BACKEND_BASE_URL = trimTrailingSlash(
	env("TENSOL_E2E_BACKEND_BASE_URL") || "http://127.0.0.1:3000",
);
const PUBLIC_WEBHOOK_BASE_URL = trimTrailingSlash(
	env("TENSOL_PUBLIC_WEBHOOK_BASE_URL") || env("TENSOL_WEBHOOK_BASE_URL") || "",
);
const WEBHOOK_URL = PUBLIC_WEBHOOK_BASE_URL
	? `${PUBLIC_WEBHOOK_BASE_URL}/v1/review/github/webhook`
	: "";
const KEEP_PR = env("E2E_KEEP_PR") === "1";
const PATCH_APP_HOOK = env("E2E_PATCH_APP_HOOK") === "1";
const TIMEOUT_MS = numberEnv("E2E_TIMEOUT_MS", 180_000);
const POLL_MS = numberEnv("E2E_POLL_MS", 3_000);

interface HookConfig {
	url?: string;
	content_type?: string;
	insecure_ssl?: string;
}

interface SmokeReport {
	status: "complete" | "blocked";
	repo: string;
	app?: { id?: string; slug?: string; hook_url?: string };
	pr?: {
		number: number;
		url: string;
		branch: string;
		head_sha: string;
		cleaned_up: boolean;
	};
	delivery?: {
		id?: string | number;
		guid?: string;
		event?: string;
		status_code?: number;
		response_status?: string;
	};
	review?: {
		id?: string;
		status?: string;
		job_id?: string;
		job_status?: string;
		summary?: string | null;
	};
	github_result?: {
		review_count?: number;
		sthrip_review_count?: number;
		app_attributed_artifact_count?: number;
		latest_review_author?: string | null;
		commit_status_state?: string | null;
		sthrip_status_context?: string | null;
		check_count?: number;
		sthrip_check_count?: number;
	};
	verification: string[];
	missing?: string[];
	blocker?: string;
}

interface GitHubResult {
	review_count: number;
	sthrip_review_count: number;
	app_attributed_artifact_count: number;
	latest_review_author: string | null;
	commit_status_state: string | null;
	sthrip_status_context: string | null;
	check_count: number;
	sthrip_check_count: number;
}

interface GitHubInstallation {
	id: number;
	app_id?: number;
	account?: { login?: string; type?: string };
	repository_selection?: "all" | "selected";
}

type DeliveryId = string;

interface DeliverySummary {
	id?: DeliveryId;
	guid?: string;
	delivered_at?: string;
	redelivery?: boolean;
	status_code?: number;
	status?: string;
	event?: string;
	action?: string;
	installation_id?: number;
	repository_id?: number;
}

interface DeliveryDetail extends DeliverySummary {
	request?: {
		headers?: Array<{ name?: string; value?: string }> | Record<string, string>;
		payload?: unknown;
	};
	response?: {
		headers?: Array<{ name?: string; value?: string }> | Record<string, string>;
		payload?: unknown;
		status?: string;
	};
}

interface CreatedPr {
	number: number;
	url: string;
	branch: string;
	headSha: string;
}

interface WebhookQueuedResult {
	status: "queued";
	review_id: string;
	job_id: string;
}

interface AgentJob {
	job_id: string;
	review_id: string;
	type: string;
	status: string;
	last_error?: string | null;
}

async function main(): Promise<void> {
	const missing = requiredEnvMissing();
	if (missing.length > 0) {
		printReport({
			status: "blocked",
			repo: `${OWNER}/${REPO}`,
			missing,
			blocker: "missing_required_environment",
			verification: ["env preflight failed before any external mutation"],
		});
		process.exit(2);
	}

	const appId = mustEnv("GITHUB_APP_ID");
	const appPrivateKey = mustEnv("GITHUB_APP_PRIVATE_KEY");
	const webhookSecret = mustEnv("GITHUB_APP_WEBHOOK_SECRET");
	const pat = env("GITHUB_TOKEN") || env("GH_TOKEN") || "";
	const appJwt = buildAppJwt({ appId, privateKeyPem: appPrivateKey });
	const verification: string[] = [];
	let createdPr: CreatedPr | null = null;
	let cleanedUp = false;
	let restoreHookConfig: HookConfig | null = null;

	try {
		const health = await getJson<{ ok?: boolean; status?: string }>(
			`${BACKEND_BASE_URL}/healthz`,
			{},
			"backend health",
		);
		verification.push(
			`backend health ok: ${JSON.stringify(health).slice(0, 120)}`,
		);

		const publicHealth = await getJson<{ ok?: boolean; status?: string }>(
			`${PUBLIC_WEBHOOK_BASE_URL}/healthz`,
			{},
			"public backend health",
		);
		verification.push(
			`public backend health ok: ${JSON.stringify(publicHealth).slice(0, 120)}`,
		);

		const app = await githubAppFetch<{
			id?: number;
			slug?: string;
			name?: string;
		}>(appJwt, "/app", {}, "GET /app");
		if (!app.slug) {
			throw new Error(
				"GitHub App response did not include slug; cannot verify App-attributed artifacts safely",
			);
		}
		verification.push(
			`GitHub App JWT accepted for app ${app.slug ?? app.name ?? app.id ?? "unknown"}`,
		);

		const installation = await findInstallationForRepo(appJwt, OWNER, REPO);
		verification.push(
			`installation ${installation.id} includes ${OWNER}/${REPO}`,
		);

		const hookSetup = await ensureHookConfig(
			appJwt,
			WEBHOOK_URL,
			webhookSecret,
		);
		restoreHookConfig = hookSetup.restore ?? null;
		verification.push(
			`app hook configured: ${hookSetup.current.url ?? WEBHOOK_URL}`,
		);

		const seed = await seedBackend(installation.id);
		verification.push(
			`backend seeded repo row ${seed.repo_id} for installation ${seed.installation_id}`,
		);

		const beforeDeliveryIds = await listRecentDeliveryIds(appJwt);
		createdPr = await createPullRequestWithPat(pat);
		verification.push(
			`created PR #${createdPr.number} at ${createdPr.headSha.slice(0, 7)}`,
		);

		const delivery = await waitForPullRequestDelivery(
			appJwt,
			beforeDeliveryIds,
			OWNER,
			REPO,
			createdPr.number,
			installation.id,
		);
		const webhookResult = extractWebhookResult(delivery);
		verification.push(
			`delivery accepted: id=${delivery.id ?? "?"} guid=${delivery.guid ?? "?"} status=${delivery.status_code ?? "?"} review=${webhookResult.review_id}`,
		);

		const agentToken = await createAgentToken(seed.session_id);
		const job = await waitForJobDone(agentToken, webhookResult.job_id);
		verification.push(
			`job ${job.job_id} terminal status=${job.status} type=${job.type}`,
		);

		const review = await waitForBackendReview(
			seed.installation_row_id,
			seed.repo_id,
			seed.session_id,
			webhookResult.review_id,
		);
		verification.push(`backend review completed: ${review.id ?? "?"}`);

		const githubResult = await readGitHubResult(pat, createdPr, app.slug);
		verification.push(
			`GitHub result observed: sthrip_reviews=${githubResult.sthrip_review_count}, sthrip_checks=${githubResult.sthrip_check_count}, sthrip_status=${githubResult.sthrip_status_context ?? "none"}, app_attributed=${githubResult.app_attributed_artifact_count}`,
		);

		if (!KEEP_PR) {
			cleanedUp = await cleanupPullRequest(pat, createdPr);
			verification.push(
				`cleanup PR/branch: ${cleanedUp ? "done" : "not_confirmed"}`,
			);
		}

		await restoreHookIfNeeded(appJwt, restoreHookConfig, verification);

		printReport({
			status: "complete",
			repo: `${OWNER}/${REPO}`,
			app: {
				id: String(app.id ?? appId),
				slug: app.slug,
				hook_url: hookSetup.current.url ?? WEBHOOK_URL,
			},
			pr: {
				number: createdPr.number,
				url: createdPr.url,
				branch: createdPr.branch,
				head_sha: createdPr.headSha,
				cleaned_up: cleanedUp,
			},
			delivery: {
				id: delivery.id,
				guid: delivery.guid,
				event: delivery.event,
				status_code: delivery.status_code,
				response_status: delivery.response?.status,
			},
			review: {
				id: review.id,
				status: review.status,
				job_id: job.job_id,
				job_status: job.status,
				summary: review.summary_md,
			},
			github_result: githubResult,
			verification,
		});
	} catch (err) {
		if (createdPr && !KEEP_PR) {
			cleanedUp = await cleanupPullRequest(pat, createdPr).catch(() => false);
			verification.push(
				`cleanup after failure: ${cleanedUp ? "done" : "failed"}`,
			);
		}
		await restoreHookIfNeeded(appJwt, restoreHookConfig, verification).catch(
			(restoreErr) => {
				verification.push(`hook restore failed: ${errorMessage(restoreErr)}`);
			},
		);
		printReport({
			status: "blocked",
			repo: `${OWNER}/${REPO}`,
			blocker: errorMessage(err),
			...(createdPr
				? {
						pr: {
							number: createdPr.number,
							url: createdPr.url,
							branch: createdPr.branch,
							head_sha: createdPr.headSha,
							cleaned_up: cleanedUp,
						},
					}
				: {}),
			verification,
		});
		process.exit(1);
	}
}

async function ensureHookConfig(
	appJwt: string,
	webhookUrl: string,
	webhookSecret: string,
): Promise<{ current: HookConfig; restore?: HookConfig }> {
	if (!webhookUrl) throw new Error("public webhook URL is required");

	const previous = await githubAppFetch<HookConfig>(
		appJwt,
		"/app/hook/config",
		{},
		"GET /app/hook/config",
	);

	if (PATCH_APP_HOOK) {
		const body: Record<string, string> = {
			url: webhookUrl,
			content_type: "json",
			insecure_ssl: "0",
		};

		const current = await githubAppFetch<HookConfig>(
			appJwt,
			"/app/hook/config",
			{
				method: "PATCH",
				body: JSON.stringify(body),
			},
			"PATCH /app/hook/config",
		);
		return { current, restore: previous };
	}

	if (previous.url !== webhookUrl) {
		throw new Error(
			`app hook URL mismatch: current=${previous.url ?? "(empty)"} expected=${webhookUrl}; set E2E_PATCH_APP_HOOK=1 to patch URL temporarily`,
		);
	}
	return { current: previous };
}

async function restoreHookIfNeeded(
	appJwt: string,
	restore: HookConfig | null,
	verification: string[],
): Promise<void> {
	if (!restore) return;
	const body: Record<string, string> = {};
	if (restore.url) body.url = restore.url;
	if (restore.content_type) body.content_type = restore.content_type;
	if (restore.insecure_ssl) body.insecure_ssl = restore.insecure_ssl;
	if (Object.keys(body).length === 0) return;

	await githubAppFetch(
		appJwt,
		"/app/hook/config",
		{ method: "PATCH", body: JSON.stringify(body) },
		"restore /app/hook/config",
	);
	verification.push("restored app hook URL/config");
}

async function findInstallationForRepo(
	appJwt: string,
	owner: string,
	repo: string,
): Promise<GitHubInstallation> {
	const installation = await githubAppFetch<GitHubInstallation>(
		appJwt,
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
		{},
		"GET repo installation",
	);
	const explicit = env("GITHUB_APP_INSTALLATION_ID");
	if (explicit) {
		if (String(installation.id) !== explicit) {
			throw new Error(
				`repo installation mismatch: expected ${explicit}, got ${installation.id}`,
			);
		}
	}
	return installation;
}

async function seedBackend(installationId: number): Promise<{
	session_id: string;
	user_id: string;
	installation_row_id: string;
	installation_id: string;
	repo_id: string;
}> {
	const preseeded = readPreseededBackendState(installationId);
	if (preseeded) return preseeded;

	const session = await postBackend<{ session_id: string; user_id: string }>(
		"/__test/v2/seed-session",
		{ email: `github-app-smoke+${Date.now()}@example.test` },
		{},
		"seed session",
	);
	const repo = await postBackend<{
		installation_row_id: string;
		installation_id: string;
		repo_id: string;
	}>(
		"/__test/v2/seed-review-repo",
		{
			user_id: session.user_id,
			owner: OWNER,
			name: REPO,
			installation_id: String(installationId),
			enabled: true,
			covered_branches: [BASE_BRANCH],
			status_check_enabled: true,
			merge_block_on_critical: true,
		},
		{},
		"seed review repo",
	);
	return { ...session, ...repo };
}

function readPreseededBackendState(installationId: number): {
	session_id: string;
	user_id: string;
	installation_row_id: string;
	installation_id: string;
	repo_id: string;
} | null {
	const sessionId = env("E2E_SESSION_ID");
	const userId = env("E2E_USER_ID");
	const installationRowId = env("E2E_INSTALLATION_ROW_ID");
	const repoId = env("E2E_REPO_ID");
	if (!sessionId && !userId && !installationRowId && !repoId) return null;

	const missing = [
		["E2E_SESSION_ID", sessionId],
		["E2E_USER_ID", userId],
		["E2E_INSTALLATION_ROW_ID", installationRowId],
		["E2E_REPO_ID", repoId],
	].filter(([, value]) => !value);
	if (missing.length > 0) {
		throw new Error(
			`preseeded backend state is incomplete: missing ${missing
				.map(([name]) => name)
				.join(", ")}`,
		);
	}

	return {
		session_id: sessionId,
		user_id: userId,
		installation_row_id: installationRowId,
		installation_id: String(installationId),
		repo_id: repoId,
	};
}

async function createPullRequestWithPat(pat: string): Promise<CreatedPr> {
	const stamp = Date.now();
	const branch = `${env("E2E_BRANCH_PREFIX") || "sthrip-app-pr-smoke"}-${stamp}`;
	const path = `sthrip-smoke-${stamp}.js`;
	const fixture = [
		"import { execSync } from 'node:child_process';",
		"",
		"export function smoke(req, res) {",
		"  const token = 'STHRIP_SMOKE_SENTINEL_NOT_A_SECRET';",
		"  const output = execSync('cat ' + req.query.file);",
		"  res.end(token + output);",
		"}",
		"",
	].join("\n");

	const ref = await githubPatFetch<{ object?: { sha?: string } }>(
		pat,
		`/repos/${OWNER}/${REPO}/git/ref/heads/${encodeURIComponent(BASE_BRANCH)}`,
		{},
		"GET base ref",
	);
	const baseSha = ref.object?.sha;
	if (!baseSha) throw new Error(`could not resolve base ref ${BASE_BRANCH}`);

	const baseCommit = await githubPatFetch<{ tree?: { sha?: string } }>(
		pat,
		`/repos/${OWNER}/${REPO}/git/commits/${baseSha}`,
		{},
		"GET base commit",
	);
	const baseTree = baseCommit.tree?.sha;
	if (!baseTree) throw new Error("could not resolve base tree");

	const blob = await githubPatFetch<{ sha?: string }>(
		pat,
		`/repos/${OWNER}/${REPO}/git/blobs`,
		{
			method: "POST",
			body: JSON.stringify({ content: fixture, encoding: "utf-8" }),
		},
		"POST blob",
	);
	if (!blob.sha) throw new Error("could not create fixture blob");

	const tree = await githubPatFetch<{ sha?: string }>(
		pat,
		`/repos/${OWNER}/${REPO}/git/trees`,
		{
			method: "POST",
			body: JSON.stringify({
				base_tree: baseTree,
				tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
			}),
		},
		"POST tree",
	);
	if (!tree.sha) throw new Error("could not create fixture tree");

	const commit = await githubPatFetch<{ sha?: string }>(
		pat,
		`/repos/${OWNER}/${REPO}/git/commits`,
		{
			method: "POST",
			body: JSON.stringify({
				message: "Add Sthrip GitHub App PR smoke fixture",
				tree: tree.sha,
				parents: [baseSha],
			}),
		},
		"POST commit",
	);
	if (!commit.sha) throw new Error("could not create fixture commit");

	await githubPatFetch(
		pat,
		`/repos/${OWNER}/${REPO}/git/refs`,
		{
			method: "POST",
			body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
		},
		"POST branch ref",
	);

	const pr = await githubPatFetch<{ number?: number; html_url?: string }>(
		pat,
		`/repos/${OWNER}/${REPO}/pulls`,
		{
			method: "POST",
			body: JSON.stringify({
				title: "Sthrip GitHub App PR smoke",
				head: branch,
				base: BASE_BRANCH,
				body: "Smoke test for the real GitHub App PR review trigger.",
			}),
		},
		"POST pull request",
	);
	if (!pr.number || !pr.html_url)
		throw new Error("could not create pull request");

	return { number: pr.number, url: pr.html_url, branch, headSha: commit.sha };
}

async function listRecentDeliveryIds(appJwt: string): Promise<Set<DeliveryId>> {
	const deliveries = await listAppDeliveries(
		appJwt,
		"/app/hook/deliveries?per_page=30",
		"GET /app/hook/deliveries before",
	).catch(() => []);
	return new Set(
		deliveries
			.map((d) => d.id)
			.filter((id): id is DeliveryId => typeof id === "string"),
	);
}

async function listAppDeliveries(
	appJwt: string,
	path: string,
	label: string,
): Promise<DeliverySummary[]> {
	const raw = await githubAppFetchText(appJwt, path, {}, label);
	const parsed = JSON.parse(raw) as DeliverySummary[];
	const ids = Array.from(raw.matchAll(/"id"\s*:\s*(\d+)/g), (m) => m[1]).filter(
		(id): id is DeliveryId => typeof id === "string",
	);
	return parsed.map((delivery, i) => ({
		...delivery,
		id:
			ids[i] ??
			(typeof delivery.id === "string"
				? delivery.id
				: delivery.id === undefined
					? undefined
					: String(delivery.id)),
	}));
}

async function getAppDelivery(
	appJwt: string,
	deliveryId: DeliveryId,
): Promise<DeliveryDetail> {
	const raw = await githubAppFetchText(
		appJwt,
		`/app/hook/deliveries/${deliveryId}`,
		{},
		"GET /app/hook/deliveries/:id",
	);
	const parsed = JSON.parse(raw) as DeliveryDetail;
	return { ...parsed, id: deliveryId };
}

async function waitForPullRequestDelivery(
	appJwt: string,
	beforeIds: Set<DeliveryId>,
	owner: string,
	repo: string,
	prNumber: number,
	installationId: number,
): Promise<DeliveryDetail> {
	return poll("GitHub App delivery", async () => {
		const deliveries = await listAppDeliveries(
			appJwt,
			"/app/hook/deliveries?per_page=50",
			"GET /app/hook/deliveries",
		);
		const candidates = deliveries.filter(
			(d) => d.event === "pull_request" && (!d.id || !beforeIds.has(d.id)),
		);
		for (const candidate of candidates) {
			if (candidate.id === undefined) continue;
			const detail = await getAppDelivery(
				appJwt,
				candidate.id,
			);
			const payload = detail.request?.payload;
			if (payloadMatchesPr(payload, owner, repo, prNumber, installationId)) {
				const ok =
					typeof detail.status_code === "number"
						? detail.status_code >= 200 && detail.status_code < 300
						: typeof candidate.status_code === "number" &&
							candidate.status_code >= 200 &&
							candidate.status_code < 300;
				if (!ok) {
					throw new Error(
						`delivery ${candidate.id} matched PR but was not 2xx (status=${detail.status_code ?? candidate.status_code ?? "unknown"})`,
					);
				}
				return detail;
			}
		}
		return undefined;
	});
}

function payloadMatchesPr(
	payload: unknown,
	owner: string,
	repo: string,
	prNumber: number,
	installationId: number,
): boolean {
	if (!payload || typeof payload !== "object") return false;
	const p = payload as {
		installation?: { id?: number | string };
		repository?: { full_name?: string };
		pull_request?: { number?: number };
		number?: number;
	};
	return (
		p.repository?.full_name === `${owner}/${repo}` &&
		(p.pull_request?.number === prNumber || p.number === prNumber) &&
		String(p.installation?.id ?? "") === String(installationId)
	);
}

function extractWebhookResult(delivery: DeliveryDetail): WebhookQueuedResult {
	const raw = delivery.response?.payload;
	const parsed = parseMaybeJson(raw) as Partial<WebhookQueuedResult> | null;
	if (
		!parsed ||
		parsed.status !== "queued" ||
		typeof parsed.review_id !== "string" ||
		typeof parsed.job_id !== "string"
	) {
		throw new Error(
			`delivery response did not include queued review_id/job_id: ${JSON.stringify(raw).slice(0, 500)}`,
		);
	}
	return {
		status: "queued",
		review_id: parsed.review_id,
		job_id: parsed.job_id,
	};
}

async function createAgentToken(sessionId: string): Promise<string> {
	const json = await postBackend<{ token?: string }>(
		"/v1/agent/tokens",
		{ name: `github-app-smoke-${Date.now()}` },
		{ headers: { cookie: `tensol_session=${sessionId}` } },
		"create agent token",
	);
	if (!json.token)
		throw new Error("agent token response did not include token");
	return json.token;
}

async function waitForJobDone(
	agentToken: string,
	jobId: string,
): Promise<AgentJob> {
	return poll("pr_review job done", async () => {
		const job = await getJson<AgentJob>(
			`${BACKEND_BASE_URL}/v1/agent/jobs/${encodeURIComponent(jobId)}`,
			{ headers: { authorization: `Bearer ${agentToken}` } },
			"GET agent job",
		);
		if (job.type !== "pr_review") {
			throw new Error(`expected pr_review job ${jobId}, got ${job.type}`);
		}
		if (job.status === "done") return job;
		if (job.status === "failed" || job.status === "cancelled") {
			throw new Error(
				`job ${jobId} terminal failure status=${job.status} error=${job.last_error ?? ""}`,
			);
		}
		return undefined;
	});
}

async function waitForBackendReview(
	installationRowId: string,
	repoId: string,
	sessionId: string,
	reviewId: string,
): Promise<{
	id?: string;
	status?: string;
	job_id?: string;
	summary_md?: string | null;
}> {
	return poll("backend review completion", async () => {
		const repos = await getJson<
			Array<{
				repo_id?: string | null;
				last_review?: { review_id?: string; status?: string } | null;
			}>
		>(
			`${BACKEND_BASE_URL}/v1/github/installations/${encodeURIComponent(installationRowId)}/repos`,
			{ headers: { cookie: `tensol_session=${sessionId}` } },
			"GET installation repos",
		);
		const last = repos.find((r) => r.repo_id === repoId)?.last_review;
		if (!last?.review_id) return undefined;
		if (last.review_id !== reviewId) {
			throw new Error(
				`seeded repo last_review mismatch: expected ${reviewId}, got ${last.review_id}`,
			);
		}

		const review = await getJson<{
			id?: string;
			status?: string;
			job_id?: string;
			summary_md?: string | null;
		}>(
			`${BACKEND_BASE_URL}/v1/review/${encodeURIComponent(reviewId)}`,
			{ headers: { cookie: `tensol_session=${sessionId}` } },
			"GET review",
		);
		if (review.status === "completed") return review;
		if (review.status === "failed") {
			throw new Error(
				`backend review failed: ${JSON.stringify(review).slice(0, 500)}`,
			);
		}
		return undefined;
	});
}

async function readGitHubResult(
	pat: string,
	pr: CreatedPr,
	expectedAppSlug: string,
): Promise<GitHubResult> {
	const reviews = await githubPatFetch<
		Array<{
			user?: { login?: string; type?: string };
			state?: string;
			body?: string | null;
		}>
	>(
		pat,
		`/repos/${OWNER}/${REPO}/pulls/${pr.number}/reviews`,
		{},
		"GET PR reviews",
	).catch(() => []);
	const status = await githubPatFetch<{
		state?: string;
		statuses?: Array<{
			context?: string | null;
			description?: string | null;
			creator?: { login?: string; type?: string } | null;
		}>;
	}>(
		pat,
		`/repos/${OWNER}/${REPO}/commits/${pr.headSha}/status`,
		{},
		"GET commit status",
	).catch(() => ({ state: null, statuses: [] }));
	const checks = await githubPatFetch<{
		total_count?: number;
		check_runs?: Array<{
			name?: string | null;
			app?: { slug?: string | null; name?: string | null } | null;
			output?: { title?: string | null; summary?: string | null };
		}>;
	}>(
		pat,
		`/repos/${OWNER}/${REPO}/commits/${pr.headSha}/check-runs`,
		{},
		"GET check runs",
	).catch(() => ({ total_count: 0, check_runs: [] }));

	const sthripReviews = reviews.filter((r) =>
		/Sthrip Review/i.test(r.body ?? ""),
	);
	const appReviews = sthripReviews.filter((r) =>
		isExpectedAppActor(r.user?.login, expectedAppSlug),
	);
	const sthripStatus = (status.statuses ?? []).find(
		(s) =>
			/^Sthrip\b/i.test(s.context ?? "") ||
			/Sthrip Review/i.test(s.description ?? ""),
	);
	const appStatus =
		sthripStatus &&
		isExpectedAppActor(sthripStatus.creator?.login, expectedAppSlug)
			? sthripStatus
			: null;
	const sthripChecks = (checks.check_runs ?? []).filter(
		(c) =>
			/^Sthrip\b/i.test(c.name ?? "") ||
			/Sthrip Review/i.test(c.output?.title ?? "") ||
			/Sthrip Review/i.test(c.output?.summary ?? ""),
	);
	const appChecks = sthripChecks.filter((c) =>
		expectedAppSlug ? c.app?.slug === expectedAppSlug : Boolean(c.app?.slug),
	);

	if (!sthripReviews.length && !sthripStatus && !sthripChecks.length) {
		throw new Error(
			"no Sthrip-specific review, check run, or commit status was observed on the PR head",
		);
	}
	if (!appReviews.length && !appStatus && !appChecks.length) {
		throw new Error(
			`no Sthrip-specific GitHub artifact was attributable to GitHub App ${expectedAppSlug || "(unknown slug)"}`,
		);
	}

	return {
		review_count: reviews.length,
		sthrip_review_count: sthripReviews.length,
		app_attributed_artifact_count:
			appReviews.length + (appStatus ? 1 : 0) + appChecks.length,
		latest_review_author: reviews.at(-1)?.user?.login ?? null,
		commit_status_state: status.state ?? null,
		sthrip_status_context: sthripStatus?.context ?? null,
		check_count: checks.total_count ?? 0,
		sthrip_check_count: sthripChecks.length,
	};
}

function isExpectedAppActor(
	login: string | null | undefined,
	expectedAppSlug: string,
): boolean {
	if (!login) return false;
	if (!expectedAppSlug) return /\[bot\]$/i.test(login);
	return (
		login === expectedAppSlug ||
		login.toLowerCase() === `${expectedAppSlug.toLowerCase()}[bot]`
	);
}

async function cleanupPullRequest(
	pat: string,
	pr: CreatedPr,
): Promise<boolean> {
	await githubPatFetch(
		pat,
		`/repos/${OWNER}/${REPO}/pulls/${pr.number}`,
		{ method: "PATCH", body: JSON.stringify({ state: "closed" }) },
		"PATCH close PR",
	).catch(() => null);
	await githubPatFetch(
		pat,
		`/repos/${OWNER}/${REPO}/git/refs/heads/${encodeURIComponent(pr.branch)}`,
		{ method: "DELETE" },
		"DELETE branch ref",
	).catch(() => null);

	const ref = await githubPatFetch(
		pat,
		`/repos/${OWNER}/${REPO}/git/ref/heads/${encodeURIComponent(pr.branch)}`,
		{},
		"GET deleted branch ref",
	).catch(() => null);
	return ref === null;
}

async function githubAppFetch<T>(
	appJwt: string,
	path: string,
	init: RequestInit,
	label: string,
): Promise<T> {
	return githubTokenFetch<T>(appJwt, path, init, label);
}

async function githubAppFetchText(
	appJwt: string,
	path: string,
	init: RequestInit,
	label: string,
): Promise<string> {
	return githubTokenFetchText(appJwt, path, init, label);
}

async function githubPatFetch<T = unknown>(
	pat: string,
	path: string,
	init: RequestInit,
	label: string,
): Promise<T> {
	if (!pat)
		throw new Error("GITHUB_TOKEN or GH_TOKEN is required for PR creation");
	return githubTokenFetch<T>(pat, path, init, label);
}

async function githubTokenFetch<T>(
	token: string,
	path: string,
	init: RequestInit,
	label: string,
): Promise<T> {
	const text = await githubTokenFetchText(token, path, init, label);
	if (!text) return undefined as T;
	return JSON.parse(text) as T;
}

async function githubTokenFetchText(
	token: string,
	path: string,
	init: RequestInit,
	label: string,
): Promise<string> {
	const res = await fetch(`${GITHUB_API}${path}`, {
		...init,
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"user-agent": "sthrip-github-app-smoke",
			"x-github-api-version": "2022-11-28",
			...(init.headers ?? {}),
		},
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`${label} failed (${res.status}): ${text.slice(0, 600)}`);
	}
	return text;
}

async function postBackend<T>(
	path: string,
	body: unknown,
	init: RequestInit,
	label: string,
): Promise<T> {
	return getJson<T>(
		`${BACKEND_BASE_URL}${path}`,
		{
			...init,
			method: "POST",
			headers: { "content-type": "application/json", ...(init.headers ?? {}) },
			body: JSON.stringify(body),
		},
		label,
	);
}

async function getJson<T>(
	url: string,
	init: RequestInit,
	label: string,
): Promise<T> {
	const res = await fetch(url, init);
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`${label} failed (${res.status}): ${text.slice(0, 600)}`);
	}
	if (!text) return undefined as T;
	return JSON.parse(text) as T;
}

async function poll<T>(
	label: string,
	fn: () => Promise<T | undefined>,
): Promise<T> {
	const started = Date.now();
	let lastError: unknown;
	while (Date.now() - started < TIMEOUT_MS) {
		try {
			const value = await fn();
			if (value !== undefined) return value;
		} catch (err) {
			lastError = err;
			if (!isRetryablePollError(err)) throw err;
		}
		await sleep(POLL_MS);
	}
	throw new Error(
		`${label} timed out after ${TIMEOUT_MS}ms${lastError ? `; last=${errorMessage(lastError)}` : ""}`,
	);
}

function isRetryablePollError(err: unknown): boolean {
	const msg = errorMessage(err);
	return /404|not found|not_found|repo_not_connected|no last_review/i.test(msg);
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function requiredEnvMissing(): string[] {
	const required = [
		"GITHUB_APP_ID",
		"GITHUB_APP_PRIVATE_KEY",
		"GITHUB_APP_WEBHOOK_SECRET",
		"GITHUB_TOKEN or GH_TOKEN",
		"TENSOL_PUBLIC_WEBHOOK_BASE_URL or TENSOL_WEBHOOK_BASE_URL",
	];
	return required.filter((name) => {
		if (name.includes(" or ")) {
			return name.split(" or ").every((part) => !env(part));
		}
		return !env(name);
	});
}

function env(name: string): string {
	return process.env[name]?.trim() ?? "";
}

function mustEnv(name: string): string {
	const value = env(name);
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function numberEnv(name: string, fallback: number): number {
	const raw = env(name);
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function printReport(report: SmokeReport): void {
	console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
	printReport({
		status: "blocked",
		repo: `${OWNER}/${REPO}`,
		blocker: errorMessage(err),
		verification: ["top-level failure"],
	});
	process.exit(1);
});
