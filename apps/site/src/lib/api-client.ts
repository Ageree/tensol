// T077 — Typed REST client for the scan/review PaaS surface.
//
// Mirrors specs/002-blackbox-mvp/contracts/openapi.yaml 1:1. Requests keep
// the legacy cookie path and add a Clerk bearer token when the React app has
// an active Clerk session. Snake_case field names match the wire contract
// exactly; we do NOT translate to camelCase at this layer (page components
// read snake_case directly, which keeps grep-ability against the openapi).
//
// This preserves the snake_case wire contract for page components while using
// the execution backend that actually provisions GCP scan VMs and runs review
// jobs. Convex stays wired in the app as the reactive control-plane candidate,
// but these service actions must hit the production worker API.

import {
	ClerkTokenError,
	getClerkSessionToken,
	isE2EAuthBypass,
} from "./clerk.ts";

export const PRODUCTION_API_BASE_URL = "https://api.sthrip.dev";

const LEGACY_API_BASE_URLS = new Set(["https://api.tensol.ru"]);

export function normalizeApiBaseUrl(rawUrl: string): string {
	const url = rawUrl.trim().replace(/\/+$/, "");
	if (LEGACY_API_BASE_URLS.has(url)) return PRODUCTION_API_BASE_URL;
	return url;
}

export function resolveApiBaseUrl(env: {
	readonly VITE_API_BASE_URL?: string;
	readonly VITE_VERCEL_ENV?: string;
}): string {
	const viteUrl = normalizeApiBaseUrl(env.VITE_API_BASE_URL ?? "");
	if (viteUrl) return viteUrl;
	if (env.VITE_VERCEL_ENV === "production") return PRODUCTION_API_BASE_URL;
	return "";
}

function readApiBaseUrl(): string {
	const viteEnv =
		(
			import.meta as unknown as {
				env?: {
					VITE_API_BASE_URL?: string;
					VITE_VERCEL_ENV?: string;
				};
			}
		).env ?? {};
	const viteUrl = resolveApiBaseUrl(viteEnv);
	if (viteUrl) return viteUrl.replace(/\/+$/, "");
	const processUrl = normalizeApiBaseUrl(
		(
			globalThis as typeof globalThis & {
				process?: { env?: { VITE_API_BASE_URL?: string } };
			}
		).process?.env?.VITE_API_BASE_URL?.trim() ?? ""
	);
	if (processUrl) return processUrl;
	return "";
}

// ─── Error envelope ────────────────────────────────────────────────────────
// openapi.yaml component schema `Error`:
//   { error: string (code), message: string, retry_after_seconds?: number|null }
// Validation routes (Zod 422) additionally include `details: unknown[]`.

export interface ApiErrorBody {
	error: string;
	message?: string;
	details?: unknown;
	retry_after_seconds?: number | null;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;
	readonly retryAfterSeconds?: number | null;

	constructor(status: number, body: ApiErrorBody) {
		super(body.message || body.error || `http_${status}`);
		this.name = "ApiError";
		this.status = status;
		this.code = body.error || `http_${status}`;
		this.details = body.details;
		this.retryAfterSeconds = body.retry_after_seconds ?? null;
	}
}

// ─── Domain types (hand-mirrored from openapi.yaml component schemas) ──────
// Cross-importing server-side Zod schemas would couple apps/site to server's
// build graph + drizzle deps. Hand-mirroring keeps the frontend
// self-contained. Snake_case matches the wire contract.

export type ScanOrderStatus =
	| "draft"
	| "dns_pending"
	| "dns_verified"
	| "vm_provisioning"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type ScanOrderTier = "quick" | "deep";

/**
 * Legacy pre-international-pivot payment marker. Keep for current REST
 * compatibility; new billing should move to entitlements/credits.
 */
export type PaymentKind = "free_quick" | "yookassa";

export interface AttackSurfaceHeader {
	k: string;
	v: string;
}

export interface AttackSurfaceEntry {
	domain: string;
	primary: boolean;
	headers: AttackSurfaceHeader[];
}

