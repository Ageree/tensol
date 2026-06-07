/**
 * 003-whitebox — `/v1/review/*` authenticated REST API.
 *
 * Public surface (mounted at `/v1/review` from server.ts):
 *
 *   POST   /                  → run a review on a supplied diff/files (SYNC).
 *                               Used by the `tensol-loop` CLI skill: the client
 *                               already has the diff, so no GitHub creds are
 *                               needed and the engine runs inline.
 *   GET    /:id               → review row + its findings (owner-scoped).
 *   GET    /                  → list the caller's reviews.
 *   GET    /repos             → list the caller's connected repos.
 *   POST   /whitebox          → enqueue a whole-repo whitebox scan (ASYNC, 202).
 *
 * Ownership (Constitution II): every read confirms `review.userId === caller`.
 * A foreign / unknown id → 404 (never 403; hides existence).
 *
 * Validation (Constitution IX): bodies are validated with the Zod schemas in
 * `review/schemas.ts` before any work.
 *
 * Audit (Constitution X): the service emits every signed audit row; the route
 * never writes the audit log directly.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { eq } from "drizzle-orm";
import type { AuthVariables } from "../auth/middleware.ts";
import type { DB } from "../db/client.ts";
import { reviews as reviewsTable } from "../db/schema.ts";
import type { Review } from "../db/schema.ts";
import { isResearchEnabled } from "../lib/feature-flags.ts";
import { createRateLimit, defaultKeyFn } from "../lib/rate-limit.ts";
import { splitUnifiedDiff } from "../review/candidates.ts";
import { runReview } from "../review/engine.ts";
import { fileToAddedDiff } from "../review/repo-fetch.ts";
import type { LlmClient } from "../review/reviewer.ts";
import {
	MAX_TOTAL_REVIEW_BYTES,
	type ReviewApiBody,
	ReviewApiBodySchema,
	WhiteboxLaunchBodySchema,
} from "../review/schemas.ts";
import type { ReviewService } from "../review/service.ts";
import type { DiffFile, ReviewFinding, ReviewResult } from "../review/types.ts";

export interface CreateReviewRouterDeps {
	readonly db: DB;
	readonly service: ReviewService;
	readonly requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>;
	/** Server-configured review LLM; null when no API key is set (→ 503). */
	readonly llm: LlmClient | null;
	readonly now?: () => number;
}

interface ErrorEnvelope {
	readonly error: string;
	readonly message: string;
}

const NOT_FOUND: ErrorEnvelope = {
	error: "not_found",
	message: "resource not found",
};
const FORBIDDEN: ErrorEnvelope = {
	error: "forbidden",
	message: "access denied",
};
const LLM_UNCONFIGURED: ErrorEnvelope = {
	error: "review_llm_unconfigured",
	message:
		"the review LLM is not configured on this server (set TENSOL_REVIEW_LLM_API_KEY)",
};
const DEFAULT_REVIEW_LIST_LIMIT = 100;
const MAX_REVIEW_LIST_LIMIT = 500;

function parseLimit(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_REVIEW_LIST_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_REVIEW_LIST_LIMIT;
	return Math.max(1, Math.min(MAX_REVIEW_LIST_LIMIT, parsed));
}

/**
 * Zod schema for `PATCH /repos/:id/settings` body (RepoSettingsUpdate from
 * openapi.yaml). covered_branches is bounded: ≤50 items, each ≤255 chars.
 */
const RepoSettingsUpdateSchema = z.object({
	enabled: z.boolean().optional(),
	covered_branches: z.array(z.string().max(255)).max(50).optional(),
	status_check_enabled: z.boolean().optional(),
	merge_block_on_critical: z.boolean().optional(),
});

type RepoSettingsUpdate = z.infer<typeof RepoSettingsUpdateSchema>;

/**
 * Map a ReviewRepo DB row + optional last Review row to the InstallationRepo
 * wire shape (snake_case, per openapi.yaml InstallationRepo schema).
 */
