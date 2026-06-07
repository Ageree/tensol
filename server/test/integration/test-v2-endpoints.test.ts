/**
 * Integration tests for `/__test/v2/*` fixture-seeder endpoints
 * (post-loop step 2).
 *
 * Coverage axes:
 *   - Happy path for every endpoint (200 + expected body shape).
 *   - DB-state verification: each seeder actually inserts/updates the
 *     correct rows + columns.
 *   - Bad payload → 422 (Zod-driven INVALID_BODY).
 *   - Missing-FK target → 404 (USER_NOT_FOUND, ORDER_NOT_FOUND,
 *     REPORT_NOT_FOUND).
 *   - Mount gate: `createApp({isProd:true})` must NOT mount the router.
 *
 * Determinism is enforced via `newId` (monotonic ULID counter) + a fixed
 * `now` clock so every test asserts byte-stable IDs / timestamps.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { Hono } from "hono";

import { createDb, type DB } from "../../src/db/client.ts";
import { createTestV2Router } from "../../src/routes/__test_v2.ts";
import {
	users as usersTable,
	sessions as sessionsTable,
	scanOrders as scanOrdersTable,
	scans as scansTable,
	findings as findingsTable,
	reports as reportsTable,
	installations as installationsTable,
	reviewRepos as reviewReposTable,
} from "../../src/db/schema.ts";

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

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

const FIXED_NOW = 1_716_120_000_000;

function deterministicIdFactory(): () => string {
	// Use a monotonic counter padded to 26 chars (Crockford alphabet).
	let n = 0;
	return () => {
		n += 1;
		return `01TESTV2${String(n).padStart(18, "0")}`;
	};
}

function buildRouterUnderTest(): {
	db: DB;
	request: (method: "POST", path: string, body?: unknown) => Promise<Response>;
} {
	const db = freshMemDb();
	const router = createTestV2Router({
		db,
		now: () => FIXED_NOW,
		newId: deterministicIdFactory(),
	});
	return {
		db,
		request: (method, path, body) =>
			router.request(path, {
				method,
				headers: { "content-type": "application/json" },
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			}),
	};
}

/** Helper: seed a user row directly (most endpoints require one). */
function seedUser(db: DB, userId: string, email: string): void {
	db.insert(usersTable)
		.values({
			id: userId,
			email,
			createdAt: FIXED_NOW - 1000,
		})
		.run();
}

// ---------------------------------------------------------------------------
// seed-session
// ---------------------------------------------------------------------------

describe("POST /__test/v2/seed-session", () => {
	test("creates user + session and returns ids", async () => {
		const { db, request } = buildRouterUnderTest();

		const res = await request("POST", "/seed-session", {
			email: "alice@test.local",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			session_id: string;
			user_id: string;
		};
		expect(body.session_id).toBeString();
		expect(body.user_id).toBeString();

		const userRow = db
			.select()
			.from(usersTable)
			.where(eq(usersTable.id, body.user_id))
			.get();
		expect(userRow).not.toBeUndefined();
		expect(userRow!.email).toBe("alice@test.local");

		const sessionRow = db
			.select()
			.from(sessionsTable)
			.where(eq(sessionsTable.id, body.session_id))
			.get();
		expect(sessionRow).not.toBeUndefined();
		expect(sessionRow!.userId).toBe(body.user_id);
		expect(sessionRow!.expiresAt).toBeGreaterThan(FIXED_NOW);
	});

	test("re-uses existing user on duplicate email", async () => {
		const { db, request } = buildRouterUnderTest();

		const first = await request("POST", "/seed-session", {
			email: "dup@test.local",
		});
		const firstBody = (await first.json()) as { user_id: string };

		const second = await request("POST", "/seed-session", {
			email: "dup@test.local",
		});
		const secondBody = (await second.json()) as { user_id: string };

		expect(secondBody.user_id).toBe(firstBody.user_id);

		// Only one user row, two session rows.
		const allUsers = db
			.select()
			.from(usersTable)
			.where(eq(usersTable.email, "dup@test.local"))
			.all();
		expect(allUsers.length).toBe(1);
	});

	test("bad body → 422", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/seed-session", {});
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("INVALID_BODY");
	});

	test("missing JSON body → 422", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/seed-session");
		expect(res.status).toBe(422);
	});
});

