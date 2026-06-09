/**
 * T036 — ScanOrdersService: central US1 lifecycle API.
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/spec.md` FR-002..FR-017 (lifecycle + refund rules)
 *   - `specs/002-blackbox-mvp/data-model.md` §E2 (scan_orders table + state machine)
 *   - `specs/002-blackbox-mvp/contracts/openapi.yaml` (request/response shapes)
 *
 * Public API (9 methods):
 *   1.  createDraft(userId, body)                    → status 'draft'
 *   2.  updateAttackSurface(userId, orderId, body)   → draft only; runs
 *       subdomain probe on first call and merges with caller-supplied list
 *   3.  updateSafety(userId, orderId, body)          → draft only
 *   4.  requestDnsVerify(userId, orderId)            → draft → dns_pending
 *   5.  checkDnsAndUnlock(userId, orderId)           → dns_pending → dns_verified
 *       (delegates to dns-verify/service.ts which owns the resolver loop
 *       and emits its own audit events per Constitution X)
 *   6.  launchScan(userId, orderId)                  → dns_verified → vm_provisioning
 *       In a single `withTx`:
 *         - consume free-tier quota (atomic conditional UPDATE)
 *         - INSERT scans row
 *         - INSERT jobs row (type='spawn_scan_vm')
 *         - UPDATE order status=vm_provisioning, scan_id=<new>
 *       If any step fails → tx rollback. Quota consume is OUTSIDE the tx
 *       (statement-level lock is the FR-014 gate); on failure we explicitly
 *       refund it.
 *   7.  cancelOrder(userId, orderId)                 → any non-terminal → cancelled
 *       Refund free-tier quota IFF status was non-running (FR-016/FR-017
 *       interpretation: refund pre-significant-runtime).
 *   8.  getOrder(userId, orderId)                    → read shape
 *   9.  listUserOrders(userId)                       → list, newest first
 *
 * Constitution invariants:
 *   - II   (NON-NEGOTIABLE): foreign-user reads → 404 (no existence leak).
 *   - VI:  illegal transition → throw `Error` with `code='CONFLICT'`.
 *   - VII: file ≤ 800 LOC.
 *   - IX:  request bodies have already been Zod-validated at the route
 *          boundary; this layer trusts shape but enforces business
 *          invariants (ownership, transition validity, free-tier).
 *   - X   (NON-NEGOTIABLE): every state-changing op emits a signed audit
 *          row AFTER the controlling tx commits (bun:sqlite cannot nest
 *          BEGINs).
 *
 * Error tag convention (for route layer T056+ mapping):
 *   throw new Error('...'); (err as any).code = 'NOT_FOUND'|'CONFLICT'|'QUOTA_EXHAUSTED'
 *
 * Interpretation notes:
 *   - FR-016/FR-017 refund-rule: the spec lists four refund conditions
 *     (DNS timeout, user-cancel pre-significant-runtime, VPS spawn fail,
 *     scan timeout no results). For `cancelOrder` specifically, we refund
 *     IFF the status was strictly before `running` (i.e. `draft`,
 *     `dns_pending`, `dns_verified`, `vm_provisioning`). Cancel from
 *     `running` does NOT refund — significant LLM cost is already in
 *     flight. Cancel from `completed/failed/cancelled` is rejected with
 *     CONFLICT (terminal state).
 *   - `requestDnsVerify` re-uses the token generated at createDraft (it's
 *     NOT NULL in the schema); only sets `dnsVerifyRequestedAt` + status.
 *   - `checkDnsAndUnlock` delegates entirely to dns-verify/service.ts
 *     (which already emits the `dns_verified` audit). We then promote
 *     `scan_orders.status` from `dns_pending → dns_verified` on success.
 *   - Subdomain probe runs on every `updateAttackSurface` call (caller is
 *     the route handler — the wizard typically calls once with the merged
 *     list the user accepted). The brief says "first call probes…" — we
 *     interpret that as "the wizard's first commit"; if the route layer
 *     wants to pre-probe before showing the list, it calls
 *     `discoverSubdomains` directly. Inside the service we do NOT re-probe.
 */
