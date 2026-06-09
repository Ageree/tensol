import type { Database } from "bun:sqlite";
/**
 * T070 — Integration tests for `POST /v1/webhooks/scan-complete` (T069).
 *
 * Wire contract (verbatim from `specs/002-blackbox-mvp/contracts/webhook.md`):
 *
 *   POST /v1/webhooks/scan-complete
 *   Headers:
 *     Content-Type: application/json
 *     X-Tensol-Signature: t=<unix-seconds>, v1=<hex-hmac-sha256>
 *
 *   Where v1 = hex(hmac_sha256(secret, "${t}.${body_bytes}"))
 *
 * Validation order under test (must match webhook.md §"Validation order"):
 *   1. Signature header present + parseable     → 401 otherwise
 *   2. Timestamp within ±5min                   → 401 otherwise
 *   3. HMAC v1 matches                          → 401 otherwise
 *   4. Body parses as JSON                      → 422 otherwise
 *   5. WebhookScanCompleteBodySchema.parse      → 422 otherwise
 *   6. Existing idempotency row                 → 200 no-op duplicate
 *   7. Order ownership + state (running|vm_*)   → 404/409 otherwise
 *   8. Reserve idempotency row                  → 200 no-op on race
 *   9. Findings ingest + scan/order transitions → 200
 *  10. Enqueue render_pdf + send_telegram + teardown jobs
 *  11. webhook_received audit emitted AFTER commit
 *
 * Suite plan:
 *   - happy path with Juice Shop fixture: 9 findings + 3 jobs + state transitions
 *   - missing X-Tensol-Signature header → 401
 *   - malformed X-Tensol-Signature (no t=, no v1=) → 401
 *   - stale timestamp (>5min drift) → 401 + invalid-signature audit
 *   - wrong HMAC value → 401 + invalid-signature audit
 *   - malformed JSON body → 422
 *   - Zod validation failure (missing required scan_order_id) → 422
 *   - stale completed_at body timestamp → 422 before dedup/state mutation
 *   - replay (same scan_order_id, valid signature) → 200 no-op duplicate
 *
 * Each test rebuilds a fresh in-memory DB so order/scan rows can be seeded
 * deterministically — matches the pattern used by `scan-orders-routes.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { type DB, createDb } from "../../src/db/client.ts";
import {
	auditLog as auditLogTable,
	findings as findingsTable,
	jobs as jobsTable,
	reports as reportsTable,
	scanOrders as scanOrdersTable,
	scans as scansTable,
	users as usersTable,
	webhookDedup as webhookDedupTable,
} from "../../src/db/schema.ts";
import { refundFreeQuickQuota } from "../../src/free-tier/service.ts";
import { createWebhookScanCompleteRouter } from "../../src/routes/webhooks-scan-complete.ts";

// ---------------------------------------------------------------------------
// Test infra — fresh in-memory DB + all migrations applied
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY = "test-audit-signing-key-for-webhook-it-tests-only";
const WEBHOOK_SECRET = "webhook-test-secret-shared-with-fake-vps-agent";

const JUICE_SHOP_FIXTURE = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"..",
			"fixtures",
			"webhook-scan-complete-juiceshop.json",
		),
		"utf8",
	),
) as Record<string, unknown> & { scan_order_id: string; findings: unknown[] };

function must<T>(value: T | null | undefined, label: string): T {
	if (value == null) {
		throw new Error(`Expected ${label}`);
	}
	return value;
}

function migrationSql(): string {
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	return files
		.map((f) =>
			readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
				/-->\s*statement-breakpoint/g,
				"",
			),
		)
		.join("\n");
}

function freshMemDb(): DB {
	const db = createDb(":memory:");
	(db.$client as Database).exec(migrationSql());
	return db;
}

/** Seed a user, a scan_order in `running`, and a corresponding scan row whose
 *  ids match the Juice Shop fixture's scan_order_id. */