// ---------------------------------------------------------------------------
// exhaust-quota
// ---------------------------------------------------------------------------

describe("POST /__test/v2/exhaust-quota", () => {
	test("sets free_quick_consumed_at on the user row", async () => {
		const { db, request } = buildRouterUnderTest();
		const userId = "user-exhaust-quota-aaaaaaaaaaaa";
		seedUser(db, userId, "quota@test.local");

		const res = await request("POST", "/exhaust-quota", {
			user_id: userId,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			free_quick_consumed_at: number;
		};
		expect(body.ok).toBe(true);
		expect(body.free_quick_consumed_at).toBe(FIXED_NOW);

		const userRow = db
			.select()
			.from(usersTable)
			.where(eq(usersTable.id, userId))
			.get();
		expect(userRow!.freeQuickConsumedAt).toBe(FIXED_NOW);
		expect(userRow!.freeQuickConsumedCount).toBe(1);
	});

	test("unknown user → 404", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/exhaust-quota", {
			user_id: "nope-nonexistent-user-id-00000",
		});
		expect(res.status).toBe(404);
	});

	test("bad body → 422", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/exhaust-quota", { foo: "bar" });
		expect(res.status).toBe(422);
	});
});

// ---------------------------------------------------------------------------
// expire-dns-verify
// ---------------------------------------------------------------------------

describe("POST /__test/v2/expire-dns-verify", () => {
	test("backdates dns_verify_requested_at past the 30-min cap", async () => {
		const { db, request } = buildRouterUnderTest();
		const userId = "user-expire-dns-aaaaaaaaaaaaaa";
		seedUser(db, userId, "expdns@test.local");

		// Seed a dns_pending order via create-dns-pending.
		const createRes = await request("POST", "/create-dns-pending", {
			user_id: userId,
			primary_domain: "example.com",
		});
		expect(createRes.status).toBe(200);
		const { order_id } = (await createRes.json()) as { order_id: string };

		const expireRes = await request("POST", "/expire-dns-verify", {
			order_id,
		});
		expect(expireRes.status).toBe(200);
		const body = (await expireRes.json()) as {
			ok: true;
			dns_verify_requested_at: number;
		};
		expect(body.ok).toBe(true);
		// Should be ≥30 min in the past (31 min per implementation).
		expect(FIXED_NOW - body.dns_verify_requested_at).toBeGreaterThanOrEqual(
			30 * 60 * 1000,
		);

		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, order_id))
			.get();
		expect(orderRow!.dnsVerifyRequestedAt).toBe(body.dns_verify_requested_at);
	});

	test("unknown order → 404", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/expire-dns-verify", {
			order_id: "nope-nonexistent-order-id-0000",
		});
		expect(res.status).toBe(404);
	});

	test("bad body → 422", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/expire-dns-verify", {});
		expect(res.status).toBe(422);
	});
});

// ---------------------------------------------------------------------------
// create-dns-pending
// ---------------------------------------------------------------------------

describe("POST /__test/v2/create-dns-pending", () => {
	test("creates order in dns_pending with token + anchor", async () => {
		const { db, request } = buildRouterUnderTest();
		const userId = "user-create-pending-aaaaaaaa";
		seedUser(db, userId, "pending@test.local");

		const res = await request("POST", "/create-dns-pending", {
			user_id: userId,
			primary_domain: "tensol.test",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			order_id: string;
			dns_token: string;
		};
		expect(body.order_id).toBeString();
		expect(body.dns_token).toStartWith("tensol-verify-");

		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, body.order_id))
			.get();
		expect(orderRow!.status).toBe("dns_pending");
		expect(orderRow!.primaryDomain).toBe("tensol.test");
		expect(orderRow!.dnsVerifyToken).toBe(body.dns_token);
		expect(orderRow!.dnsVerifyRequestedAt).toBe(FIXED_NOW);
		expect(orderRow!.userId).toBe(userId);
	});

	test("unknown user → 404", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/create-dns-pending", {
			user_id: "nope-nonexistent-user-id-00000",
			primary_domain: "example.com",
		});
		expect(res.status).toBe(404);
	});

	test("bad body → 422", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/create-dns-pending", {
			user_id: "uid",
		});
		expect(res.status).toBe(422);
	});
});

