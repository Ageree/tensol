// T077 — Unit tests for the typed REST api-client.

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
	AgentTokenCreateResult,
	ApiError,
	AuthMe,
	CreateDeepInquiryBody,
	FeatureFlags,
	InstallationRepo,
	ReviewResultWire,
	ScanOrder,
} from "./api-client.ts";

type ApiClientModule = typeof import("./api-client.ts");
type TokenOptions = { template?: string };

interface FetchCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
	credentials: RequestCredentials | undefined;
}

let apiClientModule: ApiClientModule;
let calls: FetchCall[] = [];
let queuedResponses: Response[] = [];
let currentToken: string | null = "test-clerk-jwt";
let tokenOptions: Array<TokenOptions | undefined> = [];
let failNextFetch = false;

class MockClerkTokenError extends Error {
	constructor(message = "Failed to acquire Clerk session token") {
		super(message);
		this.name = "ClerkTokenError";
	}
}

function setTestEnv(key: string, value: string): void {
	const global = globalThis as typeof globalThis & {
		process: { env: Record<string, string | undefined> };
	};
	global.process.env[key] = value;
}

function enqueueJson(value: unknown, init: ResponseInit = {}): void {
	queuedResponses.push(
		new Response(JSON.stringify(value), {
			status: init.status ?? 200,
			headers: { "content-type": "application/json", ...init.headers },
		}),
	);
}

function normalizeHeaders(
	headers: HeadersInit | undefined,
): Record<string, string> {
	if (!headers) return {};
	return Object.fromEntries(new Headers(headers).entries());
}

async function readBody(body: BodyInit | null | undefined): Promise<unknown> {
	if (typeof body !== "string") return undefined;
	return JSON.parse(body);
}

const fetchMock = mock(
	async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			headers: normalizeHeaders(init?.headers),
			body: await readBody(init?.body),
			credentials: init?.credentials,
		});
		if (failNextFetch) {
			failNextFetch = false;
			throw new TypeError("network failed");
		}
		const next = queuedResponses.shift();
		if (!next) {
			throw new Error("fetchMock response queue is empty");
		}
		return next;
	},
);

const getClerkSessionToken = mock(async (options?: TokenOptions) => {
	tokenOptions.push(options);
	return currentToken;
});

mock.module("./clerk.ts", () => ({
	ClerkTokenError: MockClerkTokenError,
	getClerkSessionToken,
	isE2EAuthBypass: false,
}));

beforeAll(async () => {
	setTestEnv("VITE_API_BASE_URL", "https://api.test");
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	apiClientModule = await import("./api-client.ts");
});

beforeEach(() => {
	calls = [];
	queuedResponses = [];
	currentToken = "test-clerk-jwt";
	tokenOptions = [];
	failNextFetch = false;
	getClerkSessionToken.mockClear();
	fetchMock.mockClear();
});