function repoToInstallationRepoWire(
	repo: {
		id: string;
		owner: string;
		name: string;
		defaultBranch: string;
		coveredBranchesJson: string;
		enabled: number;
		statusCheckEnabled: number;
		mergeBlockOnCritical: number;
		lastReviewId: string | null;
	},
	lastReview: Review | null,
) {
	let coveredBranches: string[] = [];
	try {
		const parsed = JSON.parse(repo.coveredBranchesJson);
		if (Array.isArray(parsed)) coveredBranches = parsed as string[];
	} catch {
		coveredBranches = [];
	}

	return {
		repo_id: repo.id,
		owner: repo.owner,
		name: repo.name,
		default_branch: repo.defaultBranch,
		enabled: repo.enabled === 1,
		covered_branches: coveredBranches,
		status_check_enabled: repo.statusCheckEnabled === 1,
		merge_block_on_critical: repo.mergeBlockOnCritical === 1,
		last_review:
			lastReview !== null
				? {
						review_id: lastReview.id,
						status: lastReview.status,
						score_0_5: lastReview.score0to5 ?? null,
						updated_at: lastReview.updatedAt,
					}
				: null,
	};
}

/** Split an "owner/name" slug. */
function splitRepo(slug: string): { owner: string; name: string } {
	const idx = slug.indexOf("/");
	return { owner: slug.slice(0, idx), name: slug.slice(idx + 1) };
}

/** Map an API body's files/diff into engine `DiffFile`s. */
function bodyToFiles(body: ReviewApiBody): DiffFile[] {
	if (body.files && body.files.length > 0) {
		return body.files.map((f): DiffFile => {
			// Prefer an explicit patch; else synthesize a full-add patch from
			// `contents` so the engine produces whole-file candidates.
			const patch =
				f.patch !== undefined
					? f.patch
					: f.contents !== undefined
						? fileToAddedDiff(f.contents)
						: undefined;
			return {
				path: f.path,
				status: f.status,
				...(patch !== undefined ? { patch } : {}),
				...(f.previous_path !== undefined
					? { previousPath: f.previous_path }
					: {}),
			};
		});
	}
	if (body.diff) return splitUnifiedDiff(body.diff);
	return [];
}

/**
 * Canonical domain `ReviewFinding` → wire (snake_case) mapper — the SINGLE
 * source of truth for the finding shape, so the sync POST / and GET /:id paths
 * cannot drift (e.g. one path dropping `side`). Row-only fields (`id`,
 * `lifecycle_state`) are appended by `findingRowToWire`.
 */
function findingToWire(f: ReviewFinding) {
	return {
		fingerprint: f.fingerprint,
		file_path: f.filePath,
		start_line: f.startLine ?? null,
		end_line: f.endLine ?? null,
		side: f.side,
		severity: f.severity,
		cwe: f.cwe,
		cvss_vector: f.cvssVector,
		cvss_score: f.cvssScore,
		confidence: f.confidence,
		reachable: f.reachable,
		category: f.category,
		title: f.title,
		rationale_md: f.rationaleMd,
		poc_md: f.pocMd ?? null,
		fix_prompt_md: f.fixPromptMd ?? null,
		source: f.source,
	};
}

/** Serialize a ReviewFinding DB row for the API (snake_case wire shape). */
export function findingRowToWire(row: {
	id: string;
	fingerprint: string;
	filePath: string;
	startLine: number | null;
	endLine: number | null;
	side: string;
	severity: string;
	cweJson: string;
	cvssVector: string | null;
	cvssScore: number | null;
	confidence: string | null;
	reachable: number | null;
	category: string | null;
	title: string;
	rationaleMd: string;
	pocMd: string | null;
	fixPromptMd: string | null;
	source: string;
	lifecycleState: string;
	exploitStatus: string;
	exploitabilityScore: number | null;
	impactScore: number | null;
	exploitIterations: number;
	verificationStatus: string;
	reachabilityEvidenceMd: string | null;
}) {
	let cwe: string[] = [];
	try {
		const parsed = JSON.parse(row.cweJson);
		if (Array.isArray(parsed)) cwe = parsed as string[];
	} catch {
		cwe = [];
	}
	// Normalize the DB row into the domain shape (parse cweJson, 0/1→bool), run
	// it through the canonical mapper, then append the row-only fields.
	const domain: ReviewFinding = {
		fingerprint: row.fingerprint,
		filePath: row.filePath,
		...(row.startLine !== null ? { startLine: row.startLine } : {}),
		...(row.endLine !== null ? { endLine: row.endLine } : {}),
		side: row.side as ReviewFinding["side"],
		severity: row.severity as ReviewFinding["severity"],
		cwe,
		cvssVector: row.cvssVector ?? "",
		cvssScore: row.cvssScore ?? 0,
		confidence: (row.confidence ?? "low") as ReviewFinding["confidence"],
		reachable: row.reachable === 1,
		category: row.category ?? "",
		title: row.title,
		rationaleMd: row.rationaleMd,
		...(row.pocMd !== null ? { pocMd: row.pocMd } : {}),
		...(row.fixPromptMd !== null ? { fixPromptMd: row.fixPromptMd } : {}),
		source: row.source as ReviewFinding["source"],
	};
	return {
		...findingToWire(domain),
		// Preserve the DB's exact persisted values for the nullable scoring/columns
		// (the row is authoritative; don't coerce a stored null into a default).
		cvss_vector: row.cvssVector,
		cvss_score: row.cvssScore,
		confidence: row.confidence,
		reachable: row.reachable === null ? null : row.reachable === 1,
		category: row.category,
		id: row.id,
		lifecycle_state: row.lifecycleState,
		// Verification gate (T026/T031) — already on the DB row; surface to the UI.
		verification_status: row.verificationStatus,
		reachability_evidence_md: row.reachabilityEvidenceMd,
		// Exploit Lab verdict (F2) — proven/failed status + 0-100 scores + the
		// iteration count. The proven PoC itself rides on `poc_md` above (the
		// exploit hook overwrites it on a proven verdict).
		exploit_status: row.exploitStatus,
		exploitability_score: row.exploitabilityScore,
		impact_score: row.impactScore,
		exploit_iterations: row.exploitIterations,
	};
}

