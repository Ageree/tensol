/**
 * T092 + T093 + T120 — Shared helpers for the scan-wizard E2E specs.
 *
 * Extracted from T091 (`apps/site/e2e/scan-wizard.spec.ts`, commit 265bd14)
 * so the happy-path, free-quota, dns-timeout, and history-redownload specs
 * all share the same auth-bypass + webhook-signing primitives. Keeping the
 * helpers in one place avoids drift if the test-server endpoint shape
 * changes.
 *
 * Backend env requirements (set by T102 smoke runner):
 *   - TENSOL_DEV_DNS_BYPASS=true   — auto-verifies DNS after ~5s
 *   - TENSOL_WEBHOOK_SECRET=<hex>  — must match `E2E_WEBHOOK_SECRET` below
 *   - Test-only endpoints exposed under `/__test/v2/...`:
 *       POST /__test/v2/seed-session       { email } → { session_id, user_id }
 *       POST /__test/v2/exhaust-quota      { user_id } → { ok, free_quick_consumed_at }
 *           (T092) Marks `users.free_quick_consumed_at = now()` so the
 *           next launchScan call returns 429 QUOTA_EXHAUSTED.
 *       POST /__test/v2/expire-dns-verify  { order_id } → { ok, dns_verify_requested_at }
 *           (T093) Backdates `scan_orders.dns_verify_requested_at` to
 *           ≥31 min ago so the next checkVerification poll trips the
 *           30-min hard cap and emits a `dns_verify_failed` audit.
 *       POST /__test/v2/create-dns-pending { user_id, primary_domain } → { order_id, dns_token }
 *           (T093) Shortcut to skip wizard step 1 + step 2 and land
 *           directly at step 3 in `dns_pending`.
 *       POST /__test/v2/create-dns-verified { user_id, primary_domain, rps? } → { order_id }
 *           (T092) Shortcut: an order already in `dns_verified` so the
 *           spec can launch immediately.
 *       POST /__test/v2/seed-completed-scan { user_id, findings_count?, report_status? } → { order_id, scan_id, report_id }
 *           (T120) Fabricates a full history row: a `scan_orders` row in
 *           `completed`, a sibling `scans` row in `completed`, the
 *           requested number of `findings`, and a `reports` row in the
 *           requested status (default `ready`). Used to test dashboard
 *           history + re-download + regenerate-on-expiry without
 *           waiting for a real scan to complete.
 *       POST /__test/v2/expire-report { report_id } → { ok, expires_at }
 *           (T120) Flips `reports.download_expires_at` to a past
 *           timestamp so the report client treats the URL as expired
 *           and the regenerate affordance must surface on next poll.
 *       POST /__test/v2/seed-review-repo { user_id, owner?, name?, installation_id? }
 *           Fabricates the GitHub App installation + review repo rows needed
 *           for repositories, whitebox, and PR-review E2E coverage.
 *
 * Constitution V (NON-NEGOTIABLE): polling only, no SSE.
 * Constitution VII: server-side Zod is canonical; this mirrors the
 *   snake_case contract shapes from `specs/002-blackbox-mvp/contracts/`.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, BrowserContext } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ──────────────────────────────────────────────────────────────

export const FRONTEND_BASE_URL =
	process.env.PW_BASE_URL ?? "http://127.0.0.1:5175";
export const BACKEND_BASE_URL =
	process.env.TENSOL_E2E_BACKEND_BASE_URL ?? "http://127.0.0.1:3001";

/**
 * Synthetic test secret used by the e2e-test-server when it boots with
 * `TENSOL_WEBHOOK_SECRET=e2e-webhook-test-secret` injected via env. Real
 * production secrets are 256-bit per-fleet values; this is purely a
 * deterministic value for the spec to sign against.
 */
export const E2E_WEBHOOK_SECRET = "e2e-webhook-test-secret";

/** Synthetic GitHub App webhook secret used by e2e-test-server. */
export const E2E_GITHUB_WEBHOOK_SECRET = "e2e-github-webhook-secret";

/** Juice Shop fixture (T060) — 9 findings, signed and replayed. */
export const JUICESHOP_FIXTURE_PATH = join(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"server",
	"test",
	"fixtures",
	"webhook-scan-complete-juiceshop.json",
);

// ── Polling helper ─────────────────────────────────────────────────────────

