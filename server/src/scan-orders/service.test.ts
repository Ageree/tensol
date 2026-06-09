import type { Database } from "bun:sqlite";
/**
 * T039 — ScanOrdersService tests.
 *
 * Validates the full 9-method lifecycle API per spec FR-002..FR-017 and
 * data-model.md §E2 state machine:
 *
 *   createDraft → updateAttackSurface (subdomain probe DI'd) → updateSafety
 *     → requestDnsVerify → checkDnsAndUnlock → launchScan
 *       (free-tier consume + scans + jobs in one tx)
 *   → cancelOrder (refund rule per FR-016/FR-017)
 *
 * + read paths: getOrder (foreign-user 404), listUserOrders (no leak).
 *
 * Constitution invariants pinned:
 *   - II/IX: every state-changer in `withTx`, audit emitted AFTER commit.
 *   - II:   foreign-user → 404 (NOT 403) to hide existence.
 *   - VI:   illegal transition → 409 with `code === 'CONFLICT'`.
 *   - X:    every state-change emits a signed audit row.
 *   - VI:   launchScan is atomic — if the scans INSERT fails, the consumed
 *           free-tier quota is refunded (consumed_at back to NULL).
 *
 * Test infra mirrors `dns-verify/service.test.ts` and `free-tier/service.test.ts`:
 *   - in-memory bun:sqlite + all migrations applied
 *   - seeded `users` row via direct INSERT (no auth flow needed)
 *   - HMAC signing key threaded explicitly (Constitution X — emit.ts
 *     refuses to read process env)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { and, count, eq } from "drizzle-orm";
import { type DB, createDb } from "../db/client.ts";
import {
	auditLog as auditLogTable,
	jobs as jobsTable,
	scanOrders as scanOrdersTable,
	scans as scansTable,
	users as usersTable,
} from "../db/schema.ts";
import { VERIFY_TIMEOUT_MS } from "../dns-verify/service.ts";
import { ulid } from "../lib/ids.ts";
import { createScanOrdersService } from "./service.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-scan-orders";

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

function seedUser(db: DB, ts = 1_700_000_000_000): string {
	const id = ulid(ts);
	db.insert(usersTable)
		.values({ id, email: `${id}@test.local`, createdAt: ts })
		.run();
	return id;
}

/** Stub subdomain probe — returns a deterministic list independent of network. */
async function stubProbe(primary: string): Promise<string[]> {
	return [`www.${primary}`, `api.${primary}`];
}

/** Build a service wired with deterministic DI for the given DB. */
function buildSvc(
	db: DB,
	opts?: {
		nowSeq?: () => number;
		newIdSeq?: () => string;
		probe?: typeof stubProbe;
		dnsResolver?: (domain: string, opts?: unknown) => Promise<string[] | null>;
	},
) {
	let n = 1_700_000_000_000;
	const base = {
		db,
		auditKey: KEY,
		now: opts?.nowSeq ?? (() => ++n),
		discoverSubdomains: opts?.probe ?? stubProbe,
		dnsResolver: opts?.dnsResolver ?? (async () => []),
	};
	const deps = opts?.newIdSeq ? { ...base, newId: opts.newIdSeq } : base;
	return createScanOrdersService(deps);
}

function countAudit(db: DB, event: string): number {
	const row = db
		.select({ c: count() })
		.from(auditLogTable)
		.where(eq(auditLogTable.event, event))
		.get();
	return row?.c ?? 0;
}

function readOrder(db: DB, id: string) {
	return db
		.select()
		.from(scanOrdersTable)
		.where(eq(scanOrdersTable.id, id))
		.get();
}

function dnsTokenOf(
	order: ReturnType<typeof readOrder>,
	label: string,
): string {
	const token = order?.dnsVerifyToken;
	if (!token) throw new Error(`Expected ${label} to have a DNS verify token`);
	return token;
}

function readScanByOrder(db: DB, orderId: string) {
	return db
		.select()
		.from(scansTable)
		.where(eq(scansTable.scanOrderId, orderId))
		.get();
}

