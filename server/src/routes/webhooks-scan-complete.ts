import { and, eq } from "drizzle-orm";
/**
 * T069 — `POST /v1/webhooks/scan-complete` receiver (US1 final-callback).
 *
 * This is the **inbound HTTP endpoint** that `vps-agent` running on the
 * per-scan GCP VM calls when a Decepticon scan terminates.
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/contracts/webhook.md`
 *       (envelope, header format, validation order, error envelopes)
 *   - `server/src/schemas/webhook-scan-complete.ts` (T026)
 *       (Zod body validator + YAML frontmatter normaliser)
 *   - `server/src/findings/ingest.ts` (T048)
 *       (per-finding insert + finding_ingested audit)
 *   - `server/src/audit/emit.ts` (T014)
 *       (signed audit chain + webhook_received / webhook_invalid_signature
 *        literal event names)
 *
 * Companion to `server/src/routes/webhooks.ts` — that file holds the V1
 * `POST /scan-progress` handler from feature 001 (per-VPS sign_key looked
 * up via `vps_instances`). This new V2 endpoint uses a single shared
 * `TENSOL_WEBHOOK_SECRET` for the whole fleet, with the Stripe-style
 * `t=<seconds>, v1=<hex>` header envelope. The two paths intentionally
 * live in separate files so the V1 path can be retired independently when
 * we cut over.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Validation order (per webhook.md §"Validation order") — TIGHT and ORDERED:
 *
 *   1. X-Tensol-Signature header present + parses to { t, v1 }
 *        → 401 "webhook_invalid_signature" otherwise
 *   2. Timestamp drift within ±5 minutes of `now()`
 *        → 401 "webhook_replay_too_old" otherwise + audit emit
 *   3. HMAC v1 = hex(hmac_sha256(secret, "${t}.${rawBody}")) matches
 *        → 401 "webhook_invalid_signature" otherwise + audit emit
 *   4. Body parses as JSON
 *        → 422 "webhook_body_invalid" otherwise
 *   5. WebhookScanCompleteBodySchema.parse
 *        → 422 "webhook_body_invalid" otherwise
 *   6. Idempotency replay check: existing webhook_dedup row
 *        → 200 { status: "duplicate" } no-op
 *   7. Scan order ownership + state (must be `running` or `vm_provisioning`)
 *        → 404/409 otherwise, without creating a new dedup row
 *   8. Idempotency reservation: attempt INSERT into webhook_dedup
 *      (webhook_kind='scan_complete', dedup_key=$scan_order_id);
 *      SQLITE_CONSTRAINT_UNIQUE on collision
 *        → 200 { status: "duplicate" } no-op
 *   9. Findings ingest via createFindingsIngest().insertFinding (one per
 *      finding); UPDATE scans.status and scan_orders.status to the terminal
 *      callback status (`completed` or `failed`)
 *  10. On `completed`, create a `reports` row and enqueue `render_pdf`,
 *      `send_scan_complete_telegram`, `teardown_scan_vm` jobs; on `failed`,
 *      enqueue only `teardown_scan_vm` and refund free-Quick quota
 *  11. Refund free-Quick quota for failed free-order callbacks, then emit
 *      `webhook_received` signed audit AFTER all state changes commit
 *
 * Constitution invariants honoured here:
 *   - II  (NON-NEGOTIABLE): HMAC validation runs BEFORE JSON.parse and
 *         BEFORE any DB mutation. We read `c.req.text()` so the exact
 *         signed bytes are available without re-canonicalisation.
 *   - VII: file ≤ 800 LOC. (This file stays under the limit.)
 *   - IX  (NON-NEGOTIABLE): Zod validates the body before any state write.
 *   - X   (NON-NEGOTIABLE): `webhook_received` audit emit happens AFTER
 *         the controlling state change commits. Likewise, the rejection
 *         path emits `webhook_invalid_signature` with outcome='rejected'
 *         so the SOC has visibility into spoof attempts.
 *
 * INTERPRETATION NOTES (where webhook.md left wiggle room):
 *   - Header format: `t=<unix-seconds>, v1=<hex>` per the contract. We
 *     tolerate optional whitespace around the `,` (the contract shows
 *     one space; vps-agent may emit zero) and lowercase-only hex (the
 *     contract example uses lowercase).
 *   - Drift window: the contract says "within ±5 minutes". We allow
 *     EXACTLY 5min on either side (`Math.abs(...) <= 5*60`) to make the
 *     edge case test-pinnable.
 *   - Idempotency dedup key: we INSERT into the dedicated `webhook_dedup`
 *     table with UNIQUE(webhook_kind, dedup_key) and treat the
 *     SQLITE_CONSTRAINT_UNIQUE error as the duplicate signal. Constant-
 *     time (single B-tree probe) regardless of audit_log size. Migration
 *     0011_webhook_dedup.sql introduced this table; the previous
 *     `audit_log.metadata_json LIKE '%scan_order_id%'` scan (O(n)) was
 *     replaced because it became a hot-path concern at scale (T145 LOW-3).
 *   - Findings target: each finding row needs a `target` value (E5
 *     NOT NULL). We default it to `scanOrders.primaryDomain` when the
 *     YAML frontmatter doesn't include `affected_target` — keeps the
 *     ingest schema-clean even on findings that only report a host:port.
 *   - State `cancelled` / `completed`: a webhook arriving for a terminal
 *     order is treated as 409 (not idempotent 200) because the order
 *     was already fully resolved; the audit-log dedup path above only
 *     triggers when the previous webhook_received row exists, which
 *     only happens if WE marked it terminal.
 *
 * What this module deliberately does NOT do:
 *   - Touch `vps_instances` — V2 contract has no per-VPS sign_key (single
 *     fleet secret instead). The teardown_scan_vm job handler is the
 *     one that flips the vps_instances row to `tearing_down`.
 *   - Render PDFs / send Telegram — those happen via the enqueued jobs.
 *   - Store the evidence archive itself — the agent uploads the object before
 *     calling us. We only verify the `s3://` URI belongs to the configured
 *     evidence bucket before accepting a completed callback with an archive.
 */