describe("protected REST calls", () => {
	test("normalizes legacy production API origin to canonical Sthrip API", () => {
		expect(
			apiClientModule.normalizeApiBaseUrl("https://api.tensol.ru/"),
		).toBe("https://api.sthrip.dev");
		expect(
			apiClientModule.normalizeApiBaseUrl("https://api.sthrip.dev/"),
		).toBe("https://api.sthrip.dev");
	});

	test("resolves API origin without sending preview builds to production", () => {
		expect(apiClientModule.resolveApiBaseUrl({})).toBe("");
		expect(
			apiClientModule.resolveApiBaseUrl({
				VITE_VERCEL_ENV: "preview",
			}),
		).toBe("");
		expect(
			apiClientModule.resolveApiBaseUrl({
				VITE_VERCEL_ENV: "production",
			}),
		).toBe("https://api.sthrip.dev");
		expect(
			apiClientModule.resolveApiBaseUrl({
				VITE_API_BASE_URL: "https://api.tensol.ru",
				VITE_VERCEL_ENV: "production",
			}),
		).toBe("https://api.sthrip.dev");
	});

	test("scanOrders.list calls /v1/scan-orders with Clerk bearer auth", async () => {
		const fixture: ScanOrder[] = [
			{
				id: "order_1",
				user_id: "user_1",
				status: "draft",
				tier: "quick",
				primary_domain: "example.com",
				attack_surface: [],
				safety_rps: 50,
				payment_kind: "free_quick",
				created_at: 1700000000,
				updated_at: 1700000000,
			},
		];
		enqueueJson(fixture);

		const result = await apiClientModule.scanOrders.list();

		expect(result).toEqual(fixture);
		expect(tokenOptions).toEqual([undefined]);
		expect(calls).toEqual([
			{
				url: "https://api.test/v1/scan-orders",
				method: "GET",
				headers: { authorization: "Bearer test-clerk-jwt" },
				body: undefined,
				credentials: "include",
			},
		]);
	});

	test("list helpers include optional limit query params", async () => {
		enqueueJson([]);
		enqueueJson([]);
		enqueueJson([]);
		enqueueJson([]);
		enqueueJson([]);

		await apiClientModule.scanOrders.list({ limit: 12 });
		await apiClientModule.review.list({ limit: 13 });
		await apiClientModule.review.list({ limit: 14, kind: "whitebox" });
		await apiClientModule.review.listRepos({ limit: 14 });
		await apiClientModule.github.installationRepos("inst_1", { limit: 15 });

		expect(calls.map((call) => call.url)).toEqual([
			"https://api.test/v1/scan-orders?limit=12",
			"https://api.test/v1/review?limit=13",
			"https://api.test/v1/review?limit=14&kind=whitebox",
			"https://api.test/v1/review/repos?limit=14",
			"https://api.test/v1/github/installations/inst_1/repos?limit=15",
		]);
	});

	test("scan order mutations preserve ids, methods, and request bodies", async () => {
		const order: ScanOrder = {
			id: "order_1",
			user_id: "user_1",
			status: "draft",
			tier: "quick",
			primary_domain: "acme.test",
			attack_surface: [{ domain: "acme.test", primary: true, headers: [] }],
			safety_rps: 50,
			payment_kind: "free_quick",
			created_at: 1700000000,
			updated_at: 1700000001,
		};
		enqueueJson(order);
		enqueueJson({
			verified: false,
			attempts: 1,
			remaining_window_seconds: 899,
			last_error: null,
		});
		enqueueJson({ scan_id: "scan_1" }, { status: 202 });

		expect(
			await apiClientModule.scanOrders.updateAttackSurface("order_1", {
				attack_surface: order.attack_surface,
			}),
		).toEqual(order);
		expect(await apiClientModule.scanOrders.checkDnsVerify("order_1")).toEqual({
			verified: false,
			attempts: 1,
			remaining_window_seconds: 899,
			last_error: null,
		});
		expect(await apiClientModule.scanOrders.launch("order_1")).toEqual({
			scan_id: "scan_1",
		});

		expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
			[
				"PUT",
				"https://api.test/v1/scan-orders/order_1/attack-surface",
				{ attack_surface: order.attack_surface },
			],
			[
				"GET",
				"https://api.test/v1/scan-orders/order_1/dns-verify/check",
				undefined,
			],
			["POST", "https://api.test/v1/scan-orders/order_1/launch", undefined],
		]);
	});

	test("missing Clerk token is surfaced before protected fetch", async () => {
		currentToken = null;

		let caught: unknown;
		try {
			await apiClientModule.scanOrders.list();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(apiClientModule.ApiError);
		expect((caught as ApiError).status).toBe(401);
		expect((caught as ApiError).code).toBe("unauthorized");
		expect(calls).toHaveLength(0);
	});
});

describe("public and optional-auth REST calls", () => {
	test("config skips Clerk auth", async () => {
		const flags: FeatureFlags = {
			yookassa_live: false,
			billing_live: false,
			billing_provider: "manual",
			research_enabled: true,
			exploit_enabled: true,
		};
		enqueueJson(flags);

		expect(await apiClientModule.config.getFeatureFlags()).toEqual(flags);

		expect(getClerkSessionToken).not.toHaveBeenCalled();
		expect(calls[0]).toEqual({
			url: "https://api.test/v1/config/feature-flags",
			method: "GET",
			headers: {},
			body: undefined,
			credentials: "include",
		});
	});

	test("deep inquiries send bearer auth when a session exists", async () => {
		const body: CreateDeepInquiryBody = {
			company: "Acme",
			contact_name: "Alex",
			phone: "+79991234567",
			domains_text: "acme.test",
			scope_text: "External perimeter, no DoS.",
			consent_accepted: true,
		};
		enqueueJson({ id: "inquiry_1", status: "received" }, { status: 201 });

		const result = await apiClientModule.deepInquiries.create(body);
		expect(result.id).toBe("inquiry_1");

		expect(tokenOptions).toEqual([undefined]);
		expect(calls[0]).toEqual({
			url: "https://api.test/v1/deep-inquiries",
			method: "POST",
			headers: {
				authorization: "Bearer test-clerk-jwt",
				"content-type": "application/json",
			},
			body,
			credentials: "include",
		});
	});

	test("deep inquiries keep anonymous fallback when no Clerk token exists", async () => {
		currentToken = null;
		const body: CreateDeepInquiryBody = {
			company: "Acme",
			contact_name: "Alex",
			phone: "+79991234567",
			domains_text: "acme.test",
			scope_text: "External perimeter, no DoS.",
			consent_accepted: true,
		};
		enqueueJson({ id: "inquiry_1" }, { status: 201 });

		expect(await apiClientModule.deepInquiries.create(body)).toEqual({
			id: "inquiry_1",
		});

		expect(tokenOptions).toEqual([undefined]);
		expect(calls[0]?.headers).toEqual({ "content-type": "application/json" });
	});

	test("auth.me maps /api/auth/me user envelope and 401 anonymous fallback", async () => {
		const user: AuthMe = {
			id: "user_1",
			email: "ops@acme.test",
			free_quick_available: true,
			free_quick_resets_at: null,
		};
		enqueueJson({ user });

		expect(await apiClientModule.auth.me()).toEqual(user);
		expect(calls[0]?.url).toBe("https://api.test/api/auth/me");

		currentToken = null;
		enqueueJson({ error: "unauthorized" }, { status: 401 });
		expect(await apiClientModule.auth.me()).toBeNull();
	});
});

