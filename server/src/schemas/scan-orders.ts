import { z } from "zod";

/**
 * Zod schemas for the US1 scan-order lifecycle.
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/contracts/openapi.yaml` (components.schemas.*)
 *   - `specs/002-blackbox-mvp/data-model.md` E2 (`scan_orders` table)
 *
 * Consumed by route handlers under `server/src/routes/scan-orders/*`
 * (T036–T044) per Constitution IX (NON-NEGOTIABLE — every route validates
 * input with Zod, every response is type-narrowed against a Zod schema).
 *
 * Naming convention follows the rest of `server/src/schemas/`:
 *   - `*Schema`      — runtime Zod object/value
 *   - `*Enum`        — Zod enum reused across schemas
 *   - Inferred TS types exported with the unsuffixed name
 *     (e.g. `export type CreateScanOrderBody = z.infer<...>`)
 *
 * Per Constitution VII (file size ≤ 800 LOC) this single module is fine; if
 * we grow more variants (e.g. admin filters), consider splitting per-route.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crockford ULID — 26 chars, uppercase alphabet excluding I, L, O, U.
 * Mirrors `components.schemas.ULID` in openapi.yaml and the regex used
 * across other schemas in this directory (kept local for module
 * independence per the existing pattern).
 */
const CROCKFORD_ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Hostname schema mirroring `components.schemas.Hostname`.
 *
 * Pattern enforces:
 *   - Lowercase RFC 1035 labels (a-z, 0-9, hyphen)
 *   - Labels may not start or end with a hyphen
 *   - Optional dot-separated subdomains
 *   - No trailing dot, no scheme prefix, no IP literal
 *
 * Length cap of 253 bytes matches DNS spec and the openapi `maxLength`.
 */
export const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
    {
      message:
        "Must be a lowercase RFC 1035 hostname (no scheme, no trailing dot, no IP literal)",
    },
  );

export type Hostname = z.infer<typeof HostnameSchema>;

/**
 * 26-char Crockford ULID.
 *
 * Length(26) checked explicitly so error messages stay actionable; the
 * regex is the authoritative validator.
 */
export const UlidSchema = z
  .string()
  .length(26)
  .regex(CROCKFORD_ULID_REGEX, {
    message: "Must be a 26-character Crockford ULID",
  });

export type Ulid = z.infer<typeof UlidSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `scan_orders.status` per data-model E2 and openapi enum.
 * Order matches the state-machine progression for readability.
 */