function seedRunningOrder(
	db: DB,
	scanOrderId: string,
	opts?: {
		nowMs?: number;
		status?:
			| "running"
			| "vm_provisioning"
			| "completed"
			| "cancelled"
			| "draft";
		vpsInstanceId?: string | null;
		vpsZone?: string | null;
		freeQuickConsumedAt?: number | null;
		freeQuickConsumedCount?: number;
	},
): { userId: string; scanId: string } {
	const now = opts?.nowMs ?? 1_716_113_000_000;
	const userId = "01JTESTUSER000000000000001"; // synthetic 26-char ULIDish
	const scanId = "01JTESTSCAN0000000000000001";

	db.insert(usersTable)
		.values({
			id: userId,
			email: `${userId}@test.local`,
			freeQuickConsumedAt: opts?.freeQuickConsumedAt ?? null,
			freeQuickConsumedCount: opts?.freeQuickConsumedCount ?? 0,
			createdAt: now,
		})
		.run();

	db.insert(scanOrdersTable)
		.values({
			id: scanOrderId,
			userId,
			status: opts?.status ?? "running",
			tier: "quick",
			primaryDomain: "juice-sh.op",
			attackSurfaceJson: "[]",
			safetyRps: 50,
			dnsVerifyToken: "dns-token-stub",
			dnsCheckAttempts: 0,
			vpsInstanceId: opts?.vpsInstanceId ?? "fake-vm-webhook-complete-1",
			vpsProvider: "gcp",
			vpsZone: opts?.vpsZone ?? "europe-west1-b",
			paymentKind: "free_quick",
			scanId,
			createdAt: now,
			updatedAt: now,
		})
		.run();

	db.insert(scansTable)
		.values({
			id: scanId,
			userId,
			scanOrderId,
			profile: "recon",
			status: "running",
			failureReason: null,
			startedAt: now,
			completedAt: null,
			usageTokens: null,
			usageUsdCents: null,
		})
		.run();

	return { userId, scanId };
}

// ---------------------------------------------------------------------------
// Signature helpers (mirrors what vps-agent does on the other side)
// ---------------------------------------------------------------------------

/** Build the canonical signing string per webhook.md: `${unix_seconds}.${body}`. */
function signedString(unixSeconds: number, body: string): string {
	return `${unixSeconds}.${body}`;
}

function hmacHex(secret: string, message: string): string {
	return createHmac("sha256", secret).update(message).digest("hex");
}

/** Build the X-Tensol-Signature header value: `t=<seconds>, v1=<hex>`. */
function buildSignatureHeader(
	secret: string,
	unixSeconds: number,
	body: string,
): string {
	const v1 = hmacHex(secret, signedString(unixSeconds, body));
	return `t=${unixSeconds}, v1=${v1}`;
}

interface BuildAppOpts {
	readonly db: DB;
	readonly now?: () => number;
	readonly webhookSecret?: string;
	readonly expectedEvidenceBucket?: string;
	readonly refundFreeQuickQuota?: (
		userId: string,
	) => Promise<{ refunded: boolean }>;
	readonly enqueueJob?: (
		kind: string,
		payload: Record<string, unknown>,
	) => Promise<string>;
}

/** Assemble a Hono app mounting the webhook router at `/v1/webhooks`. */
function buildApp(opts: BuildAppOpts): Hono {
	const app = new Hono();
	app.route(
		"/v1/webhooks",
		createWebhookScanCompleteRouter({
			db: opts.db,
			auditKey: SIGNING_KEY,
			webhookSecret: opts.webhookSecret ?? WEBHOOK_SECRET,
			...(opts.expectedEvidenceBucket
				? { expectedEvidenceBucket: opts.expectedEvidenceBucket }
				: {}),
			refundFreeQuickQuota:
				opts.refundFreeQuickQuota ??
				((userId) => refundFreeQuickQuota(opts.db, userId)),
			...(opts.now ? { now: opts.now } : {}),
		}),
	);
	return app;
}