import { Hono } from "hono";

import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
	jobs as jobsTable,
	reports as reportsTable,
	scanOrders as scanOrdersTable,
	scans as scansTable,
	webhookDedup as webhookDedupTable,
} from "../db/schema.ts";
import { createFindingsIngest } from "../findings/ingest.ts";
import type {
	RenderPdfJob,
	SendScanCompleteTelegramJob,
	TeardownScanVmJob,
} from "../jobs/types.ts";
import { hmacSha256, timingSafeEqual } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import {
	type WebhookScanCompleteBody,
	WebhookScanCompleteBodySchema,
} from "../schemas/webhook-scan-complete.ts";

/** Five-minute drift window per webhook.md §"Signature header". */
const SIGNATURE_DRIFT_SECONDS = 5 * 60;

/** SHA-256 produces a 32-byte digest, encoded as 64 hex characters. */
const HMAC_SHA256_HEX_LENGTH = 64;

/** Webhook body completion timestamp freshness window per webhook.md. */
const COMPLETED_AT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** Jobs we enqueue on successful webhook ingest. Order is irrelevant —
 *  the runner picks them up independently — but listing here keeps the
 *  audit trail / tests readable. */
const FOLLOWUP_JOB_KINDS = [
	"render_pdf",
	"send_scan_complete_telegram",
	"teardown_scan_vm",
] as const;