// ───────────────────────────────────────────────────────────────────────────
// createDraft
// ───────────────────────────────────────────────────────────────────────────
describe("createDraft", () => {
	test("happy path returns status='draft' + tier='quick'", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);

		const result = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});

		expect(result.status).toBe("draft");
		expect(result.tier).toBe("quick");
		expect(result.primary_domain).toBe("example.com");
		expect(result.user_id).toBe(userId);
		expect(result.payment_kind).toBe("free_quick");
		expect(result.safety_rps).toBe(50);
		expect(result.attack_surface).toEqual([]);
		// dns_verify_token is generated up-front (NOT NULL in schema)
		expect(result.dns_verify_token).toMatch(
			/^tensol-verify-[0-9A-HJKMNP-TV-Z]{26}$/,
		);
	});

	test("emits scan_order_created audit row", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		expect(countAudit(db, "scan_order_created")).toBe(1);
	});

	test("persists scan_orders row with default safety_rps=50", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const r = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});

		const row = readOrder(db, r.id);
		expect(row?.status).toBe("draft");
		expect(row?.safetyRps).toBe(50);
		expect(row?.primaryDomain).toBe("example.com");
		expect(row?.attackSurfaceJson).toBe("[]");
	});
});

// ───────────────────────────────────────────────────────────────────────────
// updateAttackSurface
// ───────────────────────────────────────────────────────────────────────────
describe("updateAttackSurface", () => {
	test("happy path replaces attack_surface_json", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});

		const result = await svc.updateAttackSurface(userId, draft.id, {
			attack_surface: [
				{ domain: "example.com", primary: true, headers: [] },
				{ domain: "api.example.com", primary: false, headers: [] },
			],
		});

		expect(result.attack_surface).toHaveLength(2);
		expect(result.attack_surface[0]?.domain).toBe("example.com");
		expect(result.attack_surface[0]?.primary).toBe(true);
	});

	test("emits scan_order_attack_surface_updated audit", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		await svc.updateAttackSurface(userId, draft.id, {
			attack_surface: [{ domain: "example.com", primary: true, headers: [] }],
		});
		expect(countAudit(db, "scan_order_attack_surface_updated")).toBe(1);
	});

	test("foreign-user → 404", async () => {
		const db = freshMemDb();
		const ownerA = seedUser(db);
		const ownerB = seedUser(db, 1_700_000_000_001);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(ownerA, {
			tier: "quick",
			primary_domain: "example.com",
		});

		try {
			await svc.updateAttackSurface(ownerB, draft.id, {
				attack_surface: [{ domain: "example.com", primary: true, headers: [] }],
			});
			throw new Error("expected NOT_FOUND");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("NOT_FOUND");
		}
	});

	test("non-draft status → 409", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		// Move to dns_pending out-of-band
		db.update(scanOrdersTable)
			.set({ status: "dns_pending" })
			.where(eq(scanOrdersTable.id, draft.id))
			.run();

		try {
			await svc.updateAttackSurface(userId, draft.id, {
				attack_surface: [{ domain: "example.com", primary: true, headers: [] }],
			});
			throw new Error("expected CONFLICT");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("CONFLICT");
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// updateSafety
// ───────────────────────────────────────────────────────────────────────────
describe("updateSafety", () => {
	test("happy path updates safety_rps", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});

		const result = await svc.updateSafety(userId, draft.id, {
			safety_rps: 100,
		});

		expect(result.safety_rps).toBe(100);
		expect(countAudit(db, "scan_order_safety_updated")).toBe(1);
	});

	test("foreign-user → 404", async () => {
		const db = freshMemDb();
		const ownerA = seedUser(db);
		const ownerB = seedUser(db, 1_700_000_000_001);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(ownerA, {
			tier: "quick",
			primary_domain: "example.com",
		});
		try {
			await svc.updateSafety(ownerB, draft.id, { safety_rps: 100 });
			throw new Error("expected NOT_FOUND");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("NOT_FOUND");
		}
	});

	test("non-draft → 409", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		db.update(scanOrdersTable)
			.set({ status: "dns_verified" })
			.where(eq(scanOrdersTable.id, draft.id))
			.run();

		try {
			await svc.updateSafety(userId, draft.id, { safety_rps: 100 });
			throw new Error("expected CONFLICT");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("CONFLICT");
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// requestDnsVerify
// ───────────────────────────────────────────────────────────────────────────
describe("requestDnsVerify", () => {
	test("draft → dns_pending; preserves token; emits audit", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});

		const result = await svc.requestDnsVerify(userId, draft.id);
		expect(result.status).toBe("dns_pending");
		expect(result.dns_verify_token).toMatch(/^tensol-verify-/);

		const row = readOrder(db, draft.id);
		expect(row?.dnsVerifyRequestedAt).toBeTruthy();
		expect(countAudit(db, "dns_verify_requested")).toBe(1);
	});

	test("foreign-user → 404", async () => {
		const db = freshMemDb();
		const ownerA = seedUser(db);
		const ownerB = seedUser(db, 1_700_000_000_001);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(ownerA, {
			tier: "quick",
			primary_domain: "example.com",
		});
		try {
			await svc.requestDnsVerify(ownerB, draft.id);
			throw new Error("expected NOT_FOUND");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("NOT_FOUND");
		}
	});

	test("dns_pending / dns_verified are idempotent no-op returns", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});

		const pending = await svc.requestDnsVerify(userId, draft.id);
		expect(pending.status).toBe("dns_pending");
		const pendingReplay = await svc.requestDnsVerify(userId, draft.id);
		expect(pendingReplay.status).toBe("dns_pending");

		db.update(scanOrdersTable)
			.set({ status: "dns_verified" })
			.where(eq(scanOrdersTable.id, draft.id))
			.run();

		const verifiedReplay = await svc.requestDnsVerify(userId, draft.id);
		expect(verifiedReplay.status).toBe("dns_verified");
		expect(countAudit(db, "dns_verify_requested")).toBe(1);
	});

	test("non-DNS state → 409", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		db.update(scanOrdersTable)
			.set({ status: "completed" })
			.where(eq(scanOrdersTable.id, draft.id))
			.run();

		try {
			await svc.requestDnsVerify(userId, draft.id);
			throw new Error("expected CONFLICT");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("CONFLICT");
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// checkDnsAndUnlock
// ───────────────────────────────────────────────────────────────────────────
describe("checkDnsAndUnlock", () => {
	test("resolver match → dns_verified", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const draft = await buildSvc(db).createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		const draftRow = readOrder(db, draft.id);
		const expectedToken = dnsTokenOf(draftRow, "draft row");
		// The resolver returns the matching token.
		const svc = buildSvc(db, {
			dnsResolver: async () => [expectedToken],
		});
		await svc.requestDnsVerify(userId, draft.id);
		const result = await svc.checkDnsAndUnlock(userId, draft.id);
		expect(result.status).toBe("dns_verified");
		expect(countAudit(db, "dns_verified")).toBe(1);
	});

	test("resolver miss → stays dns_pending (verified:false)", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db, { dnsResolver: async () => ["nope"] });
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		await svc.requestDnsVerify(userId, draft.id);
		const result = await svc.checkDnsAndUnlock(userId, draft.id);
		expect(result.status).toBe("dns_pending");
		expect(countAudit(db, "dns_verified")).toBe(0);
	});

	test("verification timeout → failed with timeout reason", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db, { dnsResolver: async () => ["nope"] });
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		await svc.requestDnsVerify(userId, draft.id);

		const requestedAt = readOrder(db, draft.id)?.dnsVerifyRequestedAt;
		if (requestedAt == null) throw new Error("expected dnsVerifyRequestedAt");

		const timeoutSvc = buildSvc(db, {
			nowSeq: () => requestedAt + VERIFY_TIMEOUT_MS + 1,
			dnsResolver: async () => [
				dnsTokenOf(readOrder(db, draft.id), "draft row"),
			],
		});
		const result = await timeoutSvc.checkDnsAndUnlock(userId, draft.id);

		expect(result.status).toBe("failed");
		expect(result.failure_reason).toBe("timeout");
		expect(countAudit(db, "dns_verify_failed")).toBe(1);
		expect(countAudit(db, "dns_verified")).toBe(0);
	});

	test("foreign-user → 404", async () => {
		const db = freshMemDb();
		const ownerA = seedUser(db);
		const ownerB = seedUser(db, 1_700_000_000_001);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(ownerA, {
			tier: "quick",
			primary_domain: "example.com",
		});
		await svc.requestDnsVerify(ownerA, draft.id);
		try {
			await svc.checkDnsAndUnlock(ownerB, draft.id);
			throw new Error("expected NOT_FOUND");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("NOT_FOUND");
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// launchScan
// ───────────────────────────────────────────────────────────────────────────
describe("launchScan", () => {
	async function setupVerified(db: DB) {
		const userId = seedUser(db);
		const draftSvc = buildSvc(db);
		const draft = await draftSvc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		const tokenRow = readOrder(db, draft.id);
		const svc = buildSvc(db, {
			dnsResolver: async () => [dnsTokenOf(tokenRow, "verified setup row")],
		});
		await svc.requestDnsVerify(userId, draft.id);
		await svc.checkDnsAndUnlock(userId, draft.id);
		return { userId, orderId: draft.id, svc };
	}

	test("happy path consumes free-tier + inserts scans + jobs row", async () => {
		const db = freshMemDb();
		const { userId, orderId, svc } = await setupVerified(db);

		const result = await svc.launchScan(userId, orderId);
		expect(result.scan_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

		// scans row exists
		const sc = db
			.select()
			.from(scansTable)
			.where(eq(scansTable.id, result.scan_id))
			.get();
		expect(sc?.scanOrderId).toBe(orderId);
		expect(sc?.userId).toBe(userId);

		// jobs row exists with type spawn_scan_vm
		const jobRow = db
			.select()
			.from(jobsTable)
			.where(eq(jobsTable.type, "spawn_scan_vm"))
			.get();
		expect(jobRow).toBeTruthy();
		expect(jobRow?.status).toBe("pending");

		// free-tier consumed
		const u = db
			.select()
			.from(usersTable)
			.where(eq(usersTable.id, userId))
			.get();
		expect(u?.freeQuickConsumedAt).toBeTruthy();
		expect(u?.freeQuickConsumedCount).toBe(1);

		// order moved to vm_provisioning, scanId populated
		const orderRow = readOrder(db, orderId);
		expect(orderRow?.status).toBe("vm_provisioning");
		expect(orderRow?.scanId).toBe(result.scan_id);

		// audit events
		expect(countAudit(db, "free_quota_consumed")).toBe(1);
		expect(countAudit(db, "scan_started")).toBe(1);
	});

	test("quota exhausted → 409 BAD_REQUEST (no scan)", async () => {
		const db = freshMemDb();
		const { userId, orderId, svc } = await setupVerified(db);

		// Pre-consume the user's quota.
		db.update(usersTable)
			.set({ freeQuickConsumedAt: Date.now(), freeQuickConsumedCount: 1 })
			.where(eq(usersTable.id, userId))
			.run();

		try {
			await svc.launchScan(userId, orderId);
			throw new Error("expected error");
		} catch (err) {
			const code = (err as { code?: string }).code ?? "";
			expect(["CONFLICT", "QUOTA_EXHAUSTED"].includes(code)).toBe(true);
		}

		// No scans row was inserted.
		const cnt = db.select({ c: count() }).from(scansTable).get();
		expect(cnt?.c).toBe(0);
	});

	test("non-dns_verified → 409", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});

		try {
			await svc.launchScan(userId, draft.id);
			throw new Error("expected CONFLICT");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("CONFLICT");
		}
	});

	test("atomic refund: if scans INSERT fails, free-tier quota is refunded", async () => {
		const db = freshMemDb();
		const { userId, orderId, svc } = await setupVerified(db);

		// Monkey-patch db.insert to fail when inserting scans row.
		const origInsert = db.insert.bind(db);
		let failed = false;
		// biome-ignore lint/suspicious/noExplicitAny: this test intentionally monkey-patches Drizzle's generic insert method to simulate a DB write failure.
		(db as any).insert = (table: any) => {
			if (table === scansTable && !failed) {
				failed = true;
				return {
					values: () => ({
						run: () => {
							throw new Error("simulated CHECK violation");
						},
					}),
				};
			}
			return origInsert(table);
		};

		let caught = false;
		try {
			await svc.launchScan(userId, orderId);
		} catch {
			caught = true;
		}
		expect(caught).toBe(true);

		// Restore.
		// biome-ignore lint/suspicious/noExplicitAny: restore the intentional monkey-patch above.
		(db as any).insert = origInsert;

		// Free-tier was refunded (consumed_at back to NULL).
		const u = db
			.select()
			.from(usersTable)
			.where(eq(usersTable.id, userId))
			.get();
		expect(u?.freeQuickConsumedAt).toBeNull();

		// Order did NOT move to vm_provisioning.
		const orderRow = readOrder(db, orderId);
		expect(orderRow?.status).toBe("dns_verified");
		expect(orderRow?.scanId).toBeNull();

		// No scans row persisted.
		const cnt = db.select({ c: count() }).from(scansTable).get();
		expect(cnt?.c).toBe(0);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// cancelOrder
// ───────────────────────────────────────────────────────────────────────────
describe("cancelOrder", () => {
	test("draft → cancelled; no quota was consumed → no refund needed", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});

		const result = await svc.cancelOrder(userId, draft.id);
		expect(result.status).toBe("cancelled");
		expect(countAudit(db, "scan_cancelled")).toBe(1);
	});

	test("dns_pending → cancelled; no scan row and no refund", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		await svc.requestDnsVerify(userId, draft.id);

		const result = await svc.cancelOrder(userId, draft.id);

		expect(result.status).toBe("cancelled");
		const order = readOrder(db, draft.id);
		expect(order?.failureReason).toBe("cancelled_pre_start");
		expect(order?.cancelledAt).toBeTruthy();
		expect(readScanByOrder(db, draft.id)).toBeUndefined();
		expect(countAudit(db, "free_quota_refunded")).toBe(0);
	});

	test("dns_verified → cancelled; no scan row and no refund", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const draftSvc = buildSvc(db);
		const draft = await draftSvc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		const tokenRow = readOrder(db, draft.id);
		const svc = buildSvc(db, {
			dnsResolver: async () => [dnsTokenOf(tokenRow, "cancel setup row")],
		});
		await svc.requestDnsVerify(userId, draft.id);
		await svc.checkDnsAndUnlock(userId, draft.id);

		const result = await svc.cancelOrder(userId, draft.id);

		expect(result.status).toBe("cancelled");
		const order = readOrder(db, draft.id);
		expect(order?.failureReason).toBe("cancelled_pre_start");
		expect(order?.cancelledAt).toBeTruthy();
		expect(readScanByOrder(db, draft.id)).toBeUndefined();
		expect(countAudit(db, "free_quota_refunded")).toBe(0);
	});

	test("vm_provisioning → cancelled refunds quota (pre-start)", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const draftSvc = buildSvc(db);
		const draft = await draftSvc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		const tokenRow = readOrder(db, draft.id);
		const svc = buildSvc(db, {
			dnsResolver: async () => [dnsTokenOf(tokenRow, "cancel setup row")],
		});
		await svc.requestDnsVerify(userId, draft.id);
		await svc.checkDnsAndUnlock(userId, draft.id);
		await svc.launchScan(userId, draft.id);

		// Sanity: quota consumed.
		let u = db.select().from(usersTable).where(eq(usersTable.id, userId)).get();
		expect(u?.freeQuickConsumedAt).toBeTruthy();

		// Cancel during vm_provisioning → refund (pre-start cancellation).
		await svc.cancelOrder(userId, draft.id);

		u = db.select().from(usersTable).where(eq(usersTable.id, userId)).get();
		expect(u?.freeQuickConsumedAt).toBeNull();
		const scan = readScanByOrder(db, draft.id);
		expect(scan?.status).toBe("cancelled");
		expect(scan?.failureReason).toBe("cancelled_pre_start");
		expect(scan?.completedAt).toBeTruthy();
		expect(countAudit(db, "free_quota_refunded")).toBe(1);
	});

	test("vm_provisioning cancel uses canonical scans.scan_order_id when order scan_id is stale", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const draftSvc = buildSvc(db);
		const draft = await draftSvc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		const tokenRow = readOrder(db, draft.id);
		const svc = buildSvc(db, {
			dnsResolver: async () => [dnsTokenOf(tokenRow, "cancel setup row")],
		});
		await svc.requestDnsVerify(userId, draft.id);
		await svc.checkDnsAndUnlock(userId, draft.id);
		await svc.launchScan(userId, draft.id);
		const actualScan = readScanByOrder(db, draft.id);
		expect(actualScan?.id).toBeTruthy();
		db.update(scanOrdersTable)
			.set({ scanId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })
			.where(eq(scanOrdersTable.id, draft.id))
			.run();

		await svc.cancelOrder(userId, draft.id);

		const scan = readScanByOrder(db, draft.id);
		expect(scan?.id).toBe(actualScan?.id);
		expect(scan?.status).toBe("cancelled");
		expect(scan?.failureReason).toBe("cancelled_pre_start");
		const audit = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "scan_cancelled"))
			.get();
		expect(audit?.scanId).toBe(actualScan?.id);
	});

	test("running → cancelled does NOT refund (post-start)", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const draftSvc = buildSvc(db);
		const draft = await draftSvc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		const tokenRow = readOrder(db, draft.id);
		const svc = buildSvc(db, {
			dnsResolver: async () => [dnsTokenOf(tokenRow, "cancel setup row")],
		});
		await svc.requestDnsVerify(userId, draft.id);
		await svc.checkDnsAndUnlock(userId, draft.id);
		await svc.launchScan(userId, draft.id);

		// Promote order to running.
		db.update(scanOrdersTable)
			.set({ status: "running" })
			.where(eq(scanOrdersTable.id, draft.id))
			.run();
		db.update(scansTable)
			.set({ status: "running" })
			.where(eq(scansTable.scanOrderId, draft.id))
			.run();

		await svc.cancelOrder(userId, draft.id);

		const u = db
			.select()
			.from(usersTable)
			.where(eq(usersTable.id, userId))
			.get();
		expect(u?.freeQuickConsumedAt).toBeTruthy(); // still consumed
		const scan = readScanByOrder(db, draft.id);
		expect(scan?.status).toBe("cancelled");
		expect(scan?.failureReason).toBe("cancelled_post_start");
		expect(scan?.completedAt).toBeTruthy();
		expect(countAudit(db, "free_quota_refunded")).toBe(0);
	});

	test("terminal state → 409", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		db.update(scanOrdersTable)
			.set({ status: "completed" })
			.where(eq(scanOrdersTable.id, draft.id))
			.run();

		try {
			await svc.cancelOrder(userId, draft.id);
			throw new Error("expected CONFLICT");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("CONFLICT");
		}
	});

	test("foreign-user → 404", async () => {
		const db = freshMemDb();
		const ownerA = seedUser(db);
		const ownerB = seedUser(db, 1_700_000_000_001);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(ownerA, {
			tier: "quick",
			primary_domain: "example.com",
		});
		try {
			await svc.cancelOrder(ownerB, draft.id);
			throw new Error("expected NOT_FOUND");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("NOT_FOUND");
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// getOrder / listUserOrders
// ───────────────────────────────────────────────────────────────────────────
describe("getOrder", () => {
	test("returns row for owner", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "example.com",
		});
		const got = await svc.getOrder(userId, draft.id);
		expect(got.id).toBe(draft.id);
		expect(got.user_id).toBe(userId);
	});

	test("foreign-user → 404", async () => {
		const db = freshMemDb();
		const ownerA = seedUser(db);
		const ownerB = seedUser(db, 1_700_000_000_001);
		const svc = buildSvc(db);
		const draft = await svc.createDraft(ownerA, {
			tier: "quick",
			primary_domain: "example.com",
		});
		try {
			await svc.getOrder(ownerB, draft.id);
			throw new Error("expected NOT_FOUND");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("NOT_FOUND");
		}
	});

	test("unknown id → 404", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		try {
			await svc.getOrder(userId, "01HXNONEXISTENTORDER000000");
			throw new Error("expected NOT_FOUND");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("NOT_FOUND");
		}
	});
});

