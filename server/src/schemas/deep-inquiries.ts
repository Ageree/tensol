import { z } from "zod";

import { UlidSchema } from "./scan-orders";

/**
 * Zod schemas for the US2 Deep-inquiry lead-gen funnel.
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/contracts/openapi.yaml`
 *     (paths./v1/deep-inquiries.post.requestBody + components.schemas.DeepInquiry)
 *   - `specs/002-blackbox-mvp/data-model.md` E6 (`deep_inquiries` table)
 *   - `docs/pivot-2026-05-19-telegram-auth.md` — email becomes OPTIONAL;
 *     phone (which may hold a Telegram @handle per data-model E6
 *     "E.164 or Telegram `@handle`") stays the mandatory contact channel
 *
 * Naming convention follows `server/src/schemas/scan-orders.ts`:
 *   - `*Schema` — runtime Zod object/value
 *   - `*Enum`   — Zod enum reused across schemas
 *   - Inferred TS types exported with the unsuffixed name
 *
 * Per Constitution VII (file size ≤ 800 LOC) this single module is fine.
 * Per Constitution IX (NON-NEGOTIABLE — every route validates input with Zod,
 * every response is type-narrowed against a Zod schema), these schemas are
 * consumed by:
 *   - `POST /v1/deep-inquiries`               (CreateInquiryBodySchema)
 *   - `GET  /v1/admin/deep-inquiries`         (DeepInquiryResponseSchema[])
 *   - `PUT  /v1/admin/deep-inquiries/{id}/status` (status sub-enum)
 *
 * `UlidSchema` is imported from `./scan-orders` to avoid duplicating the
 * Crockford regex; that file is the schema-module that already exports it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Budget band per openapi enum + data-model E6 CHECK constraint.
 *
 * NOTE: `open` (not `discuss`) is the canonical "want to discuss" value.
 * The DB column allows NULL — the request body Zod treats it as
 * `.optional()` so the absence of the field is also accepted.
 */
export const BudgetBandEnum = z.enum([
  "under_500k",
  "500k_1m",
  "1m_3m",
  "3m_plus",
  "open",
]);

export type BudgetBand = z.infer<typeof BudgetBandEnum>;

/**
 * Lifecycle status per data-model E6 state machine.
 *
 *   new ─→ contacted ─→ converted
 *                    ─→ declined
 *                    ─→ dropped
 */
export const DeepInquiryStatusEnum = z.enum([
  "new",
  "contacted",
  "converted",
  "declined",
  "dropped",
]);

export type DeepInquiryStatus = z.infer<typeof DeepInquiryStatusEnum>;

// ─────────────────────────────────────────────────────────────────────────────
// Request body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Body for `POST /v1/deep-inquiries`.
 *
 * Per openapi.yaml the original required set was
 *   [company, contact_name, email, phone, domains_text, scope_text,
 *    consent_accepted]
 *
 * Per `docs/pivot-2026-05-19-telegram-auth.md` (authoritative delta):
 *   - `email` becomes OPTIONAL and NULLABLE (Resend is dropped; email is
 *     no longer the primary contact channel)
 *   - `phone` stays REQUIRED — it carries either an E.164 number OR a
 *     Telegram `@handle` per data-model E6, so the phone field IS the
 *     mandatory contact channel
 *
 * `consent_accepted` MUST be the boolean literal `true` (a checked checkbox).
 * The string `"true"` is rejected so we never accept a coerced/typo'd value.
 *
 * `.strict()` rejects unknown keys so contract drift surfaces in tests
 * rather than silently passing through.
 *
 * Field length caps mirror openapi `maxLength` exactly:
 *   - company       ≤ 200
 *   - contact_name  ≤ 200
 *   - position      ≤ 100  (optional)
 *   - phone         ≤ 50
 *   - domains_text  ≤ 10_000
 *   - scope_text    ≤ 10_000
 */
export const CreateInquiryBodySchema = z
  .object({
    company: z.string().min(1).max(200),
    contact_name: z.string().min(1).max(200),
    position: z.string().max(100).nullable().optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().min(1).max(50),
    domains_text: z.string().min(1).max(10_000),
    desired_date: z.number().int().nullable().optional(),
    budget_band: BudgetBandEnum.nullable().optional(),
    scope_text: z.string().min(1).max(10_000),
    consent_accepted: z.literal(true),
  })
  .strict();

export type CreateInquiryBody = z.infer<typeof CreateInquiryBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Response body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full Deep-inquiry read shape returned by:
 *   - GET /v1/admin/deep-inquiries           (array)
 *   - PUT /v1/admin/deep-inquiries/{id}/status (single, after status flip)
 *
 * Required vs nullable fields mirror openapi `components.schemas.DeepInquiry`.
 * Nullable fields accept `null` explicitly and are also `.optional()` because
 * the server may omit them from JSON payloads (absent key decodes to
 * `undefined`).
 */
export const DeepInquiryResponseSchema = z
  .object({
    // Required
    id: UlidSchema,
    company: z.string().max(200),
    contact_name: z.string().max(200),
    email: z.string(),
    phone: z.string().max(50),
    domains_text: z.string().max(10_000),
    scope_text: z.string().max(10_000),
    consent_accepted_at: z.number().int(),
    status: DeepInquiryStatusEnum,
    created_at: z.number().int(),

    // Nullable / optional
    user_id: UlidSchema.nullable().optional(),
    position: z.string().max(100).nullable().optional(),
    desired_date: z.number().int().nullable().optional(),
    budget_band: BudgetBandEnum.nullable().optional(),
  })
  .strict();

export type DeepInquiryResponse = z.infer<typeof DeepInquiryResponseSchema>;
