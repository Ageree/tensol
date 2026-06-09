/**
 * T100 — DeepInquiriesService: US2 lead-gen funnel API.
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/spec.md` FR-031..FR-038 (deep-engagement flow)
 *   - `specs/002-blackbox-mvp/data-model.md` §E6 (deep_inquiries + state machine)
 *   - `specs/002-blackbox-mvp/contracts/openapi.yaml` (POST /v1/deep-inquiries +
 *     PUT /v1/admin/deep-inquiries/{id}/status)
 *   - `docs/pivot-2026-05-19-telegram-auth.md` (email becomes optional;
 *     phone carries E.164 OR Telegram @handle)
 *
 * Public API (4 methods):
 *   1. createInquiry({body, userId?})
 *      - sanitizes `scope_text` via `sanitizeScopeText` (T098) BEFORE persist
 *      - INSERTs row with status='new', user_id=null if anonymous
 *      - emits `inquiry_received` audit AFTER tx commit
 *      - enqueues `send_deep_inquiry_telegram` job (T102 handler)
 *      - returns `{id, sanitization: {redactedCount, rulesHit}}`
 *
 *   2. setStatus(id, newStatus)
 *      - validates against VALID_TRANSITIONS:
 *           new       → contacted | declined | dropped
 *           contacted → converted | declined | dropped
 *           converted → ∅ (terminal)
 *           declined  → ∅ (terminal)
 *           dropped   → new (operator re-open)
 *      - UPDATEs row + updated_at in a tx
 *      - emits `inquiry_status_changed` audit AFTER commit
 *      - throws NOT_FOUND if id missing, CONFLICT if illegal transition
 *
 *   3. getInquiry(id) → row | null
 *   4. listInquiries({status?, limit?}) → newest-first, optional filter
 *
 * Constitution invariants:
 *   - VI:  illegal transition → throw `Error` with `code='CONFLICT'`.
 *   - VII: file ≤ 800 LOC.
 *   - IX:  request body is already Zod-validated at the route boundary
 *          (the route layer calls `CreateInquiryBodySchema.parse(req.body)`
 *          before invoking this service); we trust the shape.
 *   - X:   every state-changing op emits a signed audit row AFTER the
 *          controlling tx commits (bun:sqlite cannot nest BEGINs).
 *
 * Error-tag convention (mirrors scan-orders/service.ts):
 *   throw new Error('...'); (err as any).code = 'NOT_FOUND' | 'CONFLICT'
 *
 * DB column → field mapping (data-model E6):
 *   - DB `email` is NOT NULL — per pivot, body.email is optional. When the
 *     body omits it we store the empty string (the column will be widened to
 *     nullable in a later migration; until then the empty string is the
 *     compatibility sentinel). Routes that read the row treat '' as absent.
 *   - `consent_accepted_at` is the ts at which the body's literal `true`
 *     was received; the body never carries a timestamp itself.
 *   - `telegram_sent_at` / `telegram_send_attempts` are mutated by T102's
 *     handler, not by this service.
 *
 * Job enqueue contract:
 *   - Default path: INSERT into `jobs` directly (mirrors scan-orders).
 *   - DI override: `deps.enqueueJob(kind, payload)` lets the route layer or
 *     tests substitute the runner without touching the DB. The default
 *     implementation is intentionally narrow: this service only enqueues
 *     `send_deep_inquiry_telegram`.
 */
import { and, desc, eq } from "drizzle-orm";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
	type DeepInquiry as DeepInquiryRow,
	deepInquiries as deepInquiriesTable,
	jobs as jobsTable,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import type {
	CreateInquiryBody,
	DeepInquiryResponse,
	DeepInquiryStatus,
} from "../schemas/deep-inquiries.ts";
import { type SanitizeResult, sanitizeScopeText } from "./sanitize.ts";

// ─────────────────────────────────────────────────────────────────────────────
// State-machine transition matrix (data-model.md §E6).
//
// `dropped → new` is the operator's re-open path. `converted` and `declined`
// are terminal — once set, no outgoing arrows. We deliberately reject
// no-op transitions (e.g. `new → new`) with CONFLICT so the route layer
// surfaces operator clicks that wouldn't actually change anything.
// ─────────────────────────────────────────────────────────────────────────────
const VALID_TRANSITIONS: Readonly<
	Record<DeepInquiryStatus, ReadonlyArray<DeepInquiryStatus>>