/** Convenience: POST a signed webhook request and return the Response. */
async function postSigned(
	app: Hono,
	body: string,
	opts: {
		secret?: string;
		nowMs?: number;
		signatureHeader?: string; // override for malformed-header tests
	},
): Promise<Response> {
	const secret = opts.secret ?? WEBHOOK_SECRET;
	const nowMs = opts.nowMs ?? Date.now();
	const unixSeconds = Math.floor(nowMs / 1000);
	const header =
		opts.signatureHeader ?? buildSignatureHeader(secret, unixSeconds, body);
	return app.request("/v1/webhooks/scan-complete", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-tensol-signature": header,
		},
		body,
	});
}

// ---------------------------------------------------------------------------
// HAPPY PATH
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/scan-complete — happy path", () => {
	test("Juice Shop fixture: 9 findings ingested, state→completed, 3 jobs enqueued, webhook_received audit emitted", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000; // fixture completed_at = 1_716_114_000_000 (8.3min earlier — still in 24h freshness window)
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const app = buildApp({ db, now: () => fixedNow });
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);

		const res = await postSigned(app, body, { nowMs: fixedNow });

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			status: string;
			findings_ingested: number;
		};
		expect(json.status).toBe("ok");
		expect(json.findings_ingested).toBe(9);

		// 9 findings inserted, all linked to the same scan
		const findingRows = db
			.select()
			.from(findingsTable)
			.where(eq(findingsTable.scanId, "01JTESTSCAN0000000000000001"))
			.all();
		expect(findingRows.length).toBe(9);

		// scan_order → completed
		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("completed");

		// scan → completed (completedAt set)
		const scanRow = db
			.select()
			.from(scansTable)
			.where(eq(scansTable.id, "01JTESTSCAN0000000000000001"))
			.get();
		expect(scanRow?.status).toBe("completed");
		expect(scanRow?.completedAt).toBe(fixedNow);

		// 3 follow-up jobs enqueued
		const jobRows = db.select().from(jobsTable).all();
		const jobKinds = jobRows.map((j) => j.type).sort();
		expect(jobKinds).toEqual(
			["render_pdf", "send_scan_complete_telegram", "teardown_scan_vm"].sort(),
		);
		const reports = db
			.select()
			.from(reportsTable)
			.where(eq(reportsTable.scanId, "01JTESTSCAN0000000000000001"))
			.all();
		expect(reports.length).toBe(1);
		expect(reports[0]?.status).toBe("pending");
		const reportId = must(reports[0], "report row").id;

		const renderJob = jobRows.find((j) => j.type === "render_pdf");
		expect(renderJob).toBeDefined();
		expect(
			JSON.parse(must(renderJob, "render_pdf job").payloadJson),
		).toMatchObject({
			type: "render_pdf",
			scanId: "01JTESTSCAN0000000000000001",
			reportId,
		});

		const telegramJob = jobRows.find(
			(j) => j.type === "send_scan_complete_telegram",
		);
		expect(telegramJob).toBeDefined();
		expect(
			JSON.parse(
				must(telegramJob, "send_scan_complete_telegram job").payloadJson,
			),
		).toMatchObject({
			type: "send_scan_complete_telegram",
			scanId: "01JTESTSCAN0000000000000001",
			scanOrderId: JUICE_SHOP_FIXTURE.scan_order_id,
			reportId,
			userId: "01JTESTUSER000000000000001",
		});

		const teardownJob = jobRows.find((j) => j.type === "teardown_scan_vm");
		expect(teardownJob).toBeDefined();
		expect(
			JSON.parse(must(teardownJob, "teardown_scan_vm job").payloadJson),
		).toMatchObject({
			type: "teardown_scan_vm",
			scanId: "01JTESTSCAN0000000000000001",
			scanOrderId: JUICE_SHOP_FIXTURE.scan_order_id,
			vpsInstanceId: "fake-vm-webhook-complete-1",
			vpsZone: "europe-west1-b",
		});

		// webhook_received audit emitted exactly once for this scan_order_id
		const audits = db.select().from(auditLogTable).all();
		const received = audits.filter((a) => a.event === "webhook_received");
		expect(received.length).toBe(1);
		expect(received[0]?.outcome).toBe("success");
		expect(received[0]?.scanId).toBe("01JTESTSCAN0000000000000001");

		// 9 finding_ingested audits (one per finding)
		const ingestedAudits = audits.filter((a) => a.event === "finding_ingested");
		expect(ingestedAudits.length).toBe(9);
	});
});