export interface PollOpts {
	readonly intervalMs: number;
	readonly timeoutMs: number;
	readonly label: string;
}

export async function pollUntil<T>(
	fn: () => Promise<T | undefined | null | false>,
	opts: PollOpts,
): Promise<T> {
	const deadline = Date.now() + opts.timeoutMs;
	let last: T | undefined | null | false;
	while (Date.now() < deadline) {
		last = await fn();
		if (last !== undefined && last !== null && last !== false) {
			return last as T;
		}
		await new Promise((r) => setTimeout(r, opts.intervalMs));
	}
	throw new Error(
		`pollUntil(${opts.label}) timed out after ${opts.timeoutMs}ms; last=${JSON.stringify(last)}`,
	);
}

// ── Session seeding ────────────────────────────────────────────────────────

export interface SeedSessionResult {
	readonly session_id: string;
	readonly user_id: string;
}

/**
 * Ask the dev backend to mint a valid session row for `email` and return
 * the session ID. The spec drops it into the browser cookie jar so the
 * page renders as an authenticated user without going through the
 * Telegram magic-link flow.
 */
export async function seedSession(
	api: APIRequestContext,
	email: string,
): Promise<SeedSessionResult> {
	const res = await api.post("/__test/v2/seed-session", {
		headers: { "content-type": "application/json" },
		data: { email },
	});
	if (!res.ok()) {
		throw new Error(`seedSession failed: ${res.status()} ${await res.text()}`);
	}
	return (await res.json()) as SeedSessionResult;
}

/**
 * Attach the seeded session cookie to a Playwright browser context so
 * the next navigation hits the app as the authenticated user.
 */
export async function attachSessionCookie(
	context: BrowserContext,
	sessionId: string,
	frontendBaseUrl: string = FRONTEND_BASE_URL,
): Promise<void> {
	const frontendUrl = new URL(frontendBaseUrl);
	await context.addCookies([
		{
			name: "tensol_session",
			value: sessionId,
			domain: frontendUrl.hostname,
			path: "/",
			httpOnly: true,
			secure: false,
			sameSite: "Lax",
		},
	]);
}

// ── Webhook signing ────────────────────────────────────────────────────────

/**
 * Build the `X-Tensol-Signature` header per webhook.md §"Signature header":
 *   `t=<unix-seconds>, v1=<hex(hmac_sha256(secret, "${t}.${body_bytes}"))>`
 */
export function signWebhookBody(
	secret: string,
	body: string,
	nowSec: number,
): string {
	const signedPayload = `${nowSec}.${body}`;
	const mac = createHmac("sha256", secret).update(signedPayload).digest("hex");
	return `t=${nowSec}, v1=${mac}`;
}

export function signGitHubWebhookBody(secret: string, body: string): string {
	const mac = createHmac("sha256", secret).update(body).digest("hex");
	return `sha256=${mac}`;
}

/**
 * Replay the Juice Shop fixture into the webhook endpoint with the
 * scan_order_id rewritten to the live order. Returns the parsed response.
 */
export async function simulateScanComplete(
	backend: APIRequestContext,
	scanOrderId: string,
): Promise<{ ok: boolean; inserted_findings: number }> {
	const fixtureRaw = readFileSync(JUICESHOP_FIXTURE_PATH, "utf8");
	const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;
	// Rewrite scan_order_id + completed_at to match the live order + now().
	const body = {
		...fixture,
		scan_order_id: scanOrderId,
		completed_at: Date.now(),
	};
	const rawBody = JSON.stringify(body);
	const nowSec = Math.floor(Date.now() / 1000);
	const signature = signWebhookBody(E2E_WEBHOOK_SECRET, rawBody, nowSec);

	const res = await backend.post("/v1/webhooks/scan-complete", {
		headers: {
			"content-type": "application/json",
			"x-tensol-signature": signature,
		},
		data: rawBody,
	});
	if (!res.ok()) {
		throw new Error(`webhook POST failed: ${res.status()} ${await res.text()}`);
	}
	const json = (await res.json()) as {
		status?: string;
		findings_ingested?: number;
		ok?: boolean;
		inserted_findings?: number;
	};
	return {
		ok: json.ok ?? json.status === "ok",
		inserted_findings: json.inserted_findings ?? json.findings_ingested ?? 0,
	};
}

