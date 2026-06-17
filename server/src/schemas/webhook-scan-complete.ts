import { z } from "zod";

/**
 * Zod schemas for the US1 webhook `POST /v1/webhooks/scan-complete` body
 * sent by `vps-agent` when a Decepticon scan terminates.
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/contracts/webhook.md` (wire shape, required keys)
 *   - `specs/002-blackbox-mvp/data-model.md` E5 `findings` (severity enum,
 *     CVSS range, confidence enum, raw_yaml_json forward-compat field)
 *
 * Consumed by:
 *   - the webhook route handler (T056–T058) which verifies the HMAC envelope
 *     and then validates the body with `WebhookScanCompleteBodySchema`
 *   - the findings ingest (T048–T050) which uses
 *     `FindingFromAgent.raw_yaml_frontmatter` to fill the
 *     `findings.raw_yaml_json` column and the typed columns next to it
 *
 * Naming convention mirrors `scan-orders.ts`:
 *   - `*Schema` — runtime Zod object/value
 *   - `*Enum`   — Zod enum reused across schemas
 *   - Inferred TS types exported with the unsuffixed name
 *
 * Per Constitution VII (file size ≤ 800 LOC) this single module is fine; the
 * paired test file ships as `webhook-scan-complete.test.ts`.
 *
 * Per Constitution IX (NON-NEGOTIABLE) — the route handler MUST call
 * `WebhookScanCompleteBodySchema.parse` on every inbound webhook body after
 * signature verification and before any DB write.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crockford ULID — 26 chars, uppercase alphabet excluding I, L, O, U.
 * Duplicated from `scan-orders.ts` to keep this module independently
 * consumable by T026's parallel siblings (T024/T025/T027).
 */
const CROCKFORD_ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Object storage URI used for the evidence tarball reference.
 *
 * `gs://<bucket>/<key>` — bucket validated as 3–63 chars (GCS-compatible
 * Object Storage convention), key as any non-empty path. The exact bucket
 * name match (against `tensol-evidence-*`) happens in the route handler,
 * not the schema, so test fixtures can use synthetic bucket names.
 */
const STORAGE_URI_REGEX = /^(gs|s3):\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/.+$/;

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finding severity per `data-model.md` E5 CHECK constraint:
 *
 *   CHECK (severity IN ('critical','high','medium','low','informational'))
 *
 * Note: the V1 webhook (`schemas/webhook.ts`) used `info` as the fifth value;
 * the V2 contract here uses the spelled-out `informational` to match the
 * upstream Decepticon emitter and the data-model literal.
 */
export const FindingSeverityEnum = z.enum([
	"critical",
	"high",
	"medium",
	"low",
	"informational",
]);

export type FindingSeverity = z.infer<typeof FindingSeverityEnum>;

/**
 * Reviewer confidence per `data-model.md` E5 `confidence` CHECK constraint.
 * Optional in the YAML frontmatter (some findings ship without it).
 */
export const FindingConfidenceEnum = z.enum([
	"verified",
	"high",
	"medium",
	"low",
]);

export type FindingConfidence = z.infer<typeof FindingConfidenceEnum>;

// ─────────────────────────────────────────────────────────────────────────────
// YAML frontmatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strict schema for the YAML frontmatter object emitted by Decepticon for
 * each finding markdown file (e.g. `/workspace/findings/critical-sqli.md`).
 *
 * Per `contracts/webhook.md` §"Required YAML frontmatter fields per finding":
 *   REQUIRED: id, severity, title
 *   OPTIONAL: cvss_*, cwe, mitre, affected_*, confidence, phase, agent,
 *             objective_id, discovered_at, remediation_priority
 *   UNKNOWN keys: preserved (passthrough) for forward-compat into
 *                 `findings.raw_yaml_json`.
 *
 * `passthrough()` is critical here — losing unknown keys would forfeit the
 * forward-compatibility guarantee the contract gives Decepticon.
 */