describe("POST /v1/webhooks/scan-complete — failed terminal path", () => {
	test("status=failed marks scan/order failed, refunds free quota, records dedup/audit, and enqueues teardown only", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, {
			nowMs: fixedNow,
			vpsInstanceId: "fake-vm-webhook-failed-1",
			vpsZone: "europe-west1-b",
			freeQuickConsumedAt: fixedNow - 1_000,
			freeQuickConsumedCount: 1,
		});
		const app = buildApp({
			db,
			now: () => fixedNow,
			expectedEvidenceBucket: "tensol-evidence-prod",
		});
		const body = JSON.stringify({
			scan_order_id: JUICE_SHOP_FIXTURE.scan_order_id,
			status: "failed",
			failure_reason: "decepticon_failed: docker_exit_137",
			completed_at: fixedNow,
			duration_seconds: 17,
			findings: [],
		});

		const res = await postSigned(app, body, { nowMs: fixedNow });

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			status: string;
			scan_order_id: string;
			findings_ingested: number;
		};
		expect(json).toMatchObject({
			status: "failed",
			scan_order_id: JUICE_SHOP_FIXTURE.scan_order_id,
			findings_ingested: 0,
		});

		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("failed");
		expect(orderRow?.failureReason).toBe("decepticon_failed: docker_exit_137");

		const scanRow = db
			.select()
			.from(scansTable)
			.where(eq(scansTable.id, "01JTESTSCAN0000000000000001"))
			.get();
		expect(scanRow?.status).toBe("failed");
		expect(scanRow?.failureReason).toBe("decepticon_failed: docker_exit_137");
		expect(scanRow?.completedAt).toBe(fixedNow);

		const userRow = db
			.select()
			.from(usersTable)
			.where(eq(usersTable.id, "01JTESTUSER000000000000001"))
			.get();
		expect(userRow?.freeQuickConsumedAt).toBeNull();
		expect(userRow?.freeQuickConsumedCount).toBe(0);

		const jobRows = db.select().from(jobsTable).all();
		expect(jobRows).toHaveLength(1);
		expect(jobRows[0]?.type).toBe("teardown_scan_vm");
		expect(
			JSON.parse(must(jobRows[0], "failed teardown job").payloadJson),
		).toMatchObject({
			type: "teardown_scan_vm",
			scanId: "01JTESTSCAN0000000000000001",
			scanOrderId: JUICE_SHOP_FIXTURE.scan_order_id,
			vpsInstanceId: "fake-vm-webhook-failed-1",
			vpsZone: "europe-west1-b",
		});
		expect(db.select().from(reportsTable).all()).toHaveLength(0);
		expect(db.select().from(findingsTable).all()).toHaveLength(0);

		const dedupRows = db.select().from(webhookDedupTable).all();
		expect(dedupRows).toHaveLength(1);
		expect(
			JSON.parse(must(dedupRows[0], "dedup row").metadataJson ?? "{}"),
		).toMatchObject({
			terminal_status: "failed",
			failure_reason: "decepticon_failed: docker_exit_137",
		});

		const audits = db.select().from(auditLogTable).all();
		const failed = audits.filter((a) => a.event === "scan_failed");
		expect(failed).toHaveLength(1);
		expect(failed[0]?.outcome).toBe("failure");
		expect(
			JSON.parse(must(failed[0], "scan_failed audit").metadataJson),
		).toMatchObject({
			scan_order_id: JUICE_SHOP_FIXTURE.scan_order_id,
			failure_reason: "decepticon_failed: docker_exit_137",
		});
		const received = audits.filter((a) => a.event === "webhook_received");
		expect(received).toHaveLength(1);
		expect(received[0]?.outcome).toBe("failure");
		const refund = audits.filter((a) => a.event === "free_quota_refunded");
		expect(refund).toHaveLength(1);
		expect(refund[0]?.outcome).toBe("success");
		expect(
			JSON.parse(must(refund[0], "free_quota_refunded audit").metadataJson),
		).toMatchObject({
			scan_order_id: JUICE_SHOP_FIXTURE.scan_order_id,
			reason: "decepticon_failed: docker_exit_137",
		});
	});
});