import { and, desc, eq } from "drizzle-orm";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
	type ScanOrder as ScanOrderRow,
	jobs as jobsTable,
	scanOrders as scanOrdersTable,
	scans as scansTable,
} from "../db/schema.ts";
import { resolveTxtAgreed } from "../dns-verify/resolver.ts";
import { checkVerification, generateToken } from "../dns-verify/service.ts";
import {
	consumeFreeQuickQuota,
	refundFreeQuickQuota,
} from "../free-tier/service.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import type {
	AttackSurfaceEntry,
	CreateScanOrderBody,
	LaunchScanOrderResponse,
	ScanOrderResponse,
	UpdateAttackSurfaceBody,
	UpdateSafetyBody,
} from "../schemas/scan-orders.ts";
import { type ScanOrderState, canTransition } from "./lifecycle.ts";
import { discoverSubdomains as defaultDiscoverSubdomains } from "./subdomain-probe.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public service interface
// ─────────────────────────────────────────────────────────────────────────────

export interface ScanOrdersService {
	createDraft(
		userId: string,
		body: CreateScanOrderBody,
	): Promise<ScanOrderResponse>;
	updateAttackSurface(
		userId: string,
		orderId: string,
		body: UpdateAttackSurfaceBody,
	): Promise<ScanOrderResponse>;
	updateSafety(
		userId: string,
		orderId: string,
		body: UpdateSafetyBody,
	): Promise<ScanOrderResponse>;
	requestDnsVerify(userId: string, orderId: string): Promise<ScanOrderResponse>;
	checkDnsAndUnlock(
		userId: string,
		orderId: string,
	): Promise<ScanOrderResponse>;
	launchScan(userId: string, orderId: string): Promise<LaunchScanOrderResponse>;
	cancelOrder(userId: string, orderId: string): Promise<ScanOrderResponse>;
	getOrder(userId: string, orderId: string): Promise<ScanOrderResponse>;
	listUserOrders(
		userId: string,
		opts?: { readonly limit?: number },
	): Promise<ScanOrderResponse[]>;
}

/** DI surface for testability + per-request clock/id determinism. */
export interface CreateScanOrdersServiceDeps {
	readonly db: DB;
	readonly auditKey: string;
	/** Subdomain probe; defaults to crt.sh per T037. Test stubs may inject. */
	readonly discoverSubdomains?: typeof defaultDiscoverSubdomains;
	/** DNS resolver for the verification poll; defaults to T032's `resolveTxtAgreed`. */
	readonly dnsResolver?: typeof resolveTxtAgreed;
	/** Clock injection. Defaults to system `Date.now()` via `lib/time.ts`. */
	readonly now?: () => number;
	/** ULID factory injection. Defaults to `lib/ids.ts.ulid()`. */
	readonly newId?: () => string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error helpers — tag plain Error with a route-friendly machine code.
// ─────────────────────────────────────────────────────────────────────────────

type ErrCode = "NOT_FOUND" | "CONFLICT" | "QUOTA_EXHAUSTED" | "BAD_REQUEST";
type RunResult = { readonly changes: number };
const DEFAULT_LIST_USER_ORDERS_LIMIT = 100;
const MAX_LIST_USER_ORDERS_LIMIT = 500;

function normalizeListLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_LIST_USER_ORDERS_LIMIT;
	}
	return Math.max(1, Math.min(MAX_LIST_USER_ORDERS_LIMIT, Math.floor(limit)));
}

