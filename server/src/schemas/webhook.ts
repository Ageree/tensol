import { z } from "zod";

/**
 * Crockford ULID format: 26 chars, uppercase alphabet excluding I, L, O, U.
 *
 * Duplicated (rather than imported from `targets.ts` / `scans.ts`) so this
 * schema module stays independently consumable per the T042 [P] parallelism
 * contract.
 */
const CROCKFORD_ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Finding severity levels stored in `findings.severity`.
 *
 * Values + ordering come from `specs/001-backend-v2/data-model.md`:
 *   `critical | high | medium | low | info`
 *
 * Keep this list in sync with `db/schema.ts` (findings.severity CHECK constraint).
 */
export const FindingSeverityEnum = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

export type FindingSeverity = z.infer<typeof FindingSeverityEnum>;

/**
 * Webhook terminal-status values per
 * `specs/001-backend-v2/contracts/webhook.md`:
 *
 *   "status": "done" | "failed"
 *
 * The VPS-agent emits exactly ONE callback per scan when it reaches a terminal
 * state. There is no streaming `running` status; intermediate progress is
 * inferred by the backend watchdog, not reported via this webhook.
 */
export const WebhookStatusEnum = z.enum(["done", "failed"]);

export type WebhookStatus = z.infer<typeof WebhookStatusEnum>;

/**
 * Evidence captured by the VPS-agent for a single finding. Both halves of an
 * HTTP exchange are optional because some findings (e.g. DNS, TLS) have no
 * meaningful raw request/response pair.
 *
 * Bounded at 64 KiB per half so a misbehaving agent can't OOM the backend by
 * sending megabyte-long blobs in a 1000-finding payload.
 */
export const FindingEvidenceSchema = z.object({
  request: z.string().max(65_536).optional(),
  response: z.string().max(65_536).optional(),
});

export type FindingEvidence = z.infer<typeof FindingEvidenceSchema>;

/**
 * Single finding row as reported by the VPS-agent.
 *
 * Shape mirrors the webhook contract example:
 *
 *   { severity, title, body_md, evidence: { request, response } }
 *
 * Notes vs. the DB row in `findings`:
 *
 * - `dedup_key` is NOT part of the wire contract. The backend computes it
 *   server-side as `sha256(title)` keyed by `scan_id` (see webhook.md §
 *   "Status transitions triggered"), so duplicate callbacks dedupe via the
 *   `ON CONFLICT(dedup_key) DO NOTHING` insert.
 * - `body_md` is plain markdown. The server sanitizes on read; we still
 *   bound it at 50_000 chars to keep one finding under a single SQLite
 *   page-budget worth of payload.
 */
export const FindingSchema = z.object({
  severity: FindingSeverityEnum,
  title: z.string().min(1).max(500),
  body_md: z.string().max(50_000),
  evidence: FindingEvidenceSchema.optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

/**
 * Usage statistics reported by the VPS-agent at scan completion.
 *
 * Both fields are non-negative integers. The contract says the entire `usage`
 * object MAY be `null` (the agent crashed before it could measure), so the
 * schema accepts `null` at the field site of `ScanProgressCallbackSchema`.
 */
export const WebhookUsageSchema = z.object({
  tokens: z.number().int().nonnegative(),
  usd_cents: z.number().int().nonnegative(),
});

export type WebhookUsage = z.infer<typeof WebhookUsageSchema>;

/**
 * Body schema for `POST /webhooks/scan-progress`.
 *
 * Shape from `specs/001-backend-v2/contracts/webhook.md`:
 *
 * ```json
 * {
 *   "scan_id": "01HXAB...",
 *   "status": "done" | "failed",
 *   "failure_reason": "agent_timeout" | "decepticon_crash" | null,
 *   "usage": { "tokens": 12345, "usd_cents": 87 } | null,
 *   "findings": [ ... ]
 * }
 * ```
 *
 * The route handler (T044) is responsible for:
 *
 * - Verifying `X-Tensol-Scan-Id` header matches `scan_id` in body.
 * - Verifying `X-Tensol-Signature` HMAC against the matching `vps_instances.sign_key`.
 * - Looking up the scan, asserting it is not already terminal, and applying the
 *   `done` / `failed` transition described in webhook.md.
 *
 * This Zod schema only enforces wire-level shape:
 *
 * - `scan_id` is a Crockford ULID (26 chars).
 * - `status` is one of the two terminal values.
 * - `failure_reason` is a free-form string or `null` (the contract example
 *   lists `agent_timeout` / `decepticon_crash` but does not require an
 *   exhaustive enum — agents may report future reason codes without a
 *   backend redeploy).
 * - `usage` is either a `{tokens, usd_cents}` pair of non-negative ints, or `null`.
 * - `findings` defaults to `[]` when omitted (the contract says it MAY be
 *   omitted on `failed`, and an empty array on `done` is legal). Capped at
 *   1000 entries per callback to keep a runaway agent from flooding the
 *   backend with synthetic findings.
 *
 * We use `z.object` rather than a discriminated union on `status` because
 * the field set is identical for both states — only the *semantic* meaning
 * of `failure_reason` and `findings` differs, and those nuances are handled
 * by the route handler, not the schema.
 */
export const ScanProgressCallbackSchema = z.object({
  scan_id: z.string().length(26).regex(CROCKFORD_ULID_REGEX),
  status: WebhookStatusEnum,
  failure_reason: z.string().min(1).max(255).nullable(),
  usage: WebhookUsageSchema.nullable(),
  findings: z.array(FindingSchema).max(1000).optional().default([]),
});

export type ScanProgressCallback = z.infer<typeof ScanProgressCallbackSchema>;