// ---------------------------------------------------------------------------
// AUTH / SIGNATURE REJECTION
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/scan-complete — signature rejection (401)", () => {
	test("missing X-Tensol-Signature → 401, no audit (benign-probe path)", async () => {
		const db = freshMemDb();
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id);
		const app = buildApp({ db });
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);

		const res = await app.request("/v1/webhooks/scan-complete", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});

		expect(res.status).toBe(401);

		// No state change
		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("running");

		// Bare 401: no audit row — without a parseable timestamp we have no
		// useful signal to record (benign probe vs spoof attempt is
		// indistinguishable). Audits only emit for stale-ts and bad-HMAC paths.
		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "webhook_invalid_signature"))
			.all();
		expect(audits.length).toBe(0);
	});

	test("malformed signature header (no t=, no v1=) → 401", async () => {
		const db = freshMemDb();
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id);
		const app = buildApp({ db });
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);

		const res = await postSigned(app, body, {
			nowMs: Date.now(),
			signatureHeader: "garbage-not-a-real-signature",
		});

		expect(res.status).toBe(401);
	});

	test("malformed signature envelope values → 401 before audit/state mutation", async () => {
		const malformedHeaders = [
			`t=1716114500abc, v1=${"a".repeat(64)}`,
			"t=1716114500, v1=abc123",
		] as const;

		for (const signatureHeader of malformedHeaders) {
			const db = freshMemDb();
			seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id);
			const app = buildApp({ db });
			const body = JSON.stringify(JUICE_SHOP_FIXTURE);

			const res = await postSigned(app, body, {
				nowMs: Date.now(),
				signatureHeader,
			});

			expect(res.status).toBe(401);
			const orderRow = db
				.select()
				.from(scanOrdersTable)
				.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
				.get();
			expect(orderRow?.status).toBe("running");
			const audits = db
				.select()
				.from(auditLogTable)
				.where(eq(auditLogTable.event, "webhook_invalid_signature"))
				.all();
			expect(audits.length).toBe(0);
		}
	});

	test("stale timestamp (>5min drift) → 401 + invalid-signature audit", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_120_000_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const app = buildApp({ db, now: () => fixedNow });
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);

		// Sign with a timestamp 10 minutes in the past — well outside the ±5min window.
		const staleSeconds = Math.floor(fixedNow / 1000) - 10 * 60;
		const staleHeader = buildSignatureHeader(
			WEBHOOK_SECRET,
			staleSeconds,
			body,
		);

		const res = await app.request("/v1/webhooks/scan-complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-tensol-signature": staleHeader,
			},
			body,
		});

		expect(res.status).toBe(401);

		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("running");

		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "webhook_invalid_signature"))
			.all();
		expect(audits.length).toBe(1);
	});

	test("wrong HMAC value (correct timestamp, bad secret) → 401 + invalid-signature audit", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const app = buildApp({ db, now: () => fixedNow });
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);

		const res = await postSigned(app, body, {
			nowMs: fixedNow,
			secret: "wrong-secret-not-the-real-one",
		});

		expect(res.status).toBe(401);

		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("running");

		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "webhook_invalid_signature"))
			.all();
		expect(audits.length).toBe(1);

		// No findings ingested
		const findingRows = db.select().from(findingsTable).all();
		expect(findingRows.length).toBe(0);
	});

	test("empty configured webhook secret → 401 even when payload is signed with empty key", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const app = buildApp({
			db,
			now: () => fixedNow,
			webhookSecret: "",
		});
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);

		const res = await postSigned(app, body, {
			nowMs: fixedNow,
			secret: "",
		});

		expect(res.status).toBe(401);
		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("running");
		expect(db.select().from(webhookDedupTable).all().length).toBe(0);
		expect(db.select().from(findingsTable).all().length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// BODY VALIDATION (422)
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/scan-complete — body validation (422)", () => {
	test("malformed JSON body → 422", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const app = buildApp({ db, now: () => fixedNow });

		const malformedBody = "{this is not json";
		const res = await postSigned(app, malformedBody, { nowMs: fixedNow });

		expect(res.status).toBe(422);

		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("running");
	});

	test("missing required field (scan_order_id) → 422", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const app = buildApp({ db, now: () => fixedNow });

		// Strip scan_order_id from a copy of the fixture; everything else still valid.
		const { scan_order_id: _omit, ...rest } = JUICE_SHOP_FIXTURE as unknown as {
			scan_order_id: string;
			[k: string]: unknown;
		};
		const body = JSON.stringify(rest);

		const res = await postSigned(app, body, { nowMs: fixedNow });

		expect(res.status).toBe(422);

		// No state change
		const findingRows = db.select().from(findingsTable).all();
		expect(findingRows.length).toBe(0);
	});

	test("valid signed webhook with unexpected evidence bucket → 422 before dedup or state mutation", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const app = buildApp({
			db,
			now: () => fixedNow,
			expectedEvidenceBucket: "tensol-evidence-prod",
		});
		const body = JSON.stringify({
			...JUICE_SHOP_FIXTURE,
			evidence_archive_url:
				"s3://attacker-controlled-bucket/evidence/archive.tar.gz",
		});

		const res = await postSigned(app, body, { nowMs: fixedNow });

		expect(res.status).toBe(422);
		const json = (await res.json()) as { error: string; message: string };
		expect(json.error).toBe("webhook_body_invalid");
		expect(json.message).toContain("unexpected evidence bucket");

		const dedupRows = db.select().from(webhookDedupTable).all();
		expect(dedupRows.length).toBe(0);
		const findingRows = db.select().from(findingsTable).all();
		expect(findingRows.length).toBe(0);
		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("running");
	});

	test("completed_at older than 24h → 422 before dedup or state mutation", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const app = buildApp({ db, now: () => fixedNow });
		const body = JSON.stringify({
			...JUICE_SHOP_FIXTURE,
			completed_at: fixedNow - 24 * 60 * 60 * 1_000 - 1,
		});

		const res = await postSigned(app, body, { nowMs: fixedNow });

		expect(res.status).toBe(422);
		const json = (await res.json()) as { error: string; message: string };
		expect(json.error).toBe("webhook_body_invalid");
		expect(json.message).toContain("completed_at");
		expect(db.select().from(webhookDedupTable).all()).toHaveLength(0);
		expect(db.select().from(findingsTable).all()).toHaveLength(0);
		expect(db.select().from(jobsTable).all()).toHaveLength(0);
		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("running");
	});
});