export interface ScanOrder {
	id: string;
	user_id: string;
	status: ScanOrderStatus;
	tier: ScanOrderTier;
	primary_domain: string;
	attack_surface: AttackSurfaceEntry[];
	safety_rps: number;
	payment_kind: PaymentKind;
	created_at: number;
	updated_at: number;
	// Nullable / optional per openapi
	dns_verify_token?: string | null;
	dns_verified_at?: number | null;
	scan_id?: string | null;
	failure_reason?: string | null;
	/** Legacy RUB minor-unit field. Future billing should use amount_minor + currency. */
	amount_kopecks?: number | null;
}

export type ScanProfile = "recon" | "standard" | "max";

export type ScanStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export interface ScanSummary {
	id: string;
	user_id: string;
	scan_order_id: string;
	profile: ScanProfile;
	status: ScanStatus;
	failure_reason?: string | null;
	started_at: number;
	completed_at?: number | null;
	usage_tokens?: number | null;
	usage_usd_cents?: number | null;
}

export type ScanEventType =
	| "vm_provisioning"
	| "vm_ready"
	| "vm_teardown"
	| "agent_started"
	| "agent_phase_changed"
	| "finding_detected"
	| "scan_completed"
	| "scan_failed";

export interface ScanEvent {
	id: string;
	scan_id: string;
	event_type: ScanEventType;
	payload?: Record<string, unknown> | null;
	created_at: number;
}

export type Severity = "critical" | "high" | "medium" | "low" | "informational";

export type FindingConfidence = "verified" | "high" | "medium" | "low";

export interface Finding {
	id: string;
	scan_id: string;
	external_id: string;
	severity: Severity;
	title: string;
	target: string;
	cvss_score?: number | null;
	cvss_vector?: string | null;
	cvss_version?: string | null;
	cwe: string[];
	mitre: string[];
	confidence?: FindingConfidence | null;
	phase?: string | null;
	agent?: string | null;
	body_md: string;
	evidence_keys: string[];
	discovered_at?: number | null;
	created_at: number;
}

// FindingDetail is the same shape as Finding in the current contract (the
// list and detail endpoints both return the full `Finding` schema). We
// re-export under an alias for forward-compat (e.g. if `evidence_inline`
// gets added to detail later).
export type FindingDetail = Finding;

// DNS verify token request response (POST /scan-orders/:id/dns-verify/request)
export interface DnsVerifyInstructions {
	record_type: "TXT";
	record_name: string;
	record_value: string;
	ttl_hint?: number;
}

export interface DnsVerifyRequestResult {
	token: string;
	instructions: DnsVerifyInstructions;
}

// DNS verify poll response (GET /scan-orders/:id/dns-verify/check)
export interface DnsVerifyCheckResult {
	verified: boolean;
	attempts: number;
	remaining_window_seconds: number;
	last_error?: string | null;
}

// Launch response (POST /scan-orders/:id/launch, 202)
export interface LaunchScanResult {
	scan_id: string;
}

// Report status + signed download (GET /scans/:id/report)
export type ReportStatus = "pending" | "rendering" | "ready" | "failed";

export interface ReportResponse {
	status: ReportStatus;
	download_url?: string | null;
	download_expires_at?: number | null;
	byte_size?: number | null;
}

// Regenerate response (POST /scans/:id/report/regenerate, 202)
export interface ReportRegenerateResult {
	report_id: string;
	job_id: string;
}

// Feature flags (GET /v1/config/feature-flags) — see openapi.yaml + T073.
export interface FeatureFlags {
	/** Legacy compatibility flag; do not build new YooKassa behavior on this. */
	yookassa_live: boolean;
	/** Future provider-agnostic billing toggle. Optional until backend exposes it. */
	billing_live?: boolean;
	/**
	 * Future provider-agnostic billing provider hint.
	 * `manual` is the current near-term paid-access posture; Stripe-dependent
	 * options are not production defaults while the operator has no Stripe account.
	 */
	billing_provider?:
		| "none"
		| "manual"
		| "paddle"
		| "lemonsqueezy"
		| "polar"
		| "stripe"
		| "clerk_billing";
	/** F1 — when true the dashboard offers a per-review "deep research" toggle. */
	research_enabled?: boolean;
	/** F2 — when true the dashboard surfaces exploit-lab verdicts on findings. */
	exploit_enabled?: boolean;
}