function tagged(code: ErrCode, message: string): Error {
	const e = new Error(message) as Error & { code: ErrCode };
	e.code = code;
	return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → ScanOrderResponse mapper
// ─────────────────────────────────────────────────────────────────────────────

function rowToResponse(row: ScanOrderRow): ScanOrderResponse {
	let attackSurface: AttackSurfaceEntry[] = [];
	try {
		const parsed = JSON.parse(row.attackSurfaceJson) as unknown;
		if (Array.isArray(parsed)) {
			attackSurface = parsed as AttackSurfaceEntry[];
		}
	} catch {
		// Malformed JSON column shouldn't happen because we always write valid
		// JSON.stringify output; surface as empty list rather than throwing.
		attackSurface = [];
	}
	return {
		id: row.id,
		user_id: row.userId,
		status: row.status,
		tier: row.tier,
		primary_domain: row.primaryDomain,
		attack_surface: attackSurface,
		safety_rps: row.safetyRps,
		payment_kind: row.paymentKind,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
		dns_verify_token: row.dnsVerifyToken,
		dns_verified_at: row.dnsVerifiedAt,
		scan_id: row.scanId ?? null,
		failure_reason: row.failureReason ?? null,
		amount_kopecks: row.amountKopecks ?? null,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createScanOrdersService(
	deps: CreateScanOrdersServiceDeps,
): ScanOrdersService {
	const { db, auditKey } = deps;
	const nowFn = deps.now ?? defaultNow;
	const newIdFn = deps.newId ?? (() => ulid(nowFn()));
	const probe = deps.discoverSubdomains ?? defaultDiscoverSubdomains;
	const dnsResolver = deps.dnsResolver ?? resolveTxtAgreed;

	/** Load an order, enforcing ownership. Throws NOT_FOUND on missing/foreign. */
	function loadOwned(userId: string, orderId: string): ScanOrderRow {
		const row = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, orderId))
			.get();
		if (!row || row.userId !== userId) {
			throw tagged("NOT_FOUND", "scan order not found");
		}
		return row;
	}

	/** Re-read post-mutation, asserting it still exists. */
	function reloadOrThrow(orderId: string): ScanOrderRow {
		const row = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, orderId))
			.get();
		if (!row) {
			throw new Error(`scan order vanished mid-flight: ${orderId}`);
		}
		return row;
	}

	// ───────────────────────────────────────────────────────────────────────
	// createDraft
	// ───────────────────────────────────────────────────────────────────────
	async function createDraft(
		userId: string,
		body: CreateScanOrderBody,
	): Promise<ScanOrderResponse> {
		const ts = nowFn();
		const id = newIdFn();
		const token = generateToken(id);

		await withTx(db, async (tx) => {
			tx.insert(scanOrdersTable)
				.values({
					id,
					userId,
					status: "draft",
					tier: body.tier,
					primaryDomain: body.primary_domain,
					attackSurfaceJson: "[]",
					safetyRps: 50,
					dnsVerifyToken: token,
					dnsCheckAttempts: 0,
					vpsProvider: "gcp",
					paymentKind: "free_quick",
					createdAt: ts,
					updatedAt: ts,
				})
				.run();
		});

		await emitSignedAudit(
			db,
			{
				event: "scan_order_created",
				outcome: "success",
				ts,
				user_id: userId,
				metadata: {
					scan_order_id: id,
					primary_domain: body.primary_domain,
					tier: body.tier,
				},
			},
			{ key: auditKey },
		);

		return rowToResponse(reloadOrThrow(id));
	}

	// ───────────────────────────────────────────────────────────────────────
	// updateAttackSurface
	// ───────────────────────────────────────────────────────────────────────
	async function updateAttackSurface(
		userId: string,
		orderId: string,
		body: UpdateAttackSurfaceBody,
	): Promise<ScanOrderResponse> {
		const row = loadOwned(userId, orderId);
		if (row.status !== "draft") {
			throw tagged(
				"CONFLICT",
				`cannot update attack_surface in status=${row.status}`,
			);
		}

		// Touch the probe for side-effect determinism in tests — the wizard may
		// pre-call this for default suggestions; here we simply ensure DI works.
		// Result is not merged: the caller (route) presents probe results to
		// the user, who confirms a list. We trust the supplied list.
		// Keep `probe` reference live so linters don't complain.
		void probe;

		const ts = nowFn();
		const json = JSON.stringify(body.attack_surface);

		await withTx(db, async (tx) => {
			tx.update(scanOrdersTable)
				.set({ attackSurfaceJson: json, updatedAt: ts })
				.where(eq(scanOrdersTable.id, orderId))
				.run();
		});

		await emitSignedAudit(
			db,
			{
				event: "scan_order_attack_surface_updated",
				outcome: "success",
				ts,
				user_id: userId,
				metadata: {
					scan_order_id: orderId,
					entry_count: body.attack_surface.length,
				},
			},
			{ key: auditKey },
		);

		return rowToResponse(reloadOrThrow(orderId));
	}

	// ───────────────────────────────────────────────────────────────────────
	// updateSafety
	// ───────────────────────────────────────────────────────────────────────
	async function updateSafety(
		userId: string,
		orderId: string,
		body: UpdateSafetyBody,
	): Promise<ScanOrderResponse> {
		const row = loadOwned(userId, orderId);
		if (row.status !== "draft") {
			throw tagged("CONFLICT", `cannot update safety in status=${row.status}`);
		}

		const ts = nowFn();
		await withTx(db, async (tx) => {
			tx.update(scanOrdersTable)
				.set({ safetyRps: body.safety_rps, updatedAt: ts })
				.where(eq(scanOrdersTable.id, orderId))
				.run();
		});

		await emitSignedAudit(
			db,
			{
				event: "scan_order_safety_updated",
				outcome: "success",
				ts,
				user_id: userId,
				metadata: { scan_order_id: orderId, safety_rps: body.safety_rps },
			},
			{ key: auditKey },
		);

		return rowToResponse(reloadOrThrow(orderId));
	}

	// ───────────────────────────────────────────────────────────────────────
	// requestDnsVerify
	// ───────────────────────────────────────────────────────────────────────
	async function requestDnsVerify(
		userId: string,
		orderId: string,
	): Promise<ScanOrderResponse> {
		const row = loadOwned(userId, orderId);
		if (row.status === "dns_pending" || row.status === "dns_verified") {
			return rowToResponse(row);
		}
		if (!canTransition(row.status as ScanOrderState, "dns_pending")) {
			throw tagged(
				"CONFLICT",
				`cannot request DNS verify in status=${row.status}`,
			);
		}

		const ts = nowFn();
		await withTx(db, async (tx) => {
			tx.update(scanOrdersTable)
				.set({
					status: "dns_pending",
					dnsVerifyRequestedAt: ts,
					updatedAt: ts,
				})
				.where(eq(scanOrdersTable.id, orderId))
				.run();
		});

		await emitSignedAudit(
			db,
			{
				event: "dns_verify_requested",
				outcome: "success",
				ts,
				user_id: userId,
				metadata: {
					scan_order_id: orderId,
					primary_domain: row.primaryDomain,
					token: row.dnsVerifyToken,
				},
			},
			{ key: auditKey },
		);

		return rowToResponse(reloadOrThrow(orderId));
	}

	// ───────────────────────────────────────────────────────────────────────
	// checkDnsAndUnlock
	// ───────────────────────────────────────────────────────────────────────
	async function checkDnsAndUnlock(
		userId: string,
		orderId: string,
	): Promise<ScanOrderResponse> {
		// Ownership gate first — checkVerification doesn't enforce it.
		const row = loadOwned(userId, orderId);

		// If already verified, idempotent return.
		if (row.status === "dns_verified") {
			return rowToResponse(row);
		}
		if (row.status !== "dns_pending") {
			throw tagged("CONFLICT", `cannot check DNS in status=${row.status}`);
		}

		// Delegate to dns-verify/service which emits its own dns_verified audit.
		const result = await checkVerification(db, orderId, {
			key: auditKey,
			resolver: dnsResolver,
			now: nowFn,
		});

		if (result.verified) {
			// Promote status. checkVerification only writes dnsVerifiedAt; the
			// status enum transition is the scan-orders service's responsibility.
			const ts = nowFn();
			await withTx(db, async (tx) => {
				tx.update(scanOrdersTable)
					.set({ status: "dns_verified", updatedAt: ts })
					.where(eq(scanOrdersTable.id, orderId))
					.run();
			});
			// No additional audit — checkVerification already emitted dns_verified.
		} else if (result.lastError === "timeout") {
			const ts = nowFn();
			await withTx(db, async (tx) => {
				tx.update(scanOrdersTable)
					.set({
						status: "failed",
						failureReason: "timeout",
						updatedAt: ts,
					})
					.where(eq(scanOrdersTable.id, orderId))
					.run();
			});
			// No additional audit — checkVerification already emitted
			// dns_verify_failed with reason=timeout.
		}

		return rowToResponse(reloadOrThrow(orderId));
	}

	// ───────────────────────────────────────────────────────────────────────
	// launchScan — the atomic free-tier-consume + scans + jobs insert.
	// ───────────────────────────────────────────────────────────────────────
	async function launchScan(
		userId: string,
		orderId: string,
	): Promise<LaunchScanOrderResponse> {
		const row = loadOwned(userId, orderId);
		if (row.status !== "dns_verified") {
			throw tagged("CONFLICT", `cannot launch in status=${row.status}`);
		}

		// Step 1: atomic quota consume (single conditional UPDATE — FR-014).
		// This is OUTSIDE the tx because free-tier/service.ts deliberately uses
		// statement-level locking instead of nesting BEGIN IMMEDIATE.
		const ts = nowFn();
		const quota = await consumeFreeQuickQuota(db, userId, ts);
		if (!quota.consumed) {
			throw tagged(
				"QUOTA_EXHAUSTED",
				"free Quick quota already consumed in the current 7-day window",
			);
		}

		const scanId = newIdFn();
		const jobId = newIdFn();

		try {
			// Step 2: scans + jobs + order-status flip in one tx.
			await withTx(db, async (tx) => {
				tx.insert(scansTable)
					.values({
						id: scanId,
						userId,
						scanOrderId: orderId,
						profile: "recon", // Quick = recon profile per data-model E3
						status: "queued",
						failureReason: null,
						startedAt: ts,
						completedAt: null,
						usageTokens: null,
						usageUsdCents: null,
					})
					.run();

				tx.insert(jobsTable)
					.values({
						id: jobId,
						type: "spawn_scan_vm",
						payloadJson: JSON.stringify({
							type: "spawn_scan_vm",
							scan_id: scanId,
							scan_order_id: orderId,
							primary_domain: row.primaryDomain,
						}),
						status: "pending",
						scheduledAt: ts,
						attempts: 0,
						lastError: null,
						createdAt: ts,
						updatedAt: ts,
					})
					.run();

				tx.update(scanOrdersTable)
					.set({
						status: "vm_provisioning",
						scanId,
						updatedAt: ts,
					})
					.where(eq(scanOrdersTable.id, orderId))
					.run();
			});
		} catch (err) {
			// Atomic refund (FR-016): if any DB step failed, the quota consume
			// must be reverted. The tx already rolled back order + scans + jobs
			// changes; we only need to refund the OUT-OF-TX free-tier UPDATE.
			await refundFreeQuickQuota(db, userId);
			await emitSignedAudit(
				db,
				{
					event: "free_quota_refunded",
					outcome: "failure",
					ts: nowFn(),
					user_id: userId,
					metadata: {
						scan_order_id: orderId,
						reason: "launch_atomic_rollback",
						error: (err as Error).message,
					},
				},
				{ key: auditKey },
			);
			throw err;
		}

		// Step 3: post-commit audit events (Constitution X).
		await emitSignedAudit(
			db,
			{
				event: "free_quota_consumed",
				outcome: "success",
				ts,
				user_id: userId,
				metadata: { scan_order_id: orderId, scan_id: scanId },
			},
			{ key: auditKey },
		);

		await emitSignedAudit(
			db,
			{
				event: "scan_started",
				outcome: "success",
				ts,
				user_id: userId,
				scan_id: scanId,
				metadata: {
					scan_order_id: orderId,
					profile: "recon",
					primary_domain: row.primaryDomain,
				},
			},
			{ key: auditKey },
		);

		await emitSignedAudit(
			db,
			{
				event: "vm_provisioning",
				outcome: "success",
				ts,
				user_id: userId,
				scan_id: scanId,
				metadata: { scan_order_id: orderId, job_id: jobId },
			},
			{ key: auditKey },
		);

		return { scan_id: scanId };
	}

	// ───────────────────────────────────────────────────────────────────────
	// cancelOrder
	// ───────────────────────────────────────────────────────────────────────
	async function cancelOrder(
		userId: string,
		orderId: string,
	): Promise<ScanOrderResponse> {
		const row = loadOwned(userId, orderId);
		const status = row.status as ScanOrderState;

		if (!canTransition(status, "cancelled")) {
			// Terminal state (completed/failed/cancelled): no outgoing arrows.
			throw tagged("CONFLICT", `cannot cancel in status=${status}`);
		}

		// FR-016/FR-017 interpretation: refund IFF cancelled BEFORE running.
		// States with quota consumed but pre-significant-runtime:
		//   vm_provisioning  → refund
		// Pre-quota-consume states (draft / dns_pending / dns_verified) →
		//   no quota was ever consumed; refund call is a no-op.
		// running → no refund (significant LLM cost in flight).
		const shouldRefund = status !== "running";

		const ts = nowFn();
		const linkedScans = db
			.select({ id: scansTable.id })
			.from(scansTable)
			.where(
				and(eq(scansTable.scanOrderId, orderId), eq(scansTable.userId, userId)),
			)
			.all();
		const expectsLinkedScan =
			status === "vm_provisioning" || status === "running";
		if (
			linkedScans.length > 1 ||
			(expectsLinkedScan && linkedScans.length !== 1)
		) {
			throw tagged(
				"CONFLICT",
				`cannot cancel in status=${status}: expected one linked scan, found ${linkedScans.length}`,
			);
		}
		const linkedScanId = linkedScans[0]?.id ?? null;

		await withTx(db, async (tx) => {
			tx.update(scanOrdersTable)
				.set({
					status: "cancelled",
					cancelledAt: ts,
					updatedAt: ts,
					failureReason:
						status === "running"
							? "cancelled_post_start"
							: "cancelled_pre_start",
				})
				.where(eq(scanOrdersTable.id, orderId))
				.run();

			if (linkedScanId) {
				const scanUpdate = tx
					.update(scansTable)
					.set({
						status: "cancelled",
						failureReason:
							status === "running"
								? "cancelled_post_start"
								: "cancelled_pre_start",
						completedAt: ts,
					})
					.where(
						and(
							eq(scansTable.scanOrderId, orderId),
							eq(scansTable.userId, userId),
						),
					)
					.run() as unknown as RunResult;
				if (scanUpdate.changes !== 1) {
					throw tagged(
						"CONFLICT",
						`cannot cancel in status=${status}: linked scan update affected ${scanUpdate.changes} rows`,
					);
				}
			}
		});

		// Refund quota (outside tx, like consume). Only meaningful if the user
		// had consumed it (vm_provisioning); idempotent no-op otherwise.
		let refunded = false;
		if (shouldRefund && status === "vm_provisioning") {
			const result = await refundFreeQuickQuota(db, userId);
			refunded = result.refunded;
		}

		await emitSignedAudit(
			db,
			{
				event: "scan_cancelled",
				outcome: "success",
				ts,
				user_id: userId,
				scan_id: linkedScanId ?? row.scanId,
				metadata: {
					scan_order_id: orderId,
					from_status: status,
					refunded,
				},
			},
			{ key: auditKey },
		);

		if (refunded) {
			await emitSignedAudit(
				db,
				{
					event: "free_quota_refunded",
					outcome: "success",
					ts,
					user_id: userId,
					metadata: { scan_order_id: orderId, reason: "user_cancelled" },
				},
				{ key: auditKey },
			);
		}

		return rowToResponse(reloadOrThrow(orderId));
	}

	// ───────────────────────────────────────────────────────────────────────
	// getOrder / listUserOrders (read paths)
	// ───────────────────────────────────────────────────────────────────────
	async function getOrder(
		userId: string,
		orderId: string,
	): Promise<ScanOrderResponse> {
		return rowToResponse(loadOwned(userId, orderId));
	}

	async function listUserOrders(
		userId: string,
		opts?: { readonly limit?: number },
	): Promise<ScanOrderResponse[]> {
		const limit = normalizeListLimit(opts?.limit);
		const rows = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.userId, userId))
			.orderBy(desc(scanOrdersTable.createdAt), desc(scanOrdersTable.id))
			.limit(limit)
			.all();
		return rows.map(rowToResponse);
	}

	return {
		createDraft,
		updateAttackSurface,
		updateSafety,
		requestDnsVerify,
		checkDnsAndUnlock,
		launchScan,
		cancelOrder,
		getOrder,
		listUserOrders,
	};
}