// ---------------------------------------------------------------------------
// OWNERSHIP / STATE REJECTION — no dedup poisoning
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/scan-complete — ownership/state rejection", () => {
	test("unknown scan_order_id → 404 without reserving dedup key, so a later valid order can complete", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		const app = buildApp({ db, now: () => fixedNow });
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);

		const missing = await postSigned(app, body, { nowMs: fixedNow });

		expect(missing.status).toBe(404);
		expect(db.select().from(webhookDedupTable).all()).toHaveLength(0);
		expect(db.select().from(findingsTable).all()).toHaveLength(0);
		expect(db.select().from(jobsTable).all()).toHaveLength(0);

		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const retry = await postSigned(app, body, { nowMs: fixedNow });

		expect(retry.status).toBe(200);
		const json = (await retry.json()) as { status: string };
		expect(json.status).toBe("ok");
		expect(db.select().from(webhookDedupTable).all()).toHaveLength(1);
	});

	test("wrong order state → 409 without reserving dedup key, so the order can recover to running", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, {
			nowMs: fixedNow,
			status: "draft",
		});
		const app = buildApp({ db, now: () => fixedNow });
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);

		const rejected = await postSigned(app, body, { nowMs: fixedNow });

		expect(rejected.status).toBe(409);
		expect(db.select().from(webhookDedupTable).all()).toHaveLength(0);
		expect(db.select().from(findingsTable).all()).toHaveLength(0);
		expect(db.select().from(jobsTable).all()).toHaveLength(0);

		db.update(scanOrdersTable)
			.set({ status: "running", updatedAt: fixedNow + 1 })
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.run();
		const retry = await postSigned(app, body, { nowMs: fixedNow });

		expect(retry.status).toBe(200);
		const json = (await retry.json()) as { status: string };
		expect(json.status).toBe("ok");
		expect(db.select().from(webhookDedupTable).all()).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// IDEMPOTENCY (replay) — 200 no-op