describe("listUserOrders", () => {
	test("returns own orders, newest first", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const a = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "a.example.com",
		});
		const b = await svc.createDraft(userId, {
			tier: "quick",
			primary_domain: "b.example.com",
		});
		const list = await svc.listUserOrders(userId);
		expect(list.length).toBe(2);
		// Newest first: b was created after a.
		expect(list[0]?.id).toBe(b.id);
		expect(list[1]?.id).toBe(a.id);
	});

	test("does NOT leak other users' orders", async () => {
		const db = freshMemDb();
		const ownerA = seedUser(db);
		const ownerB = seedUser(db, 1_700_000_000_001);
		const svc = buildSvc(db);
		await svc.createDraft(ownerA, {
			tier: "quick",
			primary_domain: "a.example.com",
		});
		await svc.createDraft(ownerB, {
			tier: "quick",
			primary_domain: "b.example.com",
		});
		const list = await svc.listUserOrders(ownerA);
		expect(list.length).toBe(1);
		expect(list[0]?.primary_domain).toBe("a.example.com");
	});

	test("empty list when user has no orders", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);
		const list = await svc.listUserOrders(userId);
		expect(list).toEqual([]);
	});

	test("defaults to a bounded recent page and honors an explicit limit", async () => {
		const db = freshMemDb();
		const userId = seedUser(db);
		const svc = buildSvc(db);

		for (let i = 0; i < 105; i += 1) {
			await svc.createDraft(userId, {
				tier: "quick",
				primary_domain: `site-${i}.example.com`,
			});
		}

		const defaultPage = await svc.listUserOrders(userId);
		expect(defaultPage).toHaveLength(100);
		expect(defaultPage[0]?.primary_domain).toBe("site-104.example.com");

		const explicitPage = await svc.listUserOrders(userId, { limit: 12 });
		expect(explicitPage).toHaveLength(12);
		expect(explicitPage[0]?.primary_domain).toBe("site-104.example.com");
	});
});

// suppress unused
void and;