// ── T092 / T093 test-only endpoints ────────────────────────────────────────

/**
 * T092 — Mark `users.free_quick_consumed_at = now()` so the next call
 * to `launchScan(userId, orderId)` throws `QUOTA_EXHAUSTED` (→ 429 at
 * the route layer per `server/src/scan-orders/service.ts` line 488).
 *
 * Endpoint: `POST /__test/v2/exhaust-quota`
 *   request:  { user_id: string }
 *   response: { ok: true, free_quick_consumed_at: number }
 */
export async function exhaustFreeQuota(
	api: APIRequestContext,
	userId: string,
): Promise<{ ok: true; free_quick_consumed_at: number }> {
	const res = await api.post("/__test/v2/exhaust-quota", {
		headers: { "content-type": "application/json" },
		data: { user_id: userId },
	});
	if (!res.ok()) {
		throw new Error(
			`exhaustFreeQuota failed: ${res.status()} ${await res.text()}`,
		);
	}
	return (await res.json()) as {
		ok: true;
		free_quick_consumed_at: number;
	};
}

/**
 * T093 — Backdate `scan_orders.dns_verify_requested_at` to ≥31 min ago
 * so the next `checkVerification` call trips the 30-min hard cap and
 * emits a signed `dns_verify_failed` audit
 * (`server/src/dns-verify/service.ts` lines 188-211).
 *
 * Endpoint: `POST /__test/v2/expire-dns-verify`
 *   request:  { order_id: string }
 *   response: { ok: true, dns_verify_requested_at: number }
 */
export async function expireDnsVerify(
	api: APIRequestContext,
	orderId: string,
): Promise<{ ok: true; dns_verify_requested_at: number }> {
	const res = await api.post("/__test/v2/expire-dns-verify", {
		headers: { "content-type": "application/json" },
		data: { order_id: orderId },
	});
	if (!res.ok()) {
		throw new Error(
			`expireDnsVerify failed: ${res.status()} ${await res.text()}`,
		);
	}
	return (await res.json()) as {
		ok: true;
		dns_verify_requested_at: number;
	};
}

/**
 * T093 — Shortcut: create a `scan_orders` row already in `dns_pending`
 * with the provided primary_domain. Skips wizard steps 1 + 2.
 *
 * Endpoint: `POST /__test/v2/create-dns-pending`
 *   request:  { user_id: string, primary_domain: string }
 *   response: { order_id: string, dns_token: string }
 */
export async function createDnsPendingOrder(
	api: APIRequestContext,
	userId: string,
	primaryDomain: string,
): Promise<{ order_id: string; dns_token: string }> {
	const res = await api.post("/__test/v2/create-dns-pending", {
		headers: { "content-type": "application/json" },
		data: { user_id: userId, primary_domain: primaryDomain },
	});
	if (!res.ok()) {
		throw new Error(
			`createDnsPendingOrder failed: ${res.status()} ${await res.text()}`,
		);
	}
	return (await res.json()) as {
		order_id: string;
		dns_token: string;
	};
}

/**
 * T092 — Shortcut: create a `scan_orders` row already in `dns_verified`
 * so the spec can jump straight to step 4 / launch without walking the
 * wizard. Mirrors `createDnsPendingOrder` but flips the status flag.
 *
 * Endpoint: `POST /__test/v2/create-dns-verified`
 *   request:  { user_id: string, primary_domain: string, rps?: number }
 *   response: { order_id: string }
 */
export async function createDnsVerifiedOrder(
	api: APIRequestContext,
	userId: string,
	primaryDomain: string,
	rps = 10,
): Promise<{ order_id: string }> {
	const res = await api.post("/__test/v2/create-dns-verified", {
		headers: { "content-type": "application/json" },
		data: { user_id: userId, primary_domain: primaryDomain, rps },
	});
	if (!res.ok()) {
		throw new Error(
			`createDnsVerifiedOrder failed: ${res.status()} ${await res.text()}`,
		);
	}
	return (await res.json()) as { order_id: string };
}

// ── T120 test-only endpoints ───────────────────────────────────────────────

export type SeedReportStatus = "pending" | "rendering" | "ready" | "failed";

export interface SeedCompletedScanInput {
	readonly userId: string;
	readonly primaryDomain?: string;
	readonly findingsCount?: number;
	readonly reportStatus?: SeedReportStatus;
}

