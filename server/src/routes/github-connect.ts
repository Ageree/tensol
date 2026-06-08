/**
 * T014 — GitHub App connect HTTP router.
 *
 * Factory: `createGithubConnectRouter(deps)` → Hono router.
 * Mounted at `/v1/github` in server.ts.
 *
 * Endpoints (per contracts/openapi.yaml):
 *   GET  /connect                     → 200 { install_url, state } | 503 (slug absent)
 *   GET  /callback                    → 302 /repositories | 400 bad state
 *   GET  /installations               → { connected, installations[] }
 *   GET  /installations/:id/repos     → InstallationRepo[] | 404 not owned
 *   POST /disconnect                  → 200 | 403 not owned
 *
 * Constitution compliance:
 *   - No console.log.
 *   - Zod-validate every HTTP body/query.
 *   - Ownership: installation lookups assert userId matches caller.
 *   - Foreign id → 404 (never 403) for owner-scoped reads (per contract).
 *   - Audits emitted in the service (not here).
 *   - Graceful-null when slug absent (503 on /connect); all other routes
 *     still work (they don't need the slug).
 *   - exactOptionalPropertyTypes: optional props omitted, never set to undefined.
 *   - Wire shape: snake_case matching openapi.yaml exactly.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

import { eq } from "drizzle-orm";
import type { AuthVariables } from "../auth/middleware.ts";
import type { DB } from "../db/client.ts";
import type { ReviewRepo } from "../db/schema.ts";
import { reviews as reviewsTable } from "../db/schema.ts";
import type { Review } from "../db/schema.ts";
import type { GitHubClient } from "../review/github/client.ts";
import {
	buildConnectState,
	buildInstallUrl,
	handleInstallCallback,
	verifyConnectState,
} from "../review/github/connect.ts";
import type { ReviewService } from "../review/service.ts";

const FRONTEND_BASE_URL = "https://sthrip.dev";

// ── Deps ─────────────────────────────────────────────────────────────────────

export interface CreateGithubConnectRouterDeps {
	readonly db: DB;
	readonly service: ReviewService;
	readonly github: GitHubClient;
	readonly requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>;
	/** GitHub App slug (`GITHUB_APP_SLUG`). Empty string → /connect returns 503. */
	readonly slug: string;
	/** HMAC secret for CSRF state nonces (TENSOL_SESSION_COOKIE_SECRET or dedicated). */
	readonly stateSecret: string;
	/** Public SPA origin used after external GitHub browser redirects. */
	readonly frontendBaseUrl?: string;
	readonly now?: () => number;
}

// ── Error envelopes ──────────────────────────────────────────────────────────

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

const GITHUB_UNCONFIGURED: ErrorEnvelope = {
	error: "github_app_unconfigured",
	message:
		"the GitHub App is not configured on this server (set GITHUB_APP_SLUG)",
};
const DEFAULT_INSTALLATION_REPOS_LIMIT = 200;
const MAX_INSTALLATION_REPOS_LIMIT = 500;

function parseLimit(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_INSTALLATION_REPOS_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_INSTALLATION_REPOS_LIMIT;
	return Math.max(1, Math.min(MAX_INSTALLATION_REPOS_LIMIT, parsed));
}

// ── Zod schemas ──────────────────────────────────────────────────────────────

const CallbackQuerySchema = z.object({
	installation_id: z.string().min(1),
	setup_action: z.string().min(1),
	state: z.string().min(1),
	// OAuth `code` from the combined install+authorize redirect. Required: it is
	// the only way to prove the authenticated user actually controls the claimed
	// installation_id (the App JWT alone can read ANY installation's repos).
	code: z.string().min(1),
});

const DisconnectBodySchema = z.object({
	installation_id: z.string().min(1),
});

// ── Wire mappers ─────────────────────────────────────────────────────────────

/**
 * Map a ReviewRepo DB row + optional last Review row to the InstallationRepo
 * wire shape (snake_case, per openapi.yaml InstallationRepo schema).
 */
function repoToInstallationRepoWire(
	repo: ReviewRepo,
	lastReview: Review | null,
): Record<string, unknown> {
	let coveredBranches: string[] = [];
	try {
		const parsed = JSON.parse(repo.coveredBranchesJson);
		if (Array.isArray(parsed)) coveredBranches = parsed as string[];
	} catch {
		coveredBranches = [];
	}

	const base: Record<string, unknown> = {
		repo_id: repo.id,
		owner: repo.owner,
		name: repo.name,
		default_branch: repo.defaultBranch,
		enabled: repo.enabled === 1,
		covered_branches: coveredBranches,
		status_check_enabled: repo.statusCheckEnabled === 1,
		merge_block_on_critical: repo.mergeBlockOnCritical === 1,
		last_review: null,
	};

	if (lastReview !== null) {
		base.last_review = {
			review_id: lastReview.id,
			status: lastReview.status,
			score_0_5: lastReview.score0to5 ?? null,
			updated_at: lastReview.updatedAt,
		};
	}

	return base;
}