describe("error handling", () => {
	test("HTTP error envelopes map to ApiError with status, code, and details", async () => {
		enqueueJson(
			{
				error: "not_found",
				message: "scan not found",
				details: [{ path: "id", code: "missing" }],
			},
			{ status: 404 },
		);

		let caught: unknown;
		try {
			await apiClientModule.scans.get("scan_1");
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(apiClientModule.ApiError);
		expect((caught as ApiError).status).toBe(404);
		expect((caught as ApiError).code).toBe("not_found");
		expect((caught as ApiError).message).toBe("scan not found");
		expect(Array.isArray((caught as ApiError).details)).toBe(true);
	});

	test("network failures map to ApiError(0, network_error)", async () => {
		failNextFetch = true;

		let caught: unknown;
		try {
			await apiClientModule.scans.getEvents("scan_1", 1700000050);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(apiClientModule.ApiError);
		expect((caught as ApiError).status).toBe(0);
		expect((caught as ApiError).code).toBe("network_error");
		expect(calls[0]?.url).toBe(
			"https://api.test/v1/scans/scan_1/events?since=1700000050",
		);
	});

	test("Clerk token failures surface as clerk_token_error", async () => {
		getClerkSessionToken.mockImplementationOnce(async () => {
			throw new MockClerkTokenError("JWT mint failed");
		});

		let caught: unknown;
		try {
			await apiClientModule.scanOrders.list();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(apiClientModule.ApiError);
		expect((caught as ApiError).status).toBe(500);
		expect((caught as ApiError).code).toBe("clerk_token_error");
		expect((caught as ApiError).message).toBe("JWT mint failed");
		expect(calls).toHaveLength(0);
	});
});

describe("secondary namespaces", () => {
	test("github, review, and agent token helpers route through REST endpoints", async () => {
		const repo: InstallationRepo = {
			repo_id: "repo_1",
			owner: "acmecorp",
			name: "backend",
			default_branch: "main",
			enabled: false,
			status_check_enabled: true,
			merge_block_on_critical: false,
		};
		const review: ReviewResultWire = {
			review_id: "review_1",
			kind: "whitebox",
			mode: "deep",
			status: "completed",
			score_0_5: 4,
			repo: "acmecorp/backend",
			findings: [],
		};
		const token: AgentTokenCreateResult = {
			token: "sthrip_testtoken",
			token_meta: {
				id: "token_1",
				name: "Codex",
				token_prefix: "sthrip_testtoken".slice(0, 18),
				created_at: 1700000000,
				last_used_at: null,
				revoked_at: null,
			},
		};
		enqueueJson(repo);
		enqueueJson(review, { status: 202 });
		enqueueJson(token, { status: 201 });

		expect(
			await apiClientModule.github.updateRepoSettings("repo_1", {
				enabled: false,
			}),
		).toEqual(repo);
		expect(
			await apiClientModule.review.launchWhitebox({
				repo_id: "repo_1",
				mode: "deep",
			}),
		).toEqual(review);
		expect(await apiClientModule.agentTokens.create({ name: "Codex" })).toEqual(
			token,
		);

		expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
			[
				"PATCH",
				"https://api.test/v1/review/repos/repo_1/settings",
				{ enabled: false },
			],
			[
				"POST",
				"https://api.test/v1/review/whitebox",
				{ repo_id: "repo_1", mode: "deep" },
			],
			["POST", "https://api.test/v1/agent/tokens", { name: "Codex" }],
		]);
	});
});
