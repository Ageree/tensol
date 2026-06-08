/**
 * T010 — Contract tests for the GitHub connect router.
 *
 * Tests are TDD-first (failing before the router is implemented):
 *   GET /v1/github/connect       → 200 { install_url, state }; 401 unauth
 *   GET /v1/github/callback      → 302 frontend /repositories on valid state; 400 bad state
 *   GET /v1/github/installations → { connected, installations[] }
 *   GET /v1/github/installations/{id}/repos → InstallationRepo[]; 404 not-owned
 *   POST /v1/github/disconnect   → 200; 403 not-owned
 *
 * Uses a real in-memory SQLite with all migrations applied, the real
 * createReviewService, FakeGitHubClient, and a fakeAuth middleware.
 * The state secret is injected; verifyConnectState is tested via the
 * GET /callback round-trip (build → verify).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";

import type { AuthVariables } from "../auth/middleware.ts";
import { type DB, createDb } from "../db/client.ts";
import { FakeGitHubClient } from "../review/github/client.ts";
import {
	buildConnectState,
	verifyConnectState,
} from "../review/github/connect.ts";
import { createReviewService } from "../review/service.ts";
import { createGithubConnectRouter } from "./github-connect.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const AUDIT_KEY = "test-key-github-connect-0123456789abcdef0123456789abcdef";
const STATE_SECRET = "state-secret-0123456789abcdef0123456789abcdef";
const GITHUB_SLUG = "sthrip-app";
const GITHUB_CLIENT_ID = "Iv1.client";
const CALLBACK_URL = "https://api.sthrip.dev/v1/github/callback";
/** OAuth `code` the happy-path callbacks pass; the default Fake maps it to the
 *  installation ids the user is allowed to claim. */
const OWNED_CODE = "oauth-code-user-1";

// ── DB helpers ───────────────────────────────────────────────────────────────

function migrationSql(): string {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()
		.map((f) =>
			readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
				/-->\s*statement-breakpoint/g,
				"",
			),
		)
		.join("\n");
}

let clockNow = 1_700_000_000_000;
const clock = () => clockNow++;

function freshMemDb(userId = "user_1"): DB {
	const db = createDb(":memory:");
	(db.$client as Database).exec(migrationSql());
	(db.$client as Database)
		.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
		.run(userId, `${userId}@x.io`, clockNow);
	return db;
}

// ── Fake auth middleware ─────────────────────────────────────────────────────

function makeFakeAuth(
	userId: string,
): MiddlewareHandler<{ Variables: AuthVariables }> {
	return async (c, next) => {
		c.set("user", { id: userId, email: `${userId}@x.io` });
		c.set("session", {
			id: "session_1",
			user_id: userId,
			expires_at: 9_999_999_999_999,
		});
		await next();
	};
}

/** Auth middleware that always returns 401 (unauthenticated). */
const unauthMiddleware: MiddlewareHandler<{
	Variables: AuthVariables;
}> = async (c) => {
	return c.json({ error: "unauthenticated" }, 401);
};

// ── Router factory ───────────────────────────────────────────────────────────

function makeConnectApp(
	db: DB,
	opts: {
		userId?: string;
		github?: FakeGitHubClient;
		authed?: boolean;
		slug?: string;
		oauthClientId?: string;
		callbackUrl?: string;
	} = {},
) {
	const userId = opts.userId ?? "user_1";
	const github =
		opts.github ??
		new FakeGitHubClient({
			installationRepos: [
				{ owner: "acme", name: "web", defaultBranch: "main" },
				{ owner: "acme", name: "api", defaultBranch: "main" },
			],
			installationMetadata: {
				accountLogin: "acme",
				accountType: "Organization",
				repositorySelection: "all",
			},
			// The OAuth `code` the happy-path callbacks pass maps to the installation
			// ids the user is allowed to claim (ownership proof for the takeover fix).
			userInstallationIds: { [OWNED_CODE]: ["inst_42", "inst_99"] },
		});
	const service = createReviewService({ db, auditKey: AUDIT_KEY, now: clock });
	const requireAuth =
		opts.authed === false ? unauthMiddleware : makeFakeAuth(userId);
	const router = createGithubConnectRouter({
		db,
		service,
		github,
		requireAuth,
		slug: opts.slug ?? GITHUB_SLUG,
		oauthClientId: opts.oauthClientId ?? GITHUB_CLIENT_ID,
		callbackUrl: opts.callbackUrl ?? CALLBACK_URL,
		stateSecret: STATE_SECRET,
		now: clock,
	});
	return { router, service, github };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /connect — begin GitHub connection", () => {
	test("returns 200 with install_url and state for authenticated user", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const res = await router.request("/connect");
		expect(res.status).toBe(200);

		const body = (await res.json()) as { install_url: string; state: string };
		expect(typeof body.install_url).toBe("string");
		expect(body.install_url).toContain(
			"github.com/apps/sthrip-app/installations/new",
		);
		expect(body.install_url).toContain("state=");
		expect(typeof body.state).toBe("string");
		expect(body.state.length).toBeGreaterThan(10);
	});

	test("returns 401 when not authenticated", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db, { authed: false });

		const res = await router.request("/connect");
		expect(res.status).toBe(401);
	});

	test("state verifies for the authenticated user", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const res = await router.request("/connect");
		const body = (await res.json()) as { state: string };

		const { verifyConnectState } = await import("../review/github/connect.ts");
		const verified = verifyConnectState({
			state: body.state,
			secret: STATE_SECRET,
			now: clockNow,
		});
		expect(verified).not.toBeNull();
		expect(verified?.userId).toBe("user_1");
	});

	test("state is URL-safe (included in install_url query param)", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const res = await router.request("/connect");
		const body = (await res.json()) as { install_url: string; state: string };

		// The state appears in the URL without needing extra encoding.
		const url = new URL(body.install_url);
		expect(url.searchParams.get("state")).toBe(body.state);
	});
});