export const ScanOrderStatusEnum = z.enum([
  "draft",
  "dns_pending",
  "dns_verified",
  "vm_provisioning",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type ScanOrderStatus = z.infer<typeof ScanOrderStatusEnum>;

/**
 * Tier enum on the read-shape. MVP only writes 'quick'; 'deep' is accepted
 * on reads for forward-compat with the Deep inquiry pipeline (records
 * created out-of-band).
 */
export const ScanOrderTierEnum = z.enum(["quick", "deep"]);

export type ScanOrderTier = z.infer<typeof ScanOrderTierEnum>;

/**
 * Payment-kind enum per data-model E2. `free_quick` is the default for MVP;
 * `yookassa` is reserved for the future paid path.
 */
export const PaymentKindEnum = z.enum(["free_quick", "yookassa"]);

export type PaymentKind = z.infer<typeof PaymentKindEnum>;

// ─────────────────────────────────────────────────────────────────────────────
// AttackSurfaceEntry — one row of the attack_surface JSON array.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single attack-surface entry.
 *
 * Shape per openapi `AttackSurfaceEntry`:
 *   - `domain`  — Hostname
 *   - `primary` — boolean (exactly one entry per order should be primary,
 *                 enforced by the service layer, not this schema)
 *   - `headers` — array of `{k, v}` with max 10 items per data-model E2;
 *                 k ≤ 64 chars, v ≤ 1024 chars per openapi
 *
 * `.strict()` rejects unknown keys so contract drift surfaces in tests
 * rather than silently passing through.
 */
export const AttackSurfaceEntrySchema = z
  .object({
    domain: HostnameSchema,
    primary: z.boolean(),
    headers: z
      .array(
        z
          .object({
            k: z.string().min(1).max(64),
            v: z.string().max(1024),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export type AttackSurfaceEntry = z.infer<typeof AttackSurfaceEntrySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Request bodies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Body for `POST /v1/scan-orders` (Step 0 — wizard entrypoint).
 *
 * Per openapi.yaml `paths./v1/scan-orders.post.requestBody`:
 *   required: [tier, primary_domain]
 *   tier:    enum [quick]  (Deep does NOT create scan-orders in MVP)
 *   primary_domain: Hostname
 *
 * NOTE: only `quick` is allowed on create — `deep` is rejected. The read
 * shape (`ScanOrderResponseSchema.tier`) is wider.
 */
export const CreateScanOrderBodySchema = z
  .object({
    tier: z.literal("quick"),
    primary_domain: HostnameSchema,
  })
  .strict();

export type CreateScanOrderBody = z.infer<typeof CreateScanOrderBodySchema>;

/**
 * Body for `PUT /v1/scan-orders/{id}/attack-surface` (Step 1 commit).
 *
 * Per openapi:
 *   required: [attack_surface]
 *   attack_surface: array, minItems=1, maxItems=20, items=AttackSurfaceEntry
 *
 * The 1..20 bound mirrors data-model E2 ("max 20 items"). Exactly-one-primary
 * is a business invariant enforced in the service layer, not here.
 */
export const UpdateAttackSurfaceBodySchema = z
  .object({
    attack_surface: z.array(AttackSurfaceEntrySchema).min(1).max(20),
  })
  .strict();

export type UpdateAttackSurfaceBody = z.infer<
  typeof UpdateAttackSurfaceBodySchema
>;

/**
 * Body for `PUT /v1/scan-orders/{id}/safety` (Step 2 commit).
 *
 * Per openapi + data-model E2 CHECK constraint:
 *   safety_rps: integer in [1, 500]
 *
 * `.int()` rejects fractional numbers so we don't silently truncate
 * (50.5 → 50) at the DB layer.
 */
export const UpdateSafetyBodySchema = z
  .object({
    safety_rps: z.number().int().min(1).max(500),
  })
  .strict();

export type UpdateSafetyBody = z.infer<typeof UpdateSafetyBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Response body for `POST /v1/scan-orders/{id}/launch` (HTTP 202).
 *
 * Per openapi.yaml the 202 schema is:
 *   required: [scan_id]
 *   scan_id: ULID
 *
 * The launch endpoint creates the `scans` row and returns its id only;
 * status is implied (running soon, observable via GET /v1/scans/{id}).
 */
export const LaunchScanOrderResponseSchema = z
  .object({
    scan_id: UlidSchema,
  })
  .strict();

export type LaunchScanOrderResponse = z.infer<
  typeof LaunchScanOrderResponseSchema
>;

/**
 * Full scan-order read shape returned by:
 *   - GET    /v1/scan-orders        (array)
 *   - GET    /v1/scan-orders/{id}
 *   - POST   /v1/scan-orders        (201)
 *   - PUT    /v1/scan-orders/{id}/attack-surface (200)
 *   - PUT    /v1/scan-orders/{id}/safety         (200)
 *   - DELETE /v1/scan-orders/{id}                (200)
 *
 * Required vs nullable fields mirror openapi `ScanOrder` exactly. Nullable
 * fields accept `null` explicitly and are also `.optional()` because the
 * server may omit them entirely from JSON payloads (and an absent key
 * decodes to `undefined` server-side).
 */
export const ScanOrderResponseSchema = z
  .object({
    // Required
    id: UlidSchema,
    user_id: UlidSchema,
    status: ScanOrderStatusEnum,
    tier: ScanOrderTierEnum,
    primary_domain: HostnameSchema,
    attack_surface: z.array(AttackSurfaceEntrySchema).max(20),
    safety_rps: z.number().int().min(1).max(500),
    payment_kind: PaymentKindEnum,
    created_at: z.number().int(),
    updated_at: z.number().int(),

    // Nullable
    dns_verify_token: z.string().nullable().optional(),
    dns_verified_at: z.number().int().nullable().optional(),
    scan_id: UlidSchema.nullable().optional(),
    failure_reason: z.string().nullable().optional(),
    amount_kopecks: z.number().int().nullable().optional(),
  })
  .strict();

export type ScanOrderResponse = z.infer<typeof ScanOrderResponseSchema>;