> = Object.freeze({
	new: ["contacted", "declined", "dropped"],
	contacted: ["converted", "declined", "dropped"],
	converted: [],
	declined: [],
	dropped: ["new"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateInquiryArgs {
	/** Body already validated by the route layer's `CreateInquiryBodySchema.parse`. */
	readonly body: CreateInquiryBody;
	/** Authenticated user id; `null`/`undefined` for the anonymous funnel. */
	readonly userId?: string | null;
}

export interface CreateInquiryResult {
	readonly id: string;
	readonly sanitization: {
		readonly redactedCount: number;
		readonly rulesHit: ReadonlyArray<string>;
	};
}

export interface ListInquiriesOpts {
	readonly status?: DeepInquiryStatus;
	readonly limit?: number;
	readonly cursor?: string;
}

export interface SetStatusOpts {
	readonly actorUserId?: string;
}

export interface DeepInquiriesService {
	createInquiry(args: CreateInquiryArgs): Promise<CreateInquiryResult>;
	setStatus(
		inquiryId: string,
		newStatus: DeepInquiryStatus,
		opts?: SetStatusOpts,
	): Promise<void>;
	getInquiry(inquiryId: string): Promise<DeepInquiryResponse | null>;
	listInquiries(opts?: ListInquiriesOpts): Promise<DeepInquiryResponse[]>;
}

/** Job-enqueue surface. Default impl writes to the `jobs` table; tests and
 *  callers that already own a runner can DI a stub. */
export type EnqueueJobFn = (kind: string, payload: unknown) => Promise<string>;

export interface CreateDeepInquiriesServiceDeps {
	readonly db: DB;
	readonly auditKey: string;
	readonly enqueueJob?: EnqueueJobFn;
	readonly now?: () => number;
	readonly newId?: () => string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error helpers
// ─────────────────────────────────────────────────────────────────────────────

type ErrCode = "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST";

function tagged(code: ErrCode, message: string): Error {
	const e = new Error(message) as Error & { code: ErrCode };
	e.code = code;
	return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → DeepInquiryResponse mapper
// ─────────────────────────────────────────────────────────────────────────────

function rowToResponse(row: DeepInquiryRow): DeepInquiryResponse {
	return {
		id: row.id,
		company: row.company,
		contact_name: row.contactName,
		email: row.email,
		phone: row.phone,
		domains_text: row.domainsText,
		scope_text: row.scopeText,
		consent_accepted_at: row.consentAcceptedAt,
		status: row.status as DeepInquiryStatus,
		created_at: row.createdAt,
		user_id: row.userId ?? null,
		position: row.position ?? null,
		desired_date: row.desiredDate ?? null,
		budget_band: (row.budgetBand ?? null) as DeepInquiryResponse["budget_band"],
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createDeepInquiriesService(
	deps: CreateDeepInquiriesServiceDeps,
): DeepInquiriesService {
	const { db, auditKey } = deps;
	const nowFn = deps.now ?? defaultNow;
	const newIdFn = deps.newId ?? (() => ulid(nowFn()));

	/** Default job-enqueue: INSERT into the `jobs` table. */
	const defaultEnqueue: EnqueueJobFn = async (kind, payload) => {
		if (kind !== "send_deep_inquiry_telegram") {
			throw new Error(`deep inquiries: unsupported job kind '${kind}'`);
		}
		const ts = nowFn();
		const jobId = newIdFn();
		await withTx(db, async (tx) => {
			tx.insert(jobsTable)
				.values({
					id: jobId,
					type: kind,
					payloadJson: JSON.stringify(payload),
					status: "pending",
					scheduledAt: ts,
					attempts: 0,
					lastError: null,
					createdAt: ts,
					updatedAt: ts,
				})
				.run();
		});
		return jobId;
	};
	const enqueueJob = deps.enqueueJob ?? defaultEnqueue;

	/** Load by id, return null if missing. */
	function loadOrNull(inquiryId: string): DeepInquiryRow | null {
		const row = db
			.select()
			.from(deepInquiriesTable)
			.where(eq(deepInquiriesTable.id, inquiryId))
			.get();
		return row ?? null;
	}

	function loadOrThrow(inquiryId: string): DeepInquiryRow {
		const row = loadOrNull(inquiryId);
		if (!row) throw tagged("NOT_FOUND", "deep inquiry not found");
		return row;
	}

	// ───────────────────────────────────────────────────────────────────────
	// createInquiry
	// ───────────────────────────────────────────────────────────────────────
	async function createInquiry(
		args: CreateInquiryArgs,
	): Promise<CreateInquiryResult> {
		const { body, userId } = args;
		const ts = nowFn();
		const id = newIdFn();

		// Sanitize BEFORE persist (FR-034). The redacted string is what goes
		// into the DB AND what the Telegram handler later reads — operators
		// never see the raw credentials.
		const sanRes: SanitizeResult = sanitizeScopeText(body.scope_text);

		// Per pivot: email is optional in the body but NOT NULL in the column.
		// Store empty string when absent; readers treat '' as missing.
		const emailValue = body.email ?? "";

		await withTx(db, async (tx) => {
			tx.insert(deepInquiriesTable)
				.values({
					id,
					userId: userId ?? null,
					company: body.company,
					contactName: body.contact_name,
					position: body.position ?? null,
					email: emailValue,
					phone: body.phone,
					domainsText: body.domains_text,
					desiredDate: body.desired_date ?? null,
					budgetBand: body.budget_band ?? null,
					scopeText: sanRes.sanitized,
					consentAcceptedAt: ts,
					status: "new",
					telegramSentAt: null,
					telegramSendAttempts: 0,
					createdAt: ts,
					updatedAt: ts,
				})
				.run();
		});

		// Constitution X: audit AFTER commit.
		await emitSignedAudit(
			db,
			{
				event: "inquiry_received",
				outcome: "success",
				ts,
				user_id: userId ?? null,
				metadata: {
					inquiry_id: id,
					company: body.company,
					anonymous: userId == null,
					sanitization_redactions: sanRes.redactedCount,
					sanitization_rules_hit: sanRes.rulesHit,
				},
			},
			{ key: auditKey },
		);

		// Enqueue the operator-notification job. The handler (T102) reads
		// the row, formats the Telegram message, and POSTs to bot API. If the
		// enqueue fails we DON'T roll back the inquiry — the spec requires the
		// record to persist even if Telegram delivery is delayed (operator can
		// re-trigger from the admin UI). We surface the error to the caller
		// so they can decide whether to 500 or 202.
		await enqueueJob("send_deep_inquiry_telegram", {
			type: "send_deep_inquiry_telegram",
			inquiry_id: id,
		});

		return {
			id,
			sanitization: {
				redactedCount: sanRes.redactedCount,
				rulesHit: sanRes.rulesHit,
			},
		};
	}

	// ───────────────────────────────────────────────────────────────────────
	// setStatus
	// ───────────────────────────────────────────────────────────────────────
	async function setStatus(
		inquiryId: string,
		newStatus: DeepInquiryStatus,
		opts?: SetStatusOpts,
	): Promise<void> {
		const row = loadOrThrow(inquiryId);
		const current = row.status as DeepInquiryStatus;

		const allowed = VALID_TRANSITIONS[current] ?? [];
		if (!allowed.includes(newStatus)) {
			throw tagged("CONFLICT", `illegal transition: ${current} → ${newStatus}`);
		}

		const ts = nowFn();
		await withTx(db, async (tx) => {
			tx.update(deepInquiriesTable)
				.set({ status: newStatus, updatedAt: ts })
				.where(eq(deepInquiriesTable.id, inquiryId))
				.run();
		});

		await emitSignedAudit(
			db,
			{
				event: "inquiry_status_changed",
				outcome: "success",
				ts,
				user_id: opts?.actorUserId ?? null,
				metadata: {
					inquiry_id: inquiryId,
					from_status: current,
					to_status: newStatus,
				},
			},
			{ key: auditKey },
		);
	}

	// ───────────────────────────────────────────────────────────────────────
	// getInquiry / listInquiries
	// ───────────────────────────────────────────────────────────────────────
	async function getInquiry(
		inquiryId: string,
	): Promise<DeepInquiryResponse | null> {
		const row = loadOrNull(inquiryId);
		return row ? rowToResponse(row) : null;
	}

	async function listInquiries(
		opts?: ListInquiriesOpts,
	): Promise<DeepInquiryResponse[]> {
		// Drizzle's chain doesn't expose a uniform "maybe-where" so we branch.
		const limit = opts?.limit ?? 100;
		const rows = opts?.status
			? db
					.select()
					.from(deepInquiriesTable)
					.where(eq(deepInquiriesTable.status, opts.status))
					.orderBy(desc(deepInquiriesTable.createdAt))
					.limit(limit)
					.all()
			: db
					.select()
					.from(deepInquiriesTable)
					.orderBy(desc(deepInquiriesTable.createdAt))
					.limit(limit)
					.all();
		return rows.map(rowToResponse);
	}

	return {
		createInquiry,
		setStatus,
		getInquiry,
		listInquiries,
	};
}

// Suppress unused-import warning for `and` (kept for future composite-where
// filters when cursor pagination is fleshed out).
void and;