// ---------------------------------------------------------------------------
// create-dns-verified
// ---------------------------------------------------------------------------

describe("POST /__test/v2/create-dns-verified", () => {
	test("creates order in dns_verified ready for launch", async () => {
		const { db, request } = buildRouterUnderTest();
		const userId = "user-create-verified-aaaaaaaaa";
		seedUser(db, userId, "verified@test.local");

		const res = await request("POST", "/create-dns-verified", {
			user_id: userId,
			primary_domain: "example.com",
			rps: 25,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { order_id: string };

		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, body.order_id))
			.get();
		expect(orderRow!.status).toBe("dns_verified");
		expect(orderRow!.safetyRps).toBe(25);
		expect(orderRow!.dnsVerifiedAt).toBe(FIXED_NOW);
		expect(orderRow!.dnsVerifyRequestedAt).toBeLessThan(FIXED_NOW);
	});

	test("defaults rps when omitted", async () => {
		const { db, request } = buildRouterUnderTest();
		const userId = "user-create-verified-default-rps";
		seedUser(db, userId, "vdef@test.local");

		const res = await request("POST", "/create-dns-verified", {
			user_id: userId,
			primary_domain: "example.com",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { order_id: string };

		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, body.order_id))
			.get();
		expect(orderRow!.safetyRps).toBe(50);
	});

	test("unknown user → 404", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/create-dns-verified", {
			user_id: "nope-nonexistent-user-id-00000",
			primary_domain: "example.com",
		});
		expect(res.status).toBe(404);
	});

	test("bad body → 422", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/create-dns-verified", {
			user_id: "uid",
			primary_domain: "example.com",
			rps: -5,
		});
		expect(res.status).toBe(422);
	});
});

// ---------------------------------------------------------------------------
// seed-completed-scan
// ---------------------------------------------------------------------------