export const RawYamlFrontmatterSchema = z
	.object({
		id: z.string().min(1, { message: "Frontmatter `id` is required" }),
		severity: FindingSeverityEnum,
		title: z.string().min(1, { message: "Frontmatter `title` is required" }),

		cvss_score: z.number().min(0).max(10).optional(),
		cvss_vector: z.string().min(1).optional(),
		cvss_version: z.string().min(1).optional(),

		cwe: z.array(z.string().min(1)).optional(),
		mitre: z.array(z.string().min(1)).optional(),

		affected_target: z.string().min(1).optional(),
		affected_component: z.string().min(1).optional(),

		confidence: FindingConfidenceEnum.optional(),
		phase: z.string().min(1).optional(),
		agent: z.string().min(1).optional(),
		objective_id: z.string().min(1).optional(),

		/**
		 * `discovered_at` may arrive as either an ISO-8601 string or unix ms.
		 * Both are passed through verbatim; coercion to `INTEGER` happens in
		 * the ingest layer where the data-model column type is known.
		 */
		discovered_at: z.union([z.string().min(1), z.number().int()]).optional(),

		remediation_priority: z
			.union([z.string().min(1), z.number().int()])
			.optional(),
	})
	.passthrough();

export type RawYamlFrontmatter = z.infer<typeof RawYamlFrontmatterSchema>;

/**
 * Tiny line-oriented YAML frontmatter parser.
 *
 * Why not pull a YAML dep:
 *   - `bun` ships no YAML parser stdlib.
 *   - The Decepticon frontmatter the contract guarantees us is a flat
 *     `key: value` block — no nested mappings, no anchors, no multi-doc
 *     streams. A 30-line regex parser is sufficient and keeps the schema
 *     module zero-dep beyond zod.
 *   - The full forward-compat story relies on the route handler ALSO
 *     accepting pre-parsed objects from vps-agent (which can use any YAML
 *     lib it likes); this string-parse path is only the fallback when the
 *     agent passes the raw frontmatter through untouched.
 *
 * Supported shape (per `contracts/webhook.md`):
 *   - Optional surrounding `---` fences (stripped before parsing).
 *   - One `key: value` per line; values are trimmed.
 *   - Double-quoted values have their outer quotes stripped (so a title
 *     like `"Quoted: title with colon"` survives the colon split).
 *   - Bracketed array values (`cwe: [CWE-89, CWE-200]`) decode into a
 *     string[] with whitespace-trimmed items.
 *   - Bare numerics decode to `number` (so `cvss_score: 9.8` parses
 *     correctly against the `z.number()` field).
 *   - Blank lines and `# comment` lines are ignored.
 *
 * Unknown keys are kept as strings; `passthrough()` on the Zod schema
 * carries them into `raw_yaml_json` downstream.
 */
function parseYamlFrontmatter(raw: string): Record<string, unknown> {
	const stripped = raw
		.replace(/^---\s*\n/, "")
		.replace(/\n---\s*$/, "")
		.trim();

	const out: Record<string, unknown> = {};

	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;

		const colonIdx = line.indexOf(":");
		if (colonIdx <= 0) continue;

		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();

		// Strip surrounding double quotes (preserves the inner string verbatim).
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
			out[key] = value;
			continue;
		}

		// Bracketed array → string[].
		if (value.startsWith("[") && value.endsWith("]")) {
			const inner = value.slice(1, -1).trim();
			if (inner.length === 0) {
				out[key] = [];
			} else {
				out[key] = inner.split(",").map((item) => item.trim());
			}
			continue;
		}

		// Bare numeric → number (lets z.number() fields parse cleanly).
		if (value.length > 0 && /^-?\d+(\.\d+)?$/.test(value)) {
			out[key] = Number(value);
			continue;
		}

		out[key] = value;
	}

	return out;
}

/**
 * Wire-level type for `raw_yaml_frontmatter`:
 *
 *   - object: vps-agent pre-parsed the YAML (preferred fast path)
 *   - string: vps-agent passed the raw frontmatter through; we parse it
 *             inline with `parseYamlFrontmatter` and re-validate against
 *             `RawYamlFrontmatterSchema`.
 *
 * Both branches funnel into the same `RawYamlFrontmatter` typed result so
 * downstream consumers (route handler, findings ingest) never need to
 * branch on the wire shape.
 */