export interface CreateWebhookScanCompleteRouterDeps {
	readonly db: DB;
	/** HMAC-SHA256 secret shared with every vps-agent (TENSOL_WEBHOOK_SECRET). */
	readonly webhookSecret: string;
	/** Expected Object Storage bucket for evidence archives. Empty disables
	 *  this semantic check in local/dev test harnesses without storage config. */
	readonly expectedEvidenceBucket?: string;
	/** Free-tier quota refund primitive. Called for failed free-Quick callbacks. */
	readonly refundFreeQuickQuota: (
		userId: string,
	) => Promise<{ refunded: boolean }>;
	/** Audit-log signing key (TENSOL_AUDIT_SIGNING_KEY) — same key the
	 *  scan-orders service uses. */
	readonly auditKey: string;
	/** Clock injection for tests. Defaults to `Date.now()` via lib/time. */
	readonly now?: () => number;
	/** ULID factory injection for tests. Defaults to global `ulid()`. */
	readonly newId?: () => string;
}

interface ParsedSignatureHeader {
	readonly t: number; // unix seconds
	readonly v1: string; // lowercase hex
}

/** Parse the `t=<seconds>, v1=<hex>` envelope per webhook.md.
 *
 * Tolerates:
 *   - any whitespace around the `,` separator
 *   - any ordering of the two key/value pairs (`v1=...,t=...` also valid)
 *   - lower OR upper-case hex (`hmacSha256` always returns lowercase, but
 *     we don't want an upper-case sig from a bug to look like a "spoof")
 *   - exactly 64 hex chars for v1; shorter/longer digests are malformed
 *
 * Returns `null` on any structural problem; the caller maps null to 401.
 */
function parseSignatureHeader(
	raw: string | undefined,
): ParsedSignatureHeader | null {
	if (!raw) return null;
	const parts = raw.split(",").map((p) => p.trim());
	if (parts.length !== 2) return null;

	let t: number | null = null;
	let v1: string | null = null;

	for (const part of parts) {
		const eqIdx = part.indexOf("=");
		if (eqIdx <= 0) return null;
		const key = part.slice(0, eqIdx).trim();
		const value = part.slice(eqIdx + 1).trim();
		if (key === "t") {
			if (!/^\d+$/.test(value)) return null;
			const n = Number.parseInt(value, 10);
			if (!Number.isFinite(n) || n <= 0) return null;
			t = n;
		} else if (key === "v1") {
			if (
				value.length !== HMAC_SHA256_HEX_LENGTH ||
				!/^[0-9a-fA-F]+$/.test(value)
			) {
				return null;
			}
			v1 = value.toLowerCase();
		} else {
			return null;
		}
	}

	if (t === null || v1 === null) return null;
	return { t, v1 };
}

/**
 * Detect a bun:sqlite UNIQUE-constraint violation. Used by the webhook_dedup
 * INSERT-then-catch idempotency path (step 6).
 *
 * bun:sqlite surfaces errors as `SQLiteError` instances with a structured
 * `code` field ("SQLITE_CONSTRAINT_UNIQUE") AND a message of the shape
 * `UNIQUE constraint failed: <table>.<col>`. We match either to stay robust
 * against the runtime swapping error wrappers between Bun versions (the
 * `code` field is the canonical one; the message check is a paranoia belt).
 */
function isUniqueViolation(err: unknown): boolean {
	if (err === null || typeof err !== "object") return false;
	const e = err as { code?: unknown; message?: unknown };
	if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
	if (
		typeof e.message === "string" &&
		e.message.includes("UNIQUE constraint failed")
	) {
		return true;
	}
	return false;
}

function bucketFromS3Uri(uri: string): string {
	return uri.slice("s3://".length).split("/", 1)[0] ?? "";
}

/**
 * Public factory — assembles the Hono subrouter mounted at `/v1/webhooks`
 * (so the full path is `POST /v1/webhooks/scan-complete`).
 */