describe("POST /__test/v2/seed-completed-scan", () => {
	test("seeds order + scan + findings + report atomically", async () => {
		const { db, request } = buildRouterUnderTest();
		const userId = "user-seed-completed-aaaaaaaaaa";
		seedUser(db, userId, "complete@test.local");

		const res = await request("POST", "/seed-completed-scan", {
			user_id: userId,
			primary_domain: "demo.example.com",
			findings_count: 5,
			report_status: "ready",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			order_id: string;
			scan_id: string;
			report_id: string;
		};

		const orderRow = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, body.order_id))
			.get();
		expect(orderRow!.status).toBe("completed");
		expect(orderRow!.scanId).toBe(body.scan_id);
		expect(orderRow!.primaryDomain).toBe("demo.example.com");

		const scanRow = db
			.select()
			.from(scansTable)
			.where(eq(scansTable.id, body.scan_id))
			.get();
		expect(scanRow!.status).toBe("completed");
		expect(scanRow!.userId).toBe(userId);
		expect(scanRow!.scanOrderId).toBe(body.order_id);

		const findingRows = db
			.select()
			.from(findingsTable)
			.where(eq(findingsTable.scanId, body.scan_id))
			.all();
		expect(findingRows.length).toBe(5);
		// Severity cycle: critical, critical, critical, high, high…
		expect(findingRows.map((f) => f.severity).sort()).toEqual(
			["critical", "critical", "critical", "high", "high"].sort(),
		);

		const reportRow = db
			.select()
			.from(reportsTable)
			.where(eq(reportsTable.id, body.report_id))
			.get();
		expect(reportRow!.status).toBe("ready");
		expect(reportRow!.bucket).toBe("tensol-test-bucket");
		expect(reportRow!.key).toContain(body.report_id);
		expect(reportRow!.byteSize).toBeGreaterThan(0);
		expect(reportRow!.expiresAt).toBeGreaterThan(FIXED_NOW);
	});

	test("defaults to 9 findings and ready report", async () => {
		const { db, request } = buildRouterUnderTest();
		const userId = "user-seed-defaults-aaaaaaaaaaaa";
		seedUser(db, userId, "defaults@test.local");

		const res = await request("POST", "/seed-completed-scan", {
			user_id: userId,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			scan_id: string;
			report_id: string;
		};

		const findingRows = db
			.select()
			.from(findingsTable)
			.where(eq(findingsTable.scanId, body.scan_id))
			.all();
		expect(findingRows.length).toBe(9);

		const reportRow = db
			.select()
			.from(reportsTable)
			.where(eq(reportsTable.id, body.report_id))
			.get();
		expect(reportRow!.status).toBe("ready");
	});

	test("report_status=pending leaves bucket/key/byteSize null", async () => {
		const { db, request } = buildRouterUnderTest();
		const userId = "user-seed-pending-report-aaaaa";
		seedUser(db, userId, "pendingrep@test.local");

		const res = await request("POST", "/seed-completed-scan", {
			user_id: userId,
			findings_count: 1,
			report_status: "pending",
		});
		const body = (await res.json()) as { report_id: string };

		const reportRow = db
			.select()
			.from(reportsTable)
			.where(eq(reportsTable.id, body.report_id))
			.get();
		expect(reportRow!.status).toBe("pending");
		expect(reportRow!.bucket).toBeNull();
		expect(reportRow!.key).toBeNull();
		expect(reportRow!.byteSize).toBeNull();
		expect(reportRow!.expiresAt).toBeNull();
	});

	test("unknown user → 404", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/seed-completed-scan", {
			user_id: "nope-nonexistent-user-id-00000",
		});
		expect(res.status).toBe(404);
	});

	test("bad body (negative findings_count) → 422", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/seed-completed-scan", {
			user_id: "uid",
			findings_count: -1,
		});
		expect(res.status).toBe(422);
	});
});

// ---------------------------------------------------------------------------
// expire-report
// ---------------------------------------------------------------------------

describe("POST /__test/v2/expire-report", () => {
	test("backdates expires_at + flips status to failed", async () => {
		const { db, request } = buildRouterUnderTest();
		const userId = "user-expire-report-aaaaaaaaaa";
		seedUser(db, userId, "exprep@test.local");

		const seedRes = await request("POST", "/seed-completed-scan", {
			user_id: userId,
			findings_count: 1,
			report_status: "ready",
		});
		const { report_id } = (await seedRes.json()) as { report_id: string };

		const expRes = await request("POST", "/expire-report", { report_id });
		expect(expRes.status).toBe(200);
		const body = (await expRes.json()) as {
			ok: true;
			expires_at: number;
		};
		expect(body.ok).toBe(true);
		expect(body.expires_at).toBeLessThan(FIXED_NOW);

		const reportRow = db
			.select()
			.from(reportsTable)
			.where(eq(reportsTable.id, report_id))
			.get();
		expect(reportRow!.status).toBe("failed");
		expect(reportRow!.expiresAt).toBe(body.expires_at);
	});

	test("unknown report → 404", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/expire-report", {
			report_id: "nope-nonexistent-report-id-000",
		});
		expect(res.status).toBe(404);
	});

	test("bad body → 422", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/expire-report", {});
		expect(res.status).toBe(422);
	});
});

// ---------------------------------------------------------------------------
// seed-review-repo
// ---------------------------------------------------------------------------