const RawYamlFrontmatterField = z
	.union([z.record(z.string(), z.unknown()), z.string().min(1)])
	.transform((value, ctx) => {
		const candidate =
			typeof value === "string" ? parseYamlFrontmatter(value) : value;

		const parsed = RawYamlFrontmatterSchema.safeParse(candidate);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				ctx.addIssue({
					...issue,
					path: ["raw_yaml_frontmatter", ...issue.path],
				});
			}
			return z.NEVER;
		}
		return parsed.data;
	});

// ─────────────────────────────────────────────────────────────────────────────
// Per-finding wire shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One finding as it arrives on the webhook wire.
 *
 * Field caps:
 *   - `body_md` capped at 50 KiB per finding — same envelope the V1
 *     webhook used; keeps a misbehaving agent from OOM'ing the backend
 *     with one massive finding.
 *   - `evidence_keys` capped at 100 keys per finding (defensive bound;
 *     the contract puts no explicit upper limit but anything past this
 *     is almost certainly the agent looping).
 */
export const FindingFromAgentSchema = z.object({
	raw_yaml_frontmatter: RawYamlFrontmatterField,
	body_md: z.string().max(50_000),
	evidence_keys: z.array(z.string().min(1)).max(100),
});

export type FindingFromAgent = z.infer<typeof FindingFromAgentSchema>;

export const WebhookTerminalStatusEnum = z.enum(["completed", "failed"]);

export type WebhookTerminalStatus = z.infer<typeof WebhookTerminalStatusEnum>;

// ─────────────────────────────────────────────────────────────────────────────
// Top-level body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full body of `POST /v1/webhooks/scan-complete` per `contracts/webhook.md`.
 *
 * Outer envelope checks:
 *   - `scan_order_id` is a Crockford ULID matching an existing
 *     `scan_orders.id` (existence checked in the route handler, not here)
 *   - `completed_at` is a positive integer unix-ms timestamp; freshness
 *     window enforcement (within last 24h) happens in the route handler
 *     where wall-clock-vs-DB-clock semantics live
 *   - `findings` is an array (may be empty for zero-findings scans),
 *     capped at 1000 to bound the per-request memory + DB write budget
 *   - `status` defaults to `completed` for legacy payloads; `failed` is a
 *     terminal runner-failure callback
 *   - `evidence_archive_url` is a `gs://`/legacy `s3://` URI when present; completed
 *     callbacks require it and bucket-name policy enforcement is in the route
 *     handler. Failed callbacks may omit it.
 *   - `duration_seconds` is a non-negative integer
 *   - `decepticon_events_count` is an optional observability metric
 */
export const WebhookScanCompleteBodySchema = z
	.object({
		scan_order_id: z.string().length(26).regex(CROCKFORD_ULID_REGEX, {
			message: "scan_order_id must be a 26-character Crockford ULID",
		}),
		status: WebhookTerminalStatusEnum.optional().default("completed"),
		failure_reason: z.string().min(1).max(255).nullable().optional(),
		completed_at: z.number().int().positive(),
		decepticon_events_count: z.number().int().nonnegative().optional(),
		findings: z.array(FindingFromAgentSchema).max(1000),
		evidence_archive_url: z
			.string()
			.regex(STORAGE_URI_REGEX, {
				message: "evidence_archive_url must be a gs:// URI",
			})
			.nullable()
			.optional(),
		duration_seconds: z.number().int().nonnegative(),
	})
	.superRefine((value, ctx) => {
		if (value.status === "completed" && !value.evidence_archive_url) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["evidence_archive_url"],
				message: "evidence_archive_url is required when status is completed",
			});
		}
		if (value.status === "failed" && !value.failure_reason) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["failure_reason"],
				message: "failure_reason is required when status is failed",
			});
		}
	})
	.transform((value) => ({
		...value,
		failure_reason:
			value.status === "failed" ? (value.failure_reason ?? null) : null,
		evidence_archive_url: value.evidence_archive_url ?? null,
	}));

export type WebhookScanCompleteBody = z.infer<
	typeof WebhookScanCompleteBodySchema
>;