// ---------------------------------------------------------------------------

describe("POST /v1/webhooks/scan-complete — idempotency", () => {
	test("replay same scan_order_id → 200 duplicate no-op (9 findings still, 3 jobs still)", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });
		const app = buildApp({ db, now: () => fixedNow });
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);

		const first = await postSigned(app, body, { nowMs: fixedNow });
		expect(first.status).toBe(200);

		// Second delivery with identical signature + body.
		const second = await postSigned(app, body, { nowMs: fixedNow });
		expect(second.status).toBe(200);
		const json = (await second.json()) as { status: string };
		expect(json.status).toBe("duplicate");

		// Still 9 findings, not 18.
		const findingRows = db.select().from(findingsTable).all();
		expect(findingRows.length).toBe(9);

		// Still 3 jobs, not 6.
		const jobRows = db.select().from(jobsTable).all();
		expect(jobRows.length).toBe(3);
		const reportRows = db.select().from(reportsTable).all();
		expect(reportRows.length).toBe(1);

		// Still exactly one webhook_received audit.
		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "webhook_received"))
			.all();
		expect(audits.length).toBe(1);

		// Step-6c contract: dedup is now backed by webhook_dedup table, NOT a
		// LIKE-scan over audit_log. Exactly one row must exist for this key.
		const dedupRows = db.select().from(webhookDedupTable).all();
		expect(dedupRows.length).toBe(1);
		expect(dedupRows[0]?.webhookKind).toBe("scan_complete");
		expect(dedupRows[0]?.dedupKey).toBe(JUICE_SHOP_FIXTURE.scan_order_id);
		expect(dedupRows[0]?.receivedAt).toBe(fixedNow);
	});

	test("pre-existing webhook_dedup row → 200 duplicate even without prior webhook_received audit", async () => {
		// Constructs the post-step-6c short-circuit: a webhook_dedup row alone
		// is enough to short-circuit a delivery to 200 duplicate. Proves the
		// dedup decision is decoupled from audit_log (previously the only
		// signal — see migration 0011 rationale).
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		seedRunningOrder(db, JUICE_SHOP_FIXTURE.scan_order_id, { nowMs: fixedNow });

		// Seed the dedup row manually — no findings, no audit_log mutation.
		db.insert(webhookDedupTable)
			.values({
				id: "01JTESTWDEDUP00000000000001",
				webhookKind: "scan_complete",
				dedupKey: JUICE_SHOP_FIXTURE.scan_order_id,
				receivedAt: fixedNow - 10_000,
				metadataJson: null,
			})
			.run();

		const app = buildApp({ db, now: () => fixedNow });
		const body = JSON.stringify(JUICE_SHOP_FIXTURE);
		const res = await postSigned(app, body, { nowMs: fixedNow });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { status: string };
		expect(json.status).toBe("duplicate");

		// Crucially: zero findings ingested, zero jobs enqueued, no state change.
		expect(db.select().from(findingsTable).all().length).toBe(0);
		expect(db.select().from(jobsTable).all().length).toBe(0);
		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, JUICE_SHOP_FIXTURE.scan_order_id))
			.get();
		expect(orderRow?.status).toBe("running"); // untouched
		// No webhook_received audit either — short-circuit precedes step 10.
		const receivedAudits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "webhook_received"))
			.all();
		expect(receivedAudits.length).toBe(0);
	});

	test("different scan_order_ids → both succeed (UNIQUE key is per-(kind, key))", async () => {
		const db = freshMemDb();
		const fixedNow = 1_716_114_500_000;
		const orderIdA = JUICE_SHOP_FIXTURE.scan_order_id; // from fixture
		// Crockford ULID — 26 chars, must NOT contain I/L/O/U.
		const orderIdB = "01JTESTRDER0000000000000B2";

		// Seed both orders + scans. The fixture body will be re-stamped to
		// point at orderIdB on the second call.
		seedRunningOrder(db, orderIdA, { nowMs: fixedNow });

		// Build a second order with a distinct scanId so the FKs don't collide.
		const userIdB = "01JTESTUSER000000000000002";
		const scanIdB = "01JTESTSCAN0000000000000002";
		db.insert(usersTable)
			.values({
				id: userIdB,
				email: `${userIdB}@test.local`,
				createdAt: fixedNow,
			})
			.run();
		db.insert(scanOrdersTable)
			.values({
				id: orderIdB,
				userId: userIdB,
				status: "running",
				tier: "quick",
				primaryDomain: "juice-sh.op",
				attackSurfaceJson: "[]",
				safetyRps: 50,
				dnsVerifyToken: "dns-token-stub-b",
				dnsCheckAttempts: 0,
				vpsInstanceId: "fake-vm-webhook-complete-2",
				vpsProvider: "gcp",
				vpsZone: "europe-west1-b",
				paymentKind: "free_quick",
				scanId: scanIdB,
				createdAt: fixedNow,
				updatedAt: fixedNow,
			})
			.run();
		db.insert(scansTable)
			.values({
				id: scanIdB,
				userId: userIdB,
				scanOrderId: orderIdB,
				profile: "recon",
				status: "running",
				failureReason: null,
				startedAt: fixedNow,
				completedAt: null,
				usageTokens: null,
				usageUsdCents: null,
			})
			.run();

		const app = buildApp({ db, now: () => fixedNow });

		// First delivery (orderIdA)
		const bodyA = JSON.stringify(JUICE_SHOP_FIXTURE);
		const resA = await postSigned(app, bodyA, { nowMs: fixedNow });
		expect(resA.status).toBe(200);
		const jsonA = (await resA.json()) as { status: string };
		expect(jsonA.status).toBe("ok");

		// Second delivery for a DIFFERENT scan_order_id — must succeed (no
		// dedup collision because the UNIQUE is on (kind, key)).
		const fixtureB = { ...JUICE_SHOP_FIXTURE, scan_order_id: orderIdB };
		const bodyB = JSON.stringify(fixtureB);
		const resB = await postSigned(app, bodyB, { nowMs: fixedNow });
		expect(resB.status).toBe(200);
		const jsonB = (await resB.json()) as { status: string };
		expect(jsonB.status).toBe("ok");

		// Two dedup rows, one per order.
		const dedupRows = db.select().from(webhookDedupTable).all();
		expect(dedupRows.length).toBe(2);
		const keys = dedupRows.map((r) => r.dedupKey).sort();
		expect(keys).toEqual([orderIdA, orderIdB].sort());
	});
});