describe("GET /callback — installation callback", () => {
	test("validates state, persists installation, reconciles repos, 302 to /repositories", async () => {
		const db = freshMemDb();
		const { router, service, github } = makeConnectApp(db);

		const state = buildConnectState({
			userId: "user_1",
			now: clockNow,
			secret: STATE_SECRET,
		});

		const res = await router.request(
			`/callback?installation_id=inst_42&setup_action=install&code=${OWNED_CODE}&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(302);

		const location = res.headers.get("location");
		expect(location).toBe("https://sthrip.dev/repositories");

		// Installation row should be persisted.
		const installation = await service.getInstallationByGithubId(
			"github",
			"inst_42",
		);
		expect(installation).not.toBeNull();
		expect(installation?.accountLogin).toBe("acme");
		expect(installation?.userId).toBe("user_1");
		expect(installation?.setupAction).toBe("install");
		expect(github.listUserInstallationIdsCalls).toEqual([
			{ code: OWNED_CODE, redirectUri: CALLBACK_URL },
		]);
	});

	test("valid callback does not require the browser to carry an app session", async () => {
		const db = freshMemDb();
		const { router, service } = makeConnectApp(db, { authed: false });

		const state = buildConnectState({
			userId: "user_1",
			now: clockNow,
			secret: STATE_SECRET,
		});

		const res = await router.request(
			`/callback?installation_id=inst_42&setup_action=install&code=${OWNED_CODE}&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("https://sthrip.dev/repositories");

		const installation = await service.getInstallationByGithubId(
			"github",
			"inst_42",
		);
		expect(installation?.userId).toBe("user_1");
	});

	test("invalid callback state stays rejected without an app session", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db, { authed: false });

		const res = await router.request(
			`/callback?installation_id=inst_42&setup_action=install&code=${OWNED_CODE}&state=totally-invalid-state`,
		);
		expect(res.status).toBe(400);

		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid_state");
	});

	test("returns 400 when state is missing", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const res = await router.request(
			`/callback?installation_id=inst_42&setup_action=install&code=${OWNED_CODE}`,
		);
		expect(res.status).toBe(400);

		const body = (await res.json()) as { error: string };
		expect(body.error).toBeTruthy();
	});

	test("redirects setup callback without OAuth code to GitHub user authorization", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const state = buildConnectState({
			userId: "user_1",
			now: clockNow,
			secret: STATE_SECRET,
		});
		const res = await router.request(
			`/callback?installation_id=inst_42&setup_action=install&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(302);

		const location = res.headers.get("location");
		expect(location).not.toBeNull();
		const url = new URL(location ?? "");
		expect(url.origin + url.pathname).toBe(
			"https://github.com/login/oauth/authorize",
		);
		expect(url.searchParams.get("client_id")).toBe(GITHUB_CLIENT_ID);
		expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);

		const oauthState = url.searchParams.get("state");
		expect(oauthState).not.toBeNull();
		const verified = verifyConnectState({
			state: oauthState ?? "",
			secret: STATE_SECRET,
			now: clockNow,
		});
		expect(verified).toMatchObject({
			userId: "user_1",
			installationId: "inst_42",
			setupAction: "install",
		});
	});

	test("OAuth callback can complete using installation context from signed state", async () => {
		const db = freshMemDb();
		const { router, service, github } = makeConnectApp(db);

		const state = buildConnectState({
			userId: "user_1",
			installationId: "inst_42",
			setupAction: "install",
			now: clockNow,
			secret: STATE_SECRET,
		});

		const res = await router.request(
			`/callback?code=${OWNED_CODE}&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("https://sthrip.dev/repositories");

		const installation = await service.getInstallationByGithubId(
			"github",
			"inst_42",
		);
		expect(installation?.userId).toBe("user_1");
		expect(installation?.setupAction).toBe("install");
		expect(github.listUserInstallationIdsCalls).toEqual([
			{ code: OWNED_CODE, redirectUri: CALLBACK_URL },
		]);
	});

	test("returns 503 when setup callback needs OAuth but client id is missing", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db, { oauthClientId: "" });

		const state = buildConnectState({
			userId: "user_1",
			now: clockNow,
			secret: STATE_SECRET,
		});
		const res = await router.request(
			`/callback?installation_id=inst_42&setup_action=install&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(503);

		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("github_oauth_unconfigured");
	});

	test("returns 400 on forged/invalid state", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const res = await router.request(
			`/callback?installation_id=inst_42&setup_action=install&code=${OWNED_CODE}&state=totally-invalid-state`,
		);
		expect(res.status).toBe(400);
	});

	test("uses the signed state user even if a stale browser session is present", async () => {
		const db = freshMemDb("user_1");
		(db.$client as Database)
			.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
			.run("user_2", "user_2@x.io", clockNow);

		const state = buildConnectState({
			userId: "user_2",
			now: clockNow,
			secret: STATE_SECRET,
		});

		const { router, service } = makeConnectApp(db, { userId: "user_1" });
		const res = await router.request(
			`/callback?installation_id=inst_42&setup_action=install&code=${OWNED_CODE}&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(302);

		const installation = await service.getInstallationByGithubId(
			"github",
			"inst_42",
		);
		expect(installation?.userId).toBe("user_2");
	});

	test("verified OAuth callback rebinds a stale local installation row", async () => {
		const db = freshMemDb("user_1");
		(db.$client as Database)
			.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
			.run("user_2", "user_2@x.io", clockNow);

		const { router, service } = makeConnectApp(db, { userId: "user_1" });
		await service.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_42",
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "all",
		});

		const state = buildConnectState({
			userId: "user_2",
			now: clockNow,
			secret: STATE_SECRET,
		});
		const res = await router.request(
			`/callback?installation_id=inst_42&setup_action=update&code=${OWNED_CODE}&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(302);

		expect(await service.getInstallationsForUser("user_1")).toHaveLength(0);
		const rebound = await service.getInstallationsForUser("user_2");
		expect(rebound).toHaveLength(1);
		expect(rebound[0]?.installationId).toBe("inst_42");
		expect(rebound[0]?.setupAction).toBe("update");
	});

	test("returns 403 when OAuth user cannot access claimed installation", async () => {
		const db = freshMemDb();
		const github = new FakeGitHubClient({
			installationMetadata: {
				accountLogin: "victim-org",
				accountType: "Organization",
				repositorySelection: "all",
			},
			userInstallationIds: { [OWNED_CODE]: ["inst_owned_elsewhere"] },
		});
		const { router, service } = makeConnectApp(db, { github });

		const state = buildConnectState({
			userId: "user_1",
			now: clockNow,
			secret: STATE_SECRET,
		});
		const res = await router.request(
			`/callback?installation_id=inst_victim&setup_action=install&code=${OWNED_CODE}&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(403);

		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("forbidden");
		expect(
			await service.getInstallationByGithubId("github", "inst_victim"),
		).toBeNull();
		expect(github.getInstallationMetadataCalls).toHaveLength(0);
	});

	test("returns 400 when installation_id is missing", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const state = buildConnectState({
			userId: "user_1",
			now: clockNow,
			secret: STATE_SECRET,
		});
		const res = await router.request(
			`/callback?setup_action=install&code=${OWNED_CODE}&state=${encodeURIComponent(state)}`,
		);
		expect(res.status).toBe(400);
	});

	test("callback is idempotent — second call updates, does not duplicate", async () => {
		const db = freshMemDb();
		const { router, service } = makeConnectApp(db);

		const state = buildConnectState({
			userId: "user_1",
			now: clockNow,
			secret: STATE_SECRET,
		});
		const qs = `?installation_id=inst_99&setup_action=install&code=${OWNED_CODE}&state=${encodeURIComponent(state)}`;

		await router.request(`/callback${qs}`);

		const state2 = buildConnectState({
			userId: "user_1",
			now: clockNow,
			secret: STATE_SECRET,
		});
		const qs2 = `?installation_id=inst_99&setup_action=update&code=${OWNED_CODE}&state=${encodeURIComponent(state2)}`;
		const res2 = await router.request(`/callback${qs2}`);
		expect(res2.status).toBe(302);

		const installations = await service.getInstallationsForUser("user_1");
		expect(
			installations.filter((i) => i.installationId === "inst_99").length,
		).toBe(1);
	});
});