// Auth (GET /api/auth/me) — used by US2 deep-inquiry prefill (T106).
// Anonymous callers receive a 401 which we map back to `null`.
export interface AuthMe {
	id: string;
	email: string;
	free_quick_available?: boolean;
	free_quick_resets_at?: number | null;
	convex_user_initialized?: boolean;
}

// Deep inquiry (POST /v1/deep-inquiries) — US2 lead-gen funnel.
// Mirrors `server/src/schemas/deep-inquiries.ts` CreateInquiryBodySchema and
// `specs/002-blackbox-mvp/contracts/openapi.yaml` 1:1.
export type DeepInquiryBudgetBand =
	| "under_500k"
	| "500k_1m"
	| "1m_3m"
	| "3m_plus"
	| "open";

export interface CreateDeepInquiryBody {
	company: string;
	contact_name: string;
	position?: string | null;
	email?: string | null;
	phone: string;
	domains_text: string;
	desired_date?: number | null;
	budget_band?: DeepInquiryBudgetBand | null;
	scope_text: string;
	consent_accepted: true;
}

export interface DeepInquiryCreateResult {
	id: string;
}

// ─── Request body types ────────────────────────────────────────────────────

export interface CreateScanOrderBody {
	tier: "quick"; // Deep doesn't create scan-orders in MVP
	primary_domain: string;
}

export interface UpdateAttackSurfaceBody {
	attack_surface: AttackSurfaceEntry[];
}

export interface UpdateSafetyBody {
	safety_rps: number;
}

// ─── REST transport wrapper ────────────────────────────────────────────────

const REST_REQUEST_TIMEOUT_MS = 15_000;

interface RestRequestOptions {
	readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly body?: unknown;
	readonly auth?: boolean | "optional";
}

async function requestHeaders(
	hasBody: boolean,
	authMode: boolean | "optional",
): Promise<HeadersInit | undefined> {
	const headers: Record<string, string> = {};
	if (hasBody) headers["content-type"] = "application/json";
	if (authMode === false)
		return Object.keys(headers).length > 0 ? headers : undefined;
	if (isE2EAuthBypass)
		return Object.keys(headers).length > 0 ? headers : undefined;

	let token: string | null;
	try {
		token = await getClerkSessionToken();
	} catch (error) {
		if (error instanceof ClerkTokenError) {
			throw new ApiError(500, {
				error: "clerk_token_error",
				message: error.message,
			});
		}
		throw error;
	}

	if (token) {
		headers.authorization = `Bearer ${token}`;
	} else if (authMode !== "optional") {
		throw new ApiError(401, {
			error: "unauthorized",
			message: "Clerk session token is unavailable",
		});
	}

	return Object.keys(headers).length > 0 ? headers : undefined;
}

async function request<T>(
	path: string,
	opts: RestRequestOptions = {},
): Promise<T> {
	const method = opts.method ?? "GET";
	const authMode = opts.auth ?? true;
	const baseUrl = readApiBaseUrl();
	const headers = await requestHeaders(opts.body !== undefined, authMode);
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		REST_REQUEST_TIMEOUT_MS,
	);

	let res: Response;
	try {
		res = await fetch(`${baseUrl}${path}`, {
			method,
			credentials: "include",
			headers,
			signal: controller.signal,
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		});
	} catch {
		throw new ApiError(0, {
			error: "network_error",
			message: "Network request failed",
		});
	} finally {
		clearTimeout(timeout);
	}

	if (res.status === 204) return undefined as T;

	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		if (res.ok) return undefined as T;
		throw new ApiError(res.status, {
			error: "parse_error",
			message: "Response was not valid JSON",
		});
	}

	if (!res.ok) {
		const body = (
			parsed && typeof parsed === "object" ? parsed : {}
		) as Partial<ApiErrorBody> & { issues?: unknown };
		throw new ApiError(res.status, {
			error: body.error || `http_${res.status}`,
			message: body.message,
			details: body.details ?? body.issues,
			retry_after_seconds: body.retry_after_seconds ?? null,
		});
	}

	return parsed as T;
}