/**
 * Build the InstallationRepo wire entry for a GitHub repo that has no
 * corresponding review_repos row yet (fresh/untracked repo from the GitHub list).
 */
function githubRepoToInstallationRepoWire(repo: {
	owner: string;
	name: string;
	defaultBranch: string;
}): Record<string, unknown> {
	return {
		repo_id: null,
		owner: repo.owner,
		name: repo.name,
		default_branch: repo.defaultBranch,
		enabled: false,
		covered_branches: [],
		status_check_enabled: false,
		merge_block_on_critical: false,
		last_review: null,
	};
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createGithubConnectRouter(
	deps: CreateGithubConnectRouterDeps,
): Hono<{ Variables: AuthVariables }> {
	const { db, service, github, requireAuth, slug, stateSecret } = deps;
	const clock = deps.now ?? (() => Date.now());
	const repositoriesUrl = new URL(
		"/repositories",
		deps.frontendBaseUrl ?? FRONTEND_BASE_URL,
	).toString();

	const app = new Hono<{ Variables: AuthVariables }>();

	// ---------------------------------------------------------------------------
	// GET /connect — begin GitHub connection
	//
	// Graceful-null: when GITHUB_APP_SLUG is absent, return 503 so the frontend
	// can show a "GitHub not configured" state. Never halts dev boot.
	// ---------------------------------------------------------------------------
	app.get("/connect", requireAuth, (c) => {
		if (!slug) return c.json(GITHUB_UNCONFIGURED, 503);

		const user = c.get("user");
		const state = buildConnectState({
			userId: user.id,
			now: clock(),
			secret: stateSecret,
		});
		const install_url = buildInstallUrl({ slug, state });

		return c.json({ install_url, state }, 200);
	});

	// ---------------------------------------------------------------------------
	// GET /callback — GitHub App installation callback
	//
	// Validates the CSRF state, persists the installation row, reconciles repos,
	// then 302-redirects to the SPA /repositories page. Returns 400 on any
	// state error.
	// ---------------------------------------------------------------------------
	app.get("/callback", async (c) => {
		const raw = {
			installation_id: c.req.query("installation_id"),
			setup_action: c.req.query("setup_action"),
			code: c.req.query("code"),
			state: c.req.query("state"),
		};

		const parsed = CallbackQuerySchema.safeParse(raw);
		if (!parsed.success) {
			return c.json(
				{
					error: "validation_failed",
					message:
						parsed.error.issues[0]?.message ?? "missing required query params",
				},
				400,
			);
		}

		const { installation_id, setup_action, state, code } = parsed.data;

		// Verify the CSRF state nonce. GitHub returns to this endpoint through a
		// top-level browser redirect, so the app session cookie / Clerk bearer token
		// may be absent. The signed state is the callback's user binding.
		const verified = verifyConnectState({
			state,
			secret: stateSecret,
			now: clock(),
		});
		if (!verified) {
			return c.json(
				{
					error: "invalid_state",
					message: "state is missing, forged, or expired",
				},
				400,
			);
		}
		const userId = verified.userId;

		// Prove the authenticated user actually controls this GitHub installation.
		// The App JWT can read ANY installation's private repos, so without this
		// check an authenticated attacker could claim a victim's (sequential,
		// guessable) installation_id and bind it to their own account — a
		// cross-tenant installation takeover + private-repo leak. We exchange the
		// OAuth `code` for a USER token and confirm installation_id is in the
		// user's own installation list (spec.md:128, data-model.md:103).
		let userInstallationIds: string[];
		try {
			userInstallationIds = await github.listUserInstallationIds({ code });
		} catch {
			return c.json(
				{
					error: "github_oauth_failed",
					message: "could not verify installation ownership with GitHub",
				},
				400,
			);
		}
		if (!userInstallationIds.includes(installation_id)) {
			return c.json(
				{ error: "forbidden", message: "you do not control this installation" },
				403,
			);
		}

		await handleInstallCallback({
			installationId: installation_id,
			setupAction: setup_action,
			userId,
			github,
			service,
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});

		return c.redirect(repositoriesUrl, 302);
	});

	// ---------------------------------------------------------------------------
	// GET /installations — connection status + installations for current user
	// ---------------------------------------------------------------------------
	app.get("/installations", requireAuth, async (c) => {
		const user = c.get("user");
		const all = await service.getInstallationsForUser(user.id);
		// Only active/suspended rows count as "connected" — deleted are hidden from
		// the connected concept (per openapi.yaml semantics: uninstall flips status).
		const visible = all.filter((i) => i.status !== "deleted");

		const connected = visible.some(
			(i) => i.status === "active" || i.status === "suspended",
		);

		const installations = visible.map((i) => ({
			id: i.id,
			installation_id: i.installationId,
			account_login: i.accountLogin,
			account_type: i.accountType,
			repository_selection: i.repositorySelection,
			status: i.status,
		}));

		return c.json({ connected, installations }, 200);
	});

	// ---------------------------------------------------------------------------
	// GET /installations/:id/repos — repos for an installation (with coverage state)
	//
	// Ownership: if the installation's userId !== caller → 404 (hides existence).
	// Response merges GitHub's live repo list with local review_repos state.
	// ---------------------------------------------------------------------------
	app.get("/installations/:id/repos", requireAuth, async (c) => {
		const user = c.get("user");
		const installationRowId = c.req.param("id");
		const limit = parseLimit(c.req.query("limit"));

		// Resolve the installation row.
		const installation =
			await service.getInstallationByRowId(installationRowId);
		if (!installation || installation.userId !== user.id) {
			return c.json(NOT_FOUND, 404);
		}

		// Fetch GitHub's current repo list for this installation (live, no cache).
		let githubRepos: Array<{
			owner: string;
			name: string;
			defaultBranch: string;
		}> = [];
		try {
			const raw = await github.listInstallationRepos({
				installationId: installation.installationId,
			});
			githubRepos = raw.slice(0, limit).map((r) => ({
				owner: r.owner,
				name: r.name,
				defaultBranch: r.defaultBranch,
			}));
		} catch {
			// GitHub unreachable — degrade gracefully: return the locally tracked repos.
			githubRepos = [];
		}

		// Load locally tracked review_repos linked to this installation row.
		const localRepos = await service.listReposByUser(user.id, {
			limit: MAX_INSTALLATION_REPOS_LIMIT,
		});
		const localBySlug = new Map<string, ReviewRepo>();
		for (const r of localRepos) {
			if (r.installationRowId === installationRowId) {
				localBySlug.set(`${r.owner}/${r.name}`, r);
			}
		}

		// Merge: use GitHub repos as the canonical list; overlay local state.
		const result: Record<string, unknown>[] = [];

		if (githubRepos.length > 0) {
			for (const ghRepo of githubRepos) {
				const slug = `${ghRepo.owner}/${ghRepo.name}`;
				const local = localBySlug.get(slug) ?? null;

				if (local) {
					// Fetch last review if tracked.
					let lastReview: Review | null = null;
					if (local.lastReviewId !== null) {
						lastReview =
							(db
								.select()
								.from(reviewsTable)
								.where(eq(reviewsTable.id, local.lastReviewId))
								.get() as Review | undefined) ?? null;
					}
					result.push(repoToInstallationRepoWire(local, lastReview));
				} else {
					result.push(githubRepoToInstallationRepoWire(ghRepo));
				}
			}
		} else {
			// GitHub list unavailable — serve locally tracked repos for this installation.
			for (const [, local] of Array.from(localBySlug).slice(0, limit)) {
				let lastReview: Review | null = null;
				if (local.lastReviewId !== null) {
					lastReview =
						(db
							.select()
							.from(reviewsTable)
							.where(eq(reviewsTable.id, local.lastReviewId))
							.get() as Review | undefined) ?? null;
				}
				result.push(repoToInstallationRepoWire(local, lastReview));
			}
		}

		return c.json(result, 200);
	});

	// ---------------------------------------------------------------------------
	// POST /disconnect — mark installation deleted locally
	//
	// Owner-scoped: if the installation_id is unknown or belongs to another user,
	// return 403 (per openapi.yaml — disconnect uses 403, not 404, to align with
	// uninstall semantics where existence is visible on GitHub anyway).
	// ---------------------------------------------------------------------------
	app.post("/disconnect", requireAuth, async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(
				{ error: "invalid_json", message: "body must be JSON" },
				400,
			);
		}

		const parsed = DisconnectBodySchema.safeParse(raw);
		if (!parsed.success) {
			return c.json(
				{
					error: "validation_failed",
					message:
						parsed.error.issues[0]?.message ?? "installation_id is required",
				},
				400,
			);
		}

		const { installation_id } = parsed.data;
		const user = c.get("user");

		// Verify ownership before deleting. The UI stores the local installation row
		// id for repo listing, while older clients send GitHub's installation id.
		const byGithubId = await service.getInstallationByGithubId(
			"github",
			installation_id,
		);
		const installation =
			byGithubId ?? (await service.getInstallationByRowId(installation_id));
		if (!installation || installation.userId !== user.id) {
			return c.json(FORBIDDEN, 403);
		}

		await service.markInstallationDeleted(installation.installationId);
		return c.json({ ok: true }, 200);
	});

	return app;
}