/** ReviewResult → wire shape (for the sync POST / response). */
function resultToWire(reviewId: string, result: ReviewResult) {
	return {
		review_id: reviewId,
		kind: result.kind,
		// The sync path always finalizes the review to `completed` before
		// responding; `status` is REQUIRED by ReviewResultWire + api.md.
		status: "completed" as const,
		score_0_5: result.score0to5,
		summary_md: result.summaryMd,
		findings: result.findings.map(findingToWire),
	};
}

export function createReviewRouter(
	deps: CreateReviewRouterDeps,
): Hono<{ Variables: AuthVariables }> {
	const { service, requireAuth, llm } = deps;

	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("*", requireAuth);
	// Per-user rate limit AFTER auth (keyed by user id, IP fallback). The review
	// endpoints are expensive (LLM call + repo clone + SAST), so cap abuse — and
	// bound the cost of any pathological input that slips past the body caps.
	app.use(
		"*",
		createRateLimit({
			windowMs: 60_000,
			max: 30,
			keyFn: (c) => {
				const u = c.get("user") as { id?: string } | undefined;
				return u?.id ?? defaultKeyFn(c);
			},
			...(deps.now !== undefined ? { now: deps.now } : {}),
		}),
	);

	// -------------------------------------------------------------------------
	// POST / — synchronous review of a supplied diff/files.
	//
	// `bodyLimit` rejects an oversized body with 413 on Content-Length / streamed
	// size BEFORE `c.req.json()` buffers + parses it (per-field Zod caps run only
	// after the whole body is materialized, too late to prevent the allocation).
	// Headroom over MAX_TOTAL_REVIEW_BYTES covers the JSON envelope + path/sha
	// fields + base64/escape expansion.
	// -------------------------------------------------------------------------
	const reviewBodyLimit = bodyLimit({
		maxSize: MAX_TOTAL_REVIEW_BYTES + 256 * 1024,
		onError: (c) =>
			c.json(
				{
					error: "payload_too_large",
					message: "request body exceeds the size limit",
				},
				413,
			),
	});

	app.post("/", reviewBodyLimit, async (c) => {
		if (!llm) return c.json(LLM_UNCONFIGURED, 503);

		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(
				{ error: "invalid_json", message: "body must be JSON" },
				400,
			);
		}
		const parsed = ReviewApiBodySchema.safeParse(raw);
		if (!parsed.success) {
			return c.json(
				{
					error: "validation_failed",
					message: parsed.error.issues[0]?.message ?? "invalid body",
					issues: parsed.error.issues,
				},
				422,
			);
		}
		const body = parsed.data;
		const user = c.get("user");
		const { owner, name } = splitRepo(body.repo);

		const repo = await service.upsertRepo({ userId: user.id, owner, name });
		const review = await service.createReview({
			repoId: repo.id,
			userId: user.id,
			kind: "pr",
			...(body.pr !== undefined ? { prNumber: body.pr } : {}),
			...(body.head_sha !== undefined ? { headSha: body.head_sha } : {}),
			...(body.base_sha !== undefined ? { baseSha: body.base_sha } : {}),
		});

		try {
			await service.markReviewRunning(review.id);
			const files = bodyToFiles(body);
			const result = await runReview(
				{
					kind: "pr",
					files,
					...(repo.rulesMd ? { rulesMd: repo.rulesMd } : {}),
				},
				{ llm },
			);
			await service.finalizeReview(review.id, result);
			return c.json(resultToWire(review.id, result), 200);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Persist the detailed cause server-side (audit + reviews.error), but
			// return a generic message — raw upstream/LLM error text can leak provider
			// identifiers or internal detail to the client.
			await service.failReview(review.id, msg);
			return c.json(
				{
					error: "review_failed",
					message: "review engine failed",
					review_id: review.id,
				},
				500,
			);
		}
	});

	// -------------------------------------------------------------------------
	// GET /repos — list the caller's connected repos.
	// (Registered before /:id so "repos" is not captured as an id.)
	// -------------------------------------------------------------------------
	app.get("/repos", async (c) => {
		const user = c.get("user");
		const repos = await service.listReposByUser(user.id, {
			limit: parseLimit(c.req.query("limit")),
		});
		return c.json(
			repos.map((r) => ({
				id: r.id,
				scm: r.scm,
				owner: r.owner,
				name: r.name,
				full_name: `${r.owner}/${r.name}`,
				default_branch: r.defaultBranch,
				status: r.status,
				created_at: r.createdAt,
			})),
			200,
		);
	});

	// -------------------------------------------------------------------------
	// GET / — list the caller's reviews.
	//
	// Emits a distinct list shape (`ReviewListItemWire`): `review_id` (NOT `id`)
	// and a real `findings_count` (counted, not the full `findings` array) so the
	// client's Reviews table can read `r.review_id` + `r.findings_count` without
	// a crash. NEVER includes a `findings` array (that's the detail endpoint).
	// -------------------------------------------------------------------------
	app.get("/", async (c) => {
		const user = c.get("user");
		const rawKind = c.req.query("kind");
		const kind =
			rawKind === undefined || rawKind === ""
				? undefined
				: rawKind === "pr" || rawKind === "whitebox"
					? rawKind
					: null;
		if (kind === null) {
			return c.json(
				{ error: "validation_failed", message: "kind must be pr or whitebox" },
				400,
			);
		}
		const reviews = await service.listReviewsByUser(user.id, {
			limit: parseLimit(c.req.query("limit")),
			...(kind !== undefined ? { kind } : {}),
		});
		const counts = await service.countFindingsByReviewIds(
			reviews.map((r) => r.id),
		);
		const repos = await service.listReposByUser(user.id, {
			limit: MAX_REVIEW_LIST_LIMIT,
		});
		const repoSlug = new Map(repos.map((r) => [r.id, `${r.owner}/${r.name}`]));
		return c.json(
			reviews.map((r) => ({
				review_id: r.id,
				kind: r.kind,
				mode: r.mode,
				status: r.status,
				score_0_5: r.score0to5,
				pr_number: r.prNumber,
				repo: r.repoId ? (repoSlug.get(r.repoId) ?? null) : null,
				created_at: r.createdAt,
				completed_at: r.completedAt,
				findings_count: counts[r.id] ?? 0,
			})),
			200,
		);
	});

	// -------------------------------------------------------------------------
	// GET /:id — review + findings (owner-scoped).
	// -------------------------------------------------------------------------
	app.get("/:id", async (c) => {
		const user = c.get("user");
		const review = await service.getReview(c.req.param("id"));
		if (!review || review.userId !== user.id) return c.json(NOT_FOUND, 404);
		const findings = await service.getReviewFindings(review.id);
		return c.json(
			{
				id: review.id,
				repo_id: review.repoId,
				kind: review.kind,
				mode: review.mode,
				pr_number: review.prNumber,
				head_sha: review.headSha,
				status: review.status,
				score_0_5: review.score0to5,
				summary_md: review.summaryMd,
				findings_count: review.findingsCount,
				error: review.error,
				created_at: review.createdAt,
				completed_at: review.completedAt,
				findings: findings.map(findingRowToWire),
			},
			200,
		);
	});

	// -------------------------------------------------------------------------
	// POST /whitebox — enqueue a whole-repo whitebox scan (async).
	// -------------------------------------------------------------------------
	app.post("/whitebox", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(
				{ error: "invalid_json", message: "body must be JSON" },
				400,
			);
		}
		const parsed = WhiteboxLaunchBodySchema.safeParse(raw);
		if (!parsed.success) {
			return c.json(
				{
					error: "validation_failed",
					message: parsed.error.issues[0]?.message ?? "invalid body",
					issues: parsed.error.issues,
				},
				422,
			);
		}
		const body = parsed.data;
		const user = c.get("user");

		// Resolve the repo: an existing connected repo id, or create from a slug.
		let repoId: string;
		if (body.repo_id) {
			const repo = await service.getRepo(body.repo_id);
			if (!repo || repo.userId !== user.id) return c.json(NOT_FOUND, 404);
			repoId = repo.id;
		} else if (body.repo) {
			const { owner, name } = splitRepo(body.repo);
			const repo = await service.upsertRepo({ userId: user.id, owner, name });
			repoId = repo.id;
		} else {
			return c.json(
				{ error: "validation_failed", message: "repo_id or repo is required" },
				422,
			);
		}

		// Deep research (F1) is a gated capability: only honor `mode: "deep"` when
		// the server has it enabled. The dashboard hides the toggle when the
		// feature flag is off, but the route must still enforce it (defense in
		// depth — a crafted request can't smuggle a deep scan onto a server that
		// disabled it / didn't budget for it).
		if (body.mode === "deep" && !isResearchEnabled()) {
			return c.json(
				{
					error: "feature_disabled",
					message: "deep research is not enabled on this server",
				},
				422,
			);
		}
		const mode = body.mode ?? "fast";

		// Atomic: the queued review + its pending whitebox_scan job commit together.
		const { review, jobId } = await service.createQueuedReviewWithJob(
			{
				repoId,
				userId: user.id,
				kind: "whitebox",
				mode,
				...(body.ref !== undefined ? { commitRef: body.ref } : {}),
			},
			"whitebox_scan",
		);

		return c.json(
			{ review_id: review.id, job_id: jobId, status: "queued" },
			202,
		);
	});

	// -------------------------------------------------------------------------
	// PATCH /repos/:id/settings — update per-repo review coverage and settings.
	//
	// Owner-scoped: if the repo does not exist OR belongs to a different user,
	// the service returns null and we respond with 403 (per openapi.yaml — this
	// endpoint hides existence with 403, not 404, to distinguish from not-found
	// review resources which use 404). Zod-validates the body, then delegates
	// the update to service.updateRepoSettings. Audit events are emitted by the
	// service (Constitution X). Maps the updated row to the InstallationRepo
	// wire shape.
	// -------------------------------------------------------------------------
	app.patch("/repos/:id/settings", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(
				{ error: "invalid_json", message: "body must be JSON" },
				400,
			);
		}

		const parsed = RepoSettingsUpdateSchema.safeParse(raw);
		if (!parsed.success) {
			return c.json(
				{
					error: "validation_failed",
					message: parsed.error.issues[0]?.message ?? "invalid body",
					issues: parsed.error.issues,
				},
				400,
			);
		}

		const body: RepoSettingsUpdate = parsed.data;
		const user = c.get("user");
		const repoId = c.req.param("id");

		const updatedRepo = await service.updateRepoSettings({
			repoId,
			userId: user.id,
			...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
			...(body.covered_branches !== undefined
				? { coveredBranches: body.covered_branches }
				: {}),
			...(body.status_check_enabled !== undefined
				? { statusCheckEnabled: body.status_check_enabled }
				: {}),
			...(body.merge_block_on_critical !== undefined
				? { mergeBlockOnCritical: body.merge_block_on_critical }
				: {}),
		});

		// service.updateRepoSettings returns null when the repo is absent or owned
		// by a different user — both cases surface as 403 per openapi.yaml.
		if (updatedRepo === null) return c.json(FORBIDDEN, 403);

		// Fetch the last review row (if any) to populate last_review in the response.
		let lastReview: Review | null = null;
		if (updatedRepo.lastReviewId !== null) {
			lastReview =
				(deps.db
					.select()
					.from(reviewsTable)
					.where(eq(reviewsTable.id, updatedRepo.lastReviewId))
					.get() as Review | undefined) ?? null;
		}

		return c.json(repoToInstallationRepoWire(updatedRepo, lastReview), 200);
	});

	return app;
}