function queryString(
	params: Record<string, string | number | undefined>,
): string {
	const q = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) q.set(key, String(value));
	}
	const s = q.toString();
	return s ? `?${s}` : "";
}

interface ListOptions {
	readonly limit?: number;
	readonly kind?: ReviewKind;
}

// ─── Scan Orders (9 endpoints) ─────────────────────────────────────────────

export const scanOrders = {
	/** GET /v1/scan-orders — list caller's orders. */
	list: (opts?: ListOptions): Promise<ScanOrder[]> =>
		request(`/v1/scan-orders${queryString({ limit: opts?.limit })}`),

	/** POST /v1/scan-orders — create a draft (201). */
	create: (body: CreateScanOrderBody): Promise<ScanOrder> =>
		request("/v1/scan-orders", { method: "POST", body }),

	/** GET /v1/scan-orders/:id — fetch one. */
	get: (id: string): Promise<ScanOrder> =>
		request(`/v1/scan-orders/${encodeURIComponent(id)}`),

	/** PUT /v1/scan-orders/:id/attack-surface — Step 1 commit. */
	updateAttackSurface: (
		id: string,
		body: UpdateAttackSurfaceBody,
	): Promise<ScanOrder> =>
		request(`/v1/scan-orders/${encodeURIComponent(id)}/attack-surface`, {
			method: "PUT",
			body,
		}),

	/** PUT /v1/scan-orders/:id/safety — Step 2 commit. */
	updateSafety: (id: string, body: UpdateSafetyBody): Promise<ScanOrder> =>
		request(`/v1/scan-orders/${encodeURIComponent(id)}/safety`, {
			method: "PUT",
			body,
		}),

	/** POST /v1/scan-orders/:id/dns-verify/request — Step 3 begin. */
	requestDnsVerify: (id: string): Promise<DnsVerifyRequestResult> =>
		request(`/v1/scan-orders/${encodeURIComponent(id)}/dns-verify/request`, {
			method: "POST",
		}),

	/** GET /v1/scan-orders/:id/dns-verify/check — Step 3 poll. */
	checkDnsVerify: (id: string): Promise<DnsVerifyCheckResult> =>
		request(`/v1/scan-orders/${encodeURIComponent(id)}/dns-verify/check`),

	/** POST /v1/scan-orders/:id/launch — Step 4 commit (202). */
	launch: (id: string): Promise<LaunchScanResult> =>
		request(`/v1/scan-orders/${encodeURIComponent(id)}/launch`, {
			method: "POST",
		}),

	/** DELETE /v1/scan-orders/:id — cancel an order or scan in flight. */
	cancel: (id: string): Promise<ScanOrder> =>
		request(`/v1/scan-orders/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

// ─── Scans (6 endpoints) ───────────────────────────────────────────────────

export const scans = {
	/** GET /v1/scans/:id — scan summary. */
	get: (id: string): Promise<ScanSummary> =>
		request(`/v1/scans/${encodeURIComponent(id)}`),

	/**
	 * GET /v1/scans/:id/events?since=<unix-ms> — polled event stream.
	 * Returns events strictly after `since` (ms). Omit `since` to get all.
	 */
	getEvents: (
		id: string,
		since?: number,
		opts?: ListOptions,
	): Promise<ScanEvent[]> =>
		request(
			`/v1/scans/${encodeURIComponent(id)}/events${queryString({ since, limit: opts?.limit })}`,
		),

	/** GET /v1/scans/:id/findings — list (severity-ranked). */
	getFindings: (id: string, opts?: ListOptions): Promise<Finding[]> =>
		request(
			`/v1/scans/${encodeURIComponent(id)}/findings${queryString({ limit: opts?.limit })}`,
		),

	/** GET /v1/scans/:id/findings/:findingId — single finding detail. */
	getFindingDetail: (id: string, findingId: string): Promise<FindingDetail> =>
		request(
			`/v1/scans/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}`,
		),

	/** GET /v1/scans/:id/report — report status + signed download URL. */
	getReport: (id: string): Promise<ReportResponse> =>
		request(`/v1/scans/${encodeURIComponent(id)}/report`),

	/** POST /v1/scans/:id/report/regenerate — re-render PDF (202). */
	regenerateReport: (id: string): Promise<ReportRegenerateResult> =>
		request(`/v1/scans/${encodeURIComponent(id)}/report/regenerate`, {
			method: "POST",
		}),
};

// ─── Config (1 endpoint) ───────────────────────────────────────────────────

export const config = {
	/** GET /v1/config/feature-flags — public, no auth required. */
	getFeatureFlags: (): Promise<FeatureFlags> =>
		request("/v1/config/feature-flags", { auth: false }),
};

// ─── Auth (T106 — US2 prefill) ─────────────────────────────────────────────

export const auth = {
	/**
	 * GET /api/auth/me — current user session.
	 *
	 * Signed-in callers send Clerk's default bearer token. Anonymous callers still
	 * hit the route without auth and get `null`, allowing the deep-inquiry form to
	 * fall back to the anonymous flow. Other errors continue to throw `ApiError`.
	 */
	me: async (): Promise<AuthMe | null> => {
		try {
			const body = await request<{ user: AuthMe }>("/api/auth/me", {
				auth: "optional",
			});
			return body.user;
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) return null;
			throw err;
		}
	},
};

// ─── Deep inquiries (T106 — US2 lead-gen funnel) ───────────────────────────

export const deepInquiries = {
	/** POST /v1/deep-inquiries — anonymous OR authenticated (201). */
	create: (body: CreateDeepInquiryBody): Promise<DeepInquiryCreateResult> =>
		request("/v1/deep-inquiries", { method: "POST", body, auth: "optional" }),
};

// ─── GitHub / Installations (004-sthrip-pr-review) ────────────────────────
// Mirrors specs/004-sthrip-pr-review/contracts/openapi.yaml.
// All field names are snake_case to match the wire contract exactly (same
// convention as the rest of this file).

/**
 * GET /v1/github/connect response.
 * `install_url` is the GitHub App installation URL the frontend redirects to.
 * `state` is the CSRF nonce echoed back on the callback.
 */
export interface ConnectUrl {
	install_url: string;
	state?: string;
}

/** Shape of a single installation row returned by GET /v1/github/installations. */
export interface Installation {
	id: string;
	installation_id?: string;
	account_login: string;
	account_type: "User" | "Organization";
	repository_selection: "all" | "selected";
	status: "active" | "suspended" | "deleted";
}

/** GET /v1/github/installations response envelope. */
export interface InstallationsResponse {
	connected: boolean;
	installations: Installation[];
}

/**
 * A repository accessible through a GitHub App installation,
 * with Sthrip coverage + settings state overlaid.
 * Mirrors openapi.yaml `InstallationRepo`.
 */
export interface InstallationRepo {
	/** Sthrip `review_repos.id` if this repo is already tracked; null otherwise. */
	repo_id?: string | null;
	owner: string;
	name: string;
	default_branch?: string;
	enabled: boolean;
	covered_branches?: string[];
	status_check_enabled?: boolean;
	merge_block_on_critical?: boolean;
	last_review?: {
		review_id: string;
		status: "queued" | "running" | "completed" | "failed" | "cancelled";
		score_0_5?: number | null;
		updated_at: number;
	} | null;
}

/**
 * Request body for PATCH /v1/review/repos/{id}/settings.
 * Mirrors openapi.yaml `RepoSettingsUpdate`.
 */
export interface RepoSettingsUpdate {
	enabled?: boolean;
	covered_branches?: string[];
	status_check_enabled?: boolean;
	merge_block_on_critical?: boolean;
}

export const github = {
	/**
	 * GET /v1/github/connect — begin GitHub App connection.
	 * Returns the install URL (redirect the browser there) and a CSRF state.
	 */
	connect: (): Promise<ConnectUrl> => request("/v1/github/connect"),

	/**
	 * GET /v1/github/installations — connection status + list of installations.
	 * Returns `{ connected: false, installations: [] }` when the user has not
	 * connected yet.
	 */
	installations: (): Promise<InstallationsResponse> =>
		request("/v1/github/installations"),

	/**
	 * GET /v1/github/installations/{installation_id}/repos
	 * Lists repositories the installation can access with Sthrip coverage state.
	 * 404 if the installation is not owned by the current user.
	 */
	installationRepos: (
		installationId: string,
		opts?: ListOptions,
	): Promise<InstallationRepo[]> =>
		request(
			`/v1/github/installations/${encodeURIComponent(installationId)}/repos${queryString({ limit: opts?.limit })}`,
		),

	/**
	 * PATCH /v1/review/repos/{repo_id}/settings
	 * Update per-repo review coverage settings (enable/disable, branches, gates).
	 * 403 if the repo is not owned by the current user.
	 */
	updateRepoSettings: (
		repoId: string,
		body: RepoSettingsUpdate,
	): Promise<InstallationRepo> =>
		request(`/v1/review/repos/${encodeURIComponent(repoId)}/settings`, {
			method: "PATCH",
			body,
		}),

	/**
	 * POST /v1/github/disconnect
	 * Marks the installation as deleted locally; the user must also uninstall
	 * the app on GitHub. 403 if the installation is not owned by the current user.
	 */
	disconnect: (installationId: string): Promise<void> =>
		request<{ ok: boolean }>("/v1/github/disconnect", {
			method: "POST",
			body: { installation_id: installationId },
		}).then(() => undefined),
};

// ─── Review (003-whitebox: PR Review + Whitebox Pentest) ───────────────────
// Mirrors `server/src/review/*` + `.claude/skills/tensol-loop/references/api.md`.

export type ReviewKind = "pr" | "whitebox";
export type ReviewMode = "fast" | "deep";
export type ReviewRunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

/**
 * Verification status attached to a finding after the verification gate
 * (server/src/review/verify.ts, T031). Wire value mirrors the DB column.
 */
export type VerificationStatus = "verified" | "unverified" | "refuted";

export interface ReviewFindingWire {
	fingerprint: string;
	file_path: string;
	start_line?: number | null;
	end_line?: number | null;
	side: "LEFT" | "RIGHT";
	severity: Severity;
	cwe: string[];
	cvss_vector?: string | null;
	cvss_score?: number | null;
	confidence?: FindingConfidence | null;
	reachable?: boolean | null;
	category?: string | null;
	title: string;
	rationale_md: string;
	poc_md?: string | null;
	fix_prompt_md?: string | null;
	source: "llm" | "sast" | "secrets" | "sca";
	// ── T026 — new fields exposed by migration 0013 + verify gate (T031) ──
	/** Verification classification: verified | unverified | refuted. */
	verification_status?: VerificationStatus | null;
	/** Markdown taint-path evidence from the Joern reachability adapter (T032). */
	reachability_evidence_md?: string | null;
	// ── F2 — Exploit Lab verdict (migration 0013), surfaced for the dashboard ──
	/** Terminal disposition of the autonomous exploit attempt. */
	exploit_status?: ExploitStatus | null;
	/** 0-100 exploitability score (how easily the PoC proved it). */
	exploitability_score?: number | null;
	/** 0-100 impact score (derived from CVSS). */
	impact_score?: number | null;
	/** Refine-loop iterations the Lab took. */
	exploit_iterations?: number | null;
}

/**
 * Terminal status of the Exploit Lab attempt for a finding (F2). Mirrors the
 * server `ExploitStatus` union + the `exploit_status` DB column. When `proven`,
 * the verified PoC is carried on `poc_md`.
 */
export type ExploitStatus =
	| "not_attempted"
	| "proven"
	| "failed"
	| "error"
	| "skipped_budget"
	| "skipped_unauthorized";

export interface ReviewResultWire {
	review_id: string;
	kind?: ReviewKind;
	mode?: ReviewMode;
	status: ReviewRunStatus;
	score_0_5?: number | null;
	summary_md?: string | null;
	pr_number?: number | null;
	repo?: string | null;
	created_at?: number;
	completed_at?: number | null;
	findings: ReviewFindingWire[];
}

/**
 * GET /v1/review list-item shape. Distinct from `ReviewResultWire`: it carries
 * a counted `findings_count` instead of a full `findings` array (the list never
 * loads findings). Mirrors `server/src/routes/review.ts` GET / serializer.
 */
export interface ReviewListItemWire {
	review_id: string;
	kind?: ReviewKind;
	mode?: ReviewMode;
	status: ReviewRunStatus;
	score_0_5?: number | null;
	pr_number?: number | null;
	repo?: string | null;
	created_at?: number;
	completed_at?: number | null;
	findings_count: number;
}

export interface ReviewRepoWire {
	id: string;
	scm: "github" | "gitlab" | "bitbucket";
	owner: string;
	name: string;
	default_branch: string;
	status: "active" | "paused" | "revoked";
	installation_id?: string | null;
	created_at?: number;
}

export interface CreateReviewBody {
	repo: string;
	pr?: number;
	head_sha?: string;
	base_sha?: string;
	diff?: string;
	files?: Array<{
		path: string;
		status?: "added" | "modified" | "removed" | "renamed";
		patch?: string;
		contents?: string;
		previous_path?: string;
	}>;
	sync?: boolean;
}

export interface LaunchWhiteboxBody {
	repo_id?: string;
	repo?: string;
	ref?: string;
	/** F1 — "deep" requests the multi-agent deep-research pipeline (only honored
	 *  when the server reports `research_enabled`). Defaults to "fast". */
	mode?: ReviewMode;
}

// ─── Agent API tokens (dashboard onboarding for CLI/MCP) ───────────────────

export interface AgentTokenMeta {
	id: string;
	name: string;
	token_prefix: string;
	created_at: number;
	last_used_at?: number | null;
	revoked_at?: number | null;
}

export interface AgentTokenCreateResult {
	token: string;
	token_meta: AgentTokenMeta;
}

export interface AgentTokenListResult {
	tokens: AgentTokenMeta[];
}

export const agentTokens = {
	/** POST /v1/agent/tokens — create a token; plaintext is returned once. */
	create: (body: { name: string }): Promise<AgentTokenCreateResult> =>
		request("/v1/agent/tokens", { method: "POST", body }),

	/** GET /v1/agent/tokens — list token metadata only. */
	list: (): Promise<AgentTokenListResult> => request("/v1/agent/tokens"),

	/** DELETE /v1/agent/tokens/:id — revoke one token. */
	revoke: (id: string): Promise<{ revoked: boolean }> =>
		request(`/v1/agent/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const review = {
	/** POST /v1/review — trigger a review (sync or async). */
	create: (body: CreateReviewBody): Promise<ReviewResultWire> =>
		request("/v1/review", { method: "POST", body }),

	/** GET /v1/review/:id — poll a review's status + findings. */
	get: (id: string): Promise<ReviewResultWire> =>
		request(`/v1/review/${encodeURIComponent(id)}`).then((result) => {
			const wire = result as ReviewResultWire & { id?: string };
			if (!wire.review_id && wire.id) wire.review_id = wire.id;
			return wire;
		}),

	/** GET /v1/review — list the caller's recent reviews (list-item shape). */
	list: (opts?: ListOptions): Promise<ReviewListItemWire[]> =>
		request(`/v1/review${queryString({ limit: opts?.limit, kind: opts?.kind })}`),

	/** GET /v1/review/repos — list connected source repos. */
	listRepos: (opts?: ListOptions): Promise<ReviewRepoWire[]> =>
		request(`/v1/review/repos${queryString({ limit: opts?.limit })}`),

	/** POST /v1/review/whitebox — launch a whole-repo whitebox scan (202). */
	launchWhitebox: (body: LaunchWhiteboxBody): Promise<{ review_id: string }> =>
		request("/v1/review/whitebox", { method: "POST", body }),
};

// ─── Top-level convenience export ─────────────────────────────────────────

export const apiClient = {
	scanOrders,
	scans,
	config,
	auth,
	deepInquiries,
	agentTokens,
	review,
	github,
};