describe("GET /installations — connection status", () => {
	test("returns connected:false and empty list when no installations", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const res = await router.request("/installations");
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			connected: boolean;
			installations: unknown[];
		};
		expect(body.connected).toBe(false);
		expect(body.installations).toEqual([]);
	});

	test("returns connected:true with active installations for the user", async () => {
		const db = freshMemDb();
		const { router, service } = makeConnectApp(db);

		const installation = await service.upsertInstallation({
			userId: "user_1",
			installationId: "inst_77",
			accountLogin: "myorg",
			accountType: "Organization",
			repositorySelection: "all",
			status: "active",
		});

		const res = await router.request("/installations");
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			connected: boolean;
			installations: Array<{
				id: string;
				installation_id: string;
				account_login: string;
				account_type: string;
				repository_selection: string;
				status: string;
			}>;
		};
		expect(body.connected).toBe(true);
		expect(body.installations.length).toBe(1);
		expect(body.installations[0]?.id).toBe(installation.id);
		expect(body.installations[0]?.installation_id).toBe("inst_77");
		expect(body.installations[0]?.account_login).toBe("myorg");
		expect(body.installations[0]?.status).toBe("active");
	});

	test("does NOT return deleted installations", async () => {
		const db = freshMemDb();
		const { router, service } = makeConnectApp(db);

		await service.upsertInstallation({
			userId: "user_1",
			installationId: "inst_del",
			accountLogin: "gone",
			accountType: "User",
			repositorySelection: "all",
			status: "deleted",
		});

		const res = await router.request("/installations");
		const body = (await res.json()) as {
			connected: boolean;
			installations: unknown[];
		};
		// Deleted installations should not count as connected.
		expect(body.connected).toBe(false);
		expect(
			body.installations.filter((i: unknown) => {
				return (i as { status: string }).status !== "deleted";
			}).length,
		).toBe(0);
	});

	test("returns 401 when not authenticated", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db, { authed: false });
		const res = await router.request("/installations");
		expect(res.status).toBe(401);
	});
});