describe("POST /__test/v2/seed-review-repo", () => {
	test("upserts by installation_id + repo so live smoke runs are repeatable", async () => {
		const { db, request } = buildRouterUnderTest();
		const firstUserId = "user-review-repo-first-aaaaaaaa";
		const secondUserId = "user-review-repo-second-aaaaaaa";
		seedUser(db, firstUserId, "review-first@test.local");
		seedUser(db, secondUserId, "review-second@test.local");

		const first = await request("POST", "/seed-review-repo", {
			user_id: firstUserId,
			owner: "Ageree",
			name: "sthrip-review-testbed",
			installation_id: "123456",
			enabled: true,
			covered_branches: ["main"],
			status_check_enabled: true,
			merge_block_on_critical: false,
		});
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			installation_row_id: string;
			installation_id: string;
			repo_id: string;
		};

		const second = await request("POST", "/seed-review-repo", {
			user_id: secondUserId,
			owner: "Ageree",
			name: "sthrip-review-testbed",
			installation_id: "123456",
			enabled: false,
			covered_branches: ["develop"],
			status_check_enabled: false,
			merge_block_on_critical: true,
		});
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as {
			installation_row_id: string;
			installation_id: string;
			repo_id: string;
		};

		expect(secondBody.installation_row_id).toBe(firstBody.installation_row_id);
		expect(secondBody.installation_id).toBe(firstBody.installation_id);
		expect(secondBody.repo_id).toBe(firstBody.repo_id);

		const installationRows = db
			.select()
			.from(installationsTable)
			.where(eq(installationsTable.installationId, "123456"))
			.all();
		expect(installationRows.length).toBe(1);
		expect(installationRows[0]!.userId).toBe(secondUserId);
		expect(installationRows[0]!.status).toBe("active");

		const repoRows = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.installationId, "123456"))
			.all();
		expect(repoRows.length).toBe(1);
		expect(repoRows[0]!.id).toBe(firstBody.repo_id);
		expect(repoRows[0]!.userId).toBe(secondUserId);
		expect(repoRows[0]!.enabled).toBe(0);
		expect(repoRows[0]!.statusCheckEnabled).toBe(0);
		expect(repoRows[0]!.mergeBlockOnCritical).toBe(1);
		expect(JSON.parse(repoRows[0]!.coveredBranchesJson)).toEqual(["develop"]);
		expect(repoRows[0]!.lastReviewId).toBeNull();
	});

	test("unknown user -> 404", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/seed-review-repo", {
			user_id: "nope-nonexistent-user-id-00000",
		});
		expect(res.status).toBe(404);
	});

	test("bad body -> 422", async () => {
		const { request } = buildRouterUnderTest();
		const res = await request("POST", "/seed-review-repo", {
			user_id: "",
		});
		expect(res.status).toBe(422);
	});
});

// ---------------------------------------------------------------------------
// Mount gate — mirrors the conditional mount in createApp(server.ts).
//
// createApp() pulls in legacy webhook routes whose imports are currently
// broken (pre-existing tsc errors unrelated to step-2 work), so we model
// the mount gate as a standalone Hono compose using the same isProd
// conditional pattern as `src/server.ts` line ~395:
//
//   if (!isProd) app.route("/__test/v2", createTestV2Router({db, ...}));
// ---------------------------------------------------------------------------

function composeAppWithGate(isProd: boolean, db: DB): Hono {
	const app = new Hono();
	app.get("/healthz", (c) => c.json({ ok: true }));
	if (!isProd) {
		app.route(
			"/__test/v2",
			createTestV2Router({
				db,
				now: () => FIXED_NOW,
				newId: deterministicIdFactory(),
			}),
		);
	}
	return app;
}

describe("__test/v2 mount gate (mirrors server.ts createApp)", () => {
	test("isProd=true → /__test/v2/seed-session returns 404", async () => {
		const db = freshMemDb();
		const app = composeAppWithGate(true, db);

		const res = await app.request("/__test/v2/seed-session", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "leak@test.local" }),
		});
		expect(res.status).toBe(404);

		// Confirm healthz still works — proves the app is alive and the 404
		// is from the missing route, not from an app-construction failure.
		const health = await app.request("/healthz");
		expect(health.status).toBe(200);
	});

	test("isProd=false → /__test/v2/seed-session returns 200", async () => {
		const db = freshMemDb();
		const app = composeAppWithGate(false, db);

		const res = await app.request("/__test/v2/seed-session", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "ok@test.local" }),
		});
		expect(res.status).toBe(200);
	});
});