export function createWebhookScanCompleteRouter(
	deps: CreateWebhookScanCompleteRouterDeps,
): Hono {
	const { db, webhookSecret, auditKey, refundFreeQuickQuota } = deps;
	const configuredWebhookSecret = webhookSecret.trim();
	const expectedEvidenceBucket = deps.expectedEvidenceBucket?.trim() ?? "";
	const clock = deps.now ?? defaultNow;
	const newId = deps.newId ?? (() => ulid(clock()));

	const ingest = createFindingsIngest({
		db,
		auditKey,
		clock,
		newId,
	});

	const app = new Hono();

	app.post("/scan-complete", async (c) => {
		// ───────────────────────────────────────────────────────────────────
		// 1. Read raw body bytes — HMAC verifies the exact bytes the agent
		//    signed; re-canonicalising via c.req.json() would break the
		//    signature for any body with non-canonical whitespace.
		// ───────────────────────────────────────────────────────────────────
		let rawBody: string;
		try {
			rawBody = await c.req.text();
		} catch {
			return c.json(
				{ error: "webhook_body_invalid", message: "could not read body" },
				422,
			);
		}

		// ───────────────────────────────────────────────────────────────────
		// 2. Parse the signature header.
		// ───────────────────────────────────────────────────────────────────
		const sigHeader = c.req.header("x-tensol-signature");
		const sig = parseSignatureHeader(sigHeader);
		if (!sig) {
			// Bare 401 — no audit row, because without a timestamp we have no
			// useful signal to record (could be a benign probe / scanner).
			return c.json(
				{
					error: "webhook_invalid_signature",
					message: "missing or malformed X-Tensol-Signature header",
				},
				401,
			);
		}
		if (configuredWebhookSecret === "") {
			return c.json(
				{
					error: "webhook_invalid_signature",
					message: "webhook signing secret is not configured",
				},
				401,
			);
		}

		// ───────────────────────────────────────────────────────────────────
		// 3. Timestamp drift check. Outside ±5min → 401 + rejected audit.
		// ───────────────────────────────────────────────────────────────────
		const nowMs = clock();
		const nowSeconds = Math.floor(nowMs / 1000);
		const driftSeconds = Math.abs(nowSeconds - sig.t);
		if (driftSeconds > SIGNATURE_DRIFT_SECONDS) {
			await emitSignedAudit(
				db,
				{
					event: "webhook_invalid_signature",
					outcome: "rejected",
					ts: nowMs,
					metadata: {
						reason: "stale_timestamp",
						drift_seconds: driftSeconds,
						agent_timestamp: sig.t,
					},
				},
				{ key: auditKey },
			);
			return c.json(
				{
					error: "webhook_replay_too_old",
					message: `Timestamp ${sig.t} outside ±${SIGNATURE_DRIFT_SECONDS}s window`,
				},
				401,
			);
		}

		// ───────────────────────────────────────────────────────────────────
		// 4. Verify HMAC. Constant-time compare against the recomputed hex.
		//    Signed string per contract: "${t}.${rawBody}".
		// ───────────────────────────────────────────────────────────────────
		const expected = hmacSha256(configuredWebhookSecret, `${sig.t}.${rawBody}`);
		if (!timingSafeEqual(expected, sig.v1)) {
			await emitSignedAudit(
				db,
				{
					event: "webhook_invalid_signature",
					outcome: "rejected",
					ts: nowMs,
					metadata: {
						reason: "hmac_mismatch",
						// Length only — never log the offending signature bytes.
						received_signature_length: sig.v1.length,
					},
				},
				{ key: auditKey },
			);
			return c.json(
				{
					error: "webhook_invalid_signature",
					message: "Signature verification failed",
				},
				401,
			);
		}

		// ───────────────────────────────────────────────────────────────────
		// 5. Body parse + Zod validation. Both failure modes → 422.
		// ───────────────────────────────────────────────────────────────────
		let bodyJson: unknown;
		try {
			bodyJson = JSON.parse(rawBody);
		} catch {
			return c.json(
				{ error: "webhook_body_invalid", message: "body is not valid JSON" },
				422,
			);
		}
		const parsed = WebhookScanCompleteBodySchema.safeParse(bodyJson);
		if (!parsed.success) {
			return c.json(
				{
					error: "webhook_body_invalid",
					message: parsed.error.issues[0]?.message ?? "validation failed",
					issues: parsed.error.issues,
				},
				422,
			);
		}
		const body: WebhookScanCompleteBody = parsed.data;

		const completedAtTooOld =
			body.completed_at < nowMs - COMPLETED_AT_MAX_AGE_MS;
		const completedAtTooFarAhead =
			body.completed_at > nowMs + SIGNATURE_DRIFT_SECONDS * 1_000;
		if (completedAtTooOld || completedAtTooFarAhead) {
			return c.json(
				{
					error: "webhook_body_invalid",
					message:
						"completed_at must be within the last 24h and not more than 5min in the future",
				},
				422,
			);
		}

		const evidenceBucket =
			body.evidence_archive_url === null
				? ""
				: bucketFromS3Uri(body.evidence_archive_url);
		if (
			body.evidence_archive_url !== null &&
			expectedEvidenceBucket !== "" &&
			evidenceBucket !== expectedEvidenceBucket
		) {
			return c.json(
				{
					error: "webhook_body_invalid",
					message: "unexpected evidence bucket",
				},
				422,
			);
		}

		// ───────────────────────────────────────────────────────────────────
		// 6. Idempotency replay fast-path (webhook_dedup table).
		//
		// Existing rows still short-circuit before the state check, so a real
		// duplicate delivery for an already-completed order returns 200 instead
		// of 409. New dedup rows are reserved only after we prove the order is
		// currently callback-eligible; that prevents validly signed but
		// non-actionable webhooks from poisoning a future scan_order_id.
		// ───────────────────────────────────────────────────────────────────
		const existingDedup = db
			.select({ id: webhookDedupTable.id })
			.from(webhookDedupTable)
			.where(
				and(
					eq(webhookDedupTable.webhookKind, "scan_complete"),
					eq(webhookDedupTable.dedupKey, body.scan_order_id),
				),
			)
			.get();
		if (existingDedup) {
			return c.json(
				{
					status: "duplicate",
					scan_order_id: body.scan_order_id,
				},
				200,
			);
		}

		// ───────────────────────────────────────────────────────────────────
		// 7. Order + scan ownership. The order must be in `running` or
		//    `vm_provisioning` per webhook.md §4; anything else → 409.
		// ───────────────────────────────────────────────────────────────────
		const order = db
			.select()
			.from(scanOrdersTable)
			.where(eq(scanOrdersTable.id, body.scan_order_id))
			.get();
		if (!order) {
			return c.json(
				{ error: "scan_order_not_found", message: "no such scan_order" },
				404,
			);
		}
		const acceptedStates = new Set(["running", "vm_provisioning"]);
		if (!acceptedStates.has(order.status)) {
			return c.json(
				{
					error: "scan_order_not_running",
					message: `Order is in status '${order.status}'`,
				},
				409,
			);
		}
		if (!order.scanId) {
			// Defensive — the wizard's launchScan always sets scan_id at the
			// same moment it flips status→vm_provisioning. A missing scan_id
			// here would mean a schema-drift bug, not a webhook problem.
			return c.json(
				{ error: "scan_id_missing", message: "scan row not provisioned" },
				409,
			);
		}
		const scanRow = db
			.select()
			.from(scansTable)
			.where(eq(scansTable.id, order.scanId))
			.get();
		if (!scanRow) {
			return c.json(
				{ error: "scan_not_found", message: "scan row missing" },
				409,
			);
		}

		// ───────────────────────────────────────────────────────────────────
		// 8. Idempotency reservation.
		//
		// INSERT into webhook_dedup with UNIQUE(webhook_kind, dedup_key); the
		// unique-constraint collision is the duplicate signal. The pre-check
		// above preserves replay behavior for terminal orders; this INSERT
		// preserves race-safety for concurrent valid first deliveries.
		//
		// The row is still inserted BEFORE state transitions; a mid-flight
		// crash can therefore leave the dedup row in place AND the scan_order
		// in `running`, so a retry from vps-agent gets the 200-duplicate fast
		// path and the operator must manually advance the order (logged via
		// the scheduled scan_timeout_watcher job). Invalid 404/409 callbacks
		// do not create that row.
		// ───────────────────────────────────────────────────────────────────
		try {
			db.insert(webhookDedupTable)
				.values({
					id: newId(),
					webhookKind: "scan_complete",
					dedupKey: body.scan_order_id,
					receivedAt: nowMs,
					metadataJson: JSON.stringify({
						terminal_status: body.status,
						findings_count: body.findings.length,
						evidence_archive_url: body.evidence_archive_url,
						failure_reason: body.failure_reason,
					}),
				})
				.run();
		} catch (err) {
			if (isUniqueViolation(err)) {
				return c.json(
					{
						status: "duplicate",
						scan_order_id: body.scan_order_id,
					},
					200,
				);
			}
			throw err;
		}

		// ───────────────────────────────────────────────────────────────────
		// 9. Ingest findings (one row + one finding_ingested audit each).
		//    Per-finding ingest happens OUTSIDE the state-transition tx
		//    because createFindingsIngest owns its own BEGIN per audit emit
		//    (bun:sqlite forbids nested BEGINs). Crash-safety: a crash mid-
		//    batch leaves N<full findings + 0 jobs + status=running, and the
		//    next retry from vps-agent will (a) re-insert all findings
		//    [duplicates allowed — dedup is the route's job, not ingest's],
		//    (b) finish the terminal transition, (c) emit webhook_received.
		//    To avoid duplicate findings on retry, we honour webhook_dedup in
		//    step 6 BEFORE running ingest — so a retry path that reached step 9
		//    last time and crashed before step 11 would also skip ingest the
		//    second time, leaving partial findings. That's
		//    rare enough (process crash mid-callback) to defer to T07x.
		// ───────────────────────────────────────────────────────────────────
		for (const f of body.findings) {
			const target =
				f.raw_yaml_frontmatter.affected_target ?? order.primaryDomain;
			await ingest.insertFinding({
				scanId: scanRow.id,
				target,
				finding: f,
				now: nowMs,
			});
		}

		// ───────────────────────────────────────────────────────────────────
		// 10. State transition + report row + job enqueue in ONE transaction.
		//
		// render_pdf requires an existing reports row and a reportId in the
		// payload. Keep this aligned with legacy `/api/webhooks/scan-progress`
		// so both completion callbacks produce a downloadable report.
		// ───────────────────────────────────────────────────────────────────
		const jobIds: Record<string, string> = {};
		const reportId = newId();
		await withTx(db, async (tx) => {
			tx.update(scansTable)
				.set({
					status: body.status,
					completedAt: nowMs,
					failureReason: body.status === "failed" ? body.failure_reason : null,
				})
				.where(eq(scansTable.id, scanRow.id))
				.run();

			tx.update(scanOrdersTable)
				.set({
					status: body.status,
					updatedAt: nowMs,
					failureReason: body.status === "failed" ? body.failure_reason : null,
				})
				.where(eq(scanOrdersTable.id, body.scan_order_id))
				.run();

			if (body.status === "failed") {
				const vpsInstanceId = order.vpsInstanceId;
				if (vpsInstanceId) {
					const payload: TeardownScanVmJob = {
						type: "teardown_scan_vm",
						scanOrderId: body.scan_order_id,
						scanId: scanRow.id,
						vpsInstanceId,
						...(order.vpsZone ? { vpsZone: order.vpsZone } : {}),
					};
					const jobId = newId();
					jobIds.teardown_scan_vm = jobId;
					tx.insert(jobsTable)
						.values({
							id: jobId,
							type: "teardown_scan_vm",
							payloadJson: JSON.stringify(payload),
							status: "pending",
							scheduledAt: nowMs,
							attempts: 0,
							lastError: null,
							createdAt: nowMs,
							updatedAt: nowMs,
						})
						.run();
				}
				return;
			}

			tx.insert(reportsTable)
				.values({
					id: reportId,
					scanId: scanRow.id,
					status: "pending",
					bucket: null,
					key: null,
					byteSize: null,
					renderAttempts: 0,
					lastError: null,
					expiresAt: null,
					createdAt: nowMs,
					updatedAt: nowMs,
				})
				.run();

			for (const kind of FOLLOWUP_JOB_KINDS) {
				let payload:
					| RenderPdfJob
					| SendScanCompleteTelegramJob
					| TeardownScanVmJob;
				if (kind === "render_pdf") {
					payload = {
						type: kind,
						scanId: scanRow.id,
						reportId,
					};
				} else if (kind === "send_scan_complete_telegram") {
					payload = {
						type: kind,
						scanId: scanRow.id,
						scanOrderId: body.scan_order_id,
						reportId,
						userId: scanRow.userId,
					};
				} else {
					const vpsInstanceId = order.vpsInstanceId;
					if (!vpsInstanceId) continue;
					payload = {
						type: kind,
						scanOrderId: body.scan_order_id,
						scanId: scanRow.id,
						vpsInstanceId,
						...(order.vpsZone ? { vpsZone: order.vpsZone } : {}),
					};
				}
				const jobId = newId();
				jobIds[kind] = jobId;
				tx.insert(jobsTable)
					.values({
						id: jobId,
						type: kind,
						payloadJson: JSON.stringify(payload),
						status: "pending",
						scheduledAt: nowMs,
						attempts: 0,
						lastError: null,
						createdAt: nowMs,
						updatedAt: nowMs,
					})
					.run();
			}
		});

		const refund =
			body.status === "failed" && order.paymentKind === "free_quick"
				? await refundFreeQuickQuota(scanRow.userId)
				: { refunded: false };

		// ───────────────────────────────────────────────────────────────────
		// 11. Post-commit audit (Constitution X). Emit the terminal scan event,
		//     any quota refund event, and then `webhook_received` as the
		//     idempotency anchor.
		// ───────────────────────────────────────────────────────────────────
		await emitSignedAudit(
			db,
			{
				event: body.status === "failed" ? "scan_failed" : "scan_completed",
				outcome: body.status === "failed" ? "failure" : "success",
				ts: nowMs,
				user_id: scanRow.userId,
				scan_id: scanRow.id,
				metadata: {
					scan_order_id: body.scan_order_id,
					findings_count: body.findings.length,
					duration_seconds: body.duration_seconds,
					failure_reason: body.failure_reason,
				},
			},
			{ key: auditKey },
		);

		if (refund.refunded) {
			await emitSignedAudit(
				db,
				{
					event: "free_quota_refunded",
					outcome: "success",
					ts: nowMs,
					user_id: scanRow.userId,
					metadata: {
						scan_order_id: body.scan_order_id,
						reason: body.failure_reason,
					},
				},
				{ key: auditKey },
			);
		}

		await emitSignedAudit(
			db,
			{
				event: "webhook_received",
				outcome: body.status === "failed" ? "failure" : "success",
				ts: nowMs,
				user_id: scanRow.userId,
				scan_id: scanRow.id,
				metadata: {
					scan_order_id: body.scan_order_id,
					terminal_status: body.status,
					findings_count: body.findings.length,
					evidence_archive_url: body.evidence_archive_url,
					decepticon_events_count: body.decepticon_events_count ?? null,
					failure_reason: body.failure_reason,
					free_quota_refunded: refund.refunded,
					jobs: jobIds,
				},
			},
			{ key: auditKey },
		);

		return c.json(
			{
				status: body.status === "failed" ? "failed" : "ok",
				scan_order_id: body.scan_order_id,
				findings_ingested: body.findings.length,
			},
			200,
		);
	});

	return app;
}