export interface SeedCompletedScanResult {
	readonly order_id: string;
	readonly scan_id: string;
	readonly report_id: string;
}

/**
 * T120 — Seed a complete past-scan history row for the given user.
 *
 * Inserts (atomically, server-side):
 *   - `scan_orders` row in `completed` with `payment_kind='free_quick'`
 *     and a `scan_id` link
 *   - sibling `scans` row in `completed`
 *   - `findings_count` rows (default 9 — matches Juice Shop fixture) on
 *     the `findings` table, severities cycled deterministically
 *   - `reports` row in `report_status` (default `ready`) with a stub
 *     `download_url` + `byte_size` + `download_expires_at` in the future
 *
 * Used by `history-redownload.spec.ts` to walk Dashboard → click row →
 * Findings → Report → expire URL → see "Regenerate" without waiting for
 * a real Decepticon scan.
 *
 * Endpoint: `POST /__test/v2/seed-completed-scan`
 *   request:  { user_id, primary_domain?, findings_count?, report_status? }
 *   response: { order_id, scan_id, report_id }
 */
export async function seedCompletedScan(
	api: APIRequestContext,
	input: SeedCompletedScanInput,
): Promise<SeedCompletedScanResult> {
	const res = await api.post("/__test/v2/seed-completed-scan", {
		headers: { "content-type": "application/json" },
		data: {
			user_id: input.userId,
			primary_domain: input.primaryDomain ?? "example.com",
			findings_count: input.findingsCount ?? 9,
			report_status: input.reportStatus ?? "ready",
		},
	});
	if (!res.ok()) {
		throw new Error(
			`seedCompletedScan failed: ${res.status()} ${await res.text()}`,
		);
	}
	return (await res.json()) as SeedCompletedScanResult;
}

/**
 * T120 — Backdate `reports.download_expires_at` to ≥1 hour ago so the
 * report client treats the URL as expired and surfaces the "Regenerate"
 * affordance on the next poll. We also flip `status` to `failed` because
 * the current `Reports.tsx` state machine (commit c7f3b3d) only shows
 * the regenerate CTA on `failed`; the equivalent expiry-aware UI is
 * tracked separately, so for now the test-only endpoint mirrors that
 * by setting `status='failed'` alongside the past `expires_at` so the
 * UI assertion is deterministic.
 *
 * Endpoint: `POST /__test/v2/expire-report`
 *   request:  { report_id: string }
 *   response: { ok: true, expires_at: number }
 */
export async function expireReport(
	api: APIRequestContext,
	reportId: string,
): Promise<{ ok: true; expires_at: number }> {
	const res = await api.post("/__test/v2/expire-report", {
		headers: { "content-type": "application/json" },
		data: { report_id: reportId },
	});
	if (!res.ok()) {
		throw new Error(`expireReport failed: ${res.status()} ${await res.text()}`);
	}
	return (await res.json()) as { ok: true; expires_at: number };
}

// ── Review / repository fixture endpoints ───────────────────────────────────

export interface SeedReviewRepoInput {
	readonly userId: string;
	readonly owner?: string;
	readonly name?: string;
	readonly installationId?: string;
	readonly enabled?: boolean;
	readonly coveredBranches?: string[];
	readonly statusCheckEnabled?: boolean;
	readonly mergeBlockOnCritical?: boolean;
}

export interface SeedReviewRepoResult {
	readonly installation_row_id: string;
	readonly installation_id: string;
	readonly repo_id: string;
	readonly owner: string;
	readonly name: string;
}

export async function seedReviewRepo(
	api: APIRequestContext,
	input: SeedReviewRepoInput,
): Promise<SeedReviewRepoResult> {
	const res = await api.post("/__test/v2/seed-review-repo", {
		headers: { "content-type": "application/json" },
		data: {
			user_id: input.userId,
			owner: input.owner,
			name: input.name,
			installation_id: input.installationId,
			enabled: input.enabled,
			covered_branches: input.coveredBranches,
			status_check_enabled: input.statusCheckEnabled,
			merge_block_on_critical: input.mergeBlockOnCritical,
		},
	});
	if (!res.ok()) {
		throw new Error(
			`seedReviewRepo failed: ${res.status()} ${await res.text()}`,
		);
	}
	return (await res.json()) as SeedReviewRepoResult;
}