describe("GET /installations/:id/repos — repos for an installation", () => {
	test("returns InstallationRepo[] for owned installation", async () => {
		const db = freshMemDb();
		const { router, service } = makeConnectApp(db);

		const installation = await service.upsertInstallation({
			userId: "user_1",
			installationId: "inst_abc",
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "all",
			status: "active",
		});
		await service.reconcileInstallationRepos({
			installationRowId: installation.id,
			installationId: "inst_abc",
			userId: "user_1",
			selection: "all",
			repos: [{ owner: "acme", name: "web", defaultBranch: "main" }],
		});

		const res = await router.request(`/installations/${installation.id}/repos`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Array<{
			owner: string;
			name: string;
			enabled: boolean;
			default_branch: string;
		}>;
		expect(Array.isArray(body)).toBe(true);
		// Should contain repos from GitHub (via FakeGitHubClient) merged with local state.
		expect(body.length).toBeGreaterThan(0);
	});

	test("honors limit for large installation repo lists", async () => {
		const db = freshMemDb();
		const github = new FakeGitHubClient({
			installationRepos: Array.from({ length: 25 }, (_, i) => ({
				owner: "acme",
				name: `repo-${i}`,
				defaultBranch: "main",
			})),
		});
		const { router, service } = makeConnectApp(db, { github });

		const installation = await service.upsertInstallation({
			userId: "user_1",
			installationId: "inst_many",
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "all",
			status: "active",
		});

		const res = await router.request(
			`/installations/${installation.id}/repos?limit=7`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ name: string }>;
		expect(body).toHaveLength(7);
		expect(body[0]?.name).toBe("repo-0");
		expect(body[6]?.name).toBe("repo-6");
	});

	test("returns 404 for installation not owned by user", async () => {
		const db = freshMemDb("user_1");
		(db.$client as Database)
			.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
			.run("user_2", "user_2@x.io", clockNow);

		const service = createReviewService({
			db,
			auditKey: AUDIT_KEY,
			now: clock,
		});
		// Create installation owned by user_2
		const installation = await service.upsertInstallation({
			userId: "user_2",
			installationId: "inst_other",
			accountLogin: "other-org",
			accountType: "Organization",
			repositorySelection: "all",
			status: "active",
		});

		// Router authed as user_1
		const github = new FakeGitHubClient({ installationRepos: [] });
		const requireAuth = makeFakeAuth("user_1");
		const router = createGithubConnectRouter({
			db,
			service,
			github,
			requireAuth,
			slug: GITHUB_SLUG,
			stateSecret: STATE_SECRET,
			now: clock,
		});

		const res = await router.request(`/installations/${installation.id}/repos`);
		expect(res.status).toBe(404);
	});

	test("returns 401 when not authenticated", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db, { authed: false });
		const res = await router.request("/installations/some-id/repos");
		expect(res.status).toBe(401);
	});

	test("each repo entry has required fields from openapi schema", async () => {
		const db = freshMemDb();
		const { router, service } = makeConnectApp(db);

		const installation = await service.upsertInstallation({
			userId: "user_1",
			installationId: "inst_fields",
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "all",
			status: "active",
		});
		await service.reconcileInstallationRepos({
			installationRowId: installation.id,
			installationId: "inst_fields",
			userId: "user_1",
			selection: "all",
			repos: [{ owner: "acme", name: "web", defaultBranch: "main" }],
		});

		const res = await router.request(`/installations/${installation.id}/repos`);
		const body = (await res.json()) as Array<Record<string, unknown>>;

		expect(body.length).toBeGreaterThan(0);
		for (const r of body) {
			expect(typeof r.owner).toBe("string");
			expect(typeof r.name).toBe("string");
			expect(typeof r.enabled).toBe("boolean");
		}
	});
});

describe("POST /disconnect — disconnect an installation", () => {
	test("marks installation as deleted and returns 200 for owner", async () => {
		const db = freshMemDb();
		const { router, service } = makeConnectApp(db);

		await service.upsertInstallation({
			userId: "user_1",
			installationId: "inst_disc",
			accountLogin: "bye-org",
			accountType: "Organization",
			repositorySelection: "all",
			status: "active",
		});

		const res = await router.request("/disconnect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ installation_id: "inst_disc" }),
		});
		expect(res.status).toBe(200);

		const updated = await service.getInstallationByGithubId(
			"github",
			"inst_disc",
		);
		expect(updated?.status).toBe("deleted");
	});

	test("accepts the local installation row id used by the repositories UI", async () => {
		const db = freshMemDb();
		const { router, service } = makeConnectApp(db);

		const installation = await service.upsertInstallation({
			userId: "user_1",
			installationId: "inst_ui_row",
			accountLogin: "bye-org",
			accountType: "Organization",
			repositorySelection: "all",
			status: "active",
		});

		const res = await router.request("/disconnect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ installation_id: installation.id }),
		});
		expect(res.status).toBe(200);

		const updated = await service.getInstallationByGithubId(
			"github",
			"inst_ui_row",
		);
		expect(updated?.status).toBe("deleted");
	});

	test("returns 403 when installation_id does not belong to user", async () => {
		const db = freshMemDb("user_1");
		(db.$client as Database)
			.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
			.run("user_2", "user_2@x.io", clockNow);

		const service = createReviewService({
			db,
			auditKey: AUDIT_KEY,
			now: clock,
		});
		// Create installation owned by user_2
		await service.upsertInstallation({
			userId: "user_2",
			installationId: "inst_own2",
			accountLogin: "org2",
			accountType: "Organization",
			repositorySelection: "all",
			status: "active",
		});

		// Router authed as user_1
		const github = new FakeGitHubClient();
		const requireAuth = makeFakeAuth("user_1");
		const router = createGithubConnectRouter({
			db,
			service,
			github,
			requireAuth,
			slug: GITHUB_SLUG,
			stateSecret: STATE_SECRET,
			now: clock,
		});

		const res = await router.request("/disconnect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ installation_id: "inst_own2" }),
		});
		expect(res.status).toBe(403);
	});

	test("returns 400 when body is missing installation_id", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const res = await router.request("/disconnect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 when body is invalid JSON", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db);

		const res = await router.request("/disconnect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not-json",
		});
		expect(res.status).toBe(400);
	});

	test("returns 401 when not authenticated", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db, { authed: false });

		const res = await router.request("/disconnect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ installation_id: "inst_any" }),
		});
		expect(res.status).toBe(401);
	});
});

describe("Graceful behavior — slug/secret absent", () => {
	test("GET /connect returns 503 when GitHub slug is not configured", async () => {
		const db = freshMemDb();
		const { router } = makeConnectApp(db, { slug: "" });

		const res = await router.request("/connect");
		expect(res.status).toBe(503);
	});
});
