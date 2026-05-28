import { z } from "zod";

/**
 * Crockford ULID format: 26 chars, uppercase alphabet excluding I, L, O, U.
 *
 * Duplicated (rather than imported from `targets.ts` / `auth-proof.ts`) so this
 * schema module stays independently consumable per the T038 [P] parallelism
 * contract.
 */
const CROCKFORD_ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Three scan profiles supported by Tensol backend v2.
 *
 * Values come from `specs/001-backend-v2/data-model.md` (scans.profile column)
 * and `specs/001-backend-v2/contracts/openapi.yaml` (StartScanRequest schema):
 *
 * - `recon`    — Lightest profile: passive reconnaissance only.
 * - `standard` — Default pentest depth.
 * - `max`      — Deepest profile, longest runtime + highest cost.
 *
 * Keep this list in sync with `db/schema.ts` (scans.profile CHECK constraint).
 */
export const ScanProfileEnum = z.enum(["recon", "standard", "max"]);

export type ScanProfile = z.infer<typeof ScanProfileEnum>;

/**
 * Body schema for `POST /api/scans`.
 *
 * Both fields are REQUIRED per the OpenAPI contract (StartScanRequest):
 *
 *   required: [target_id, profile]
 *
 * The route handler is responsible for verifying that the referenced target
 * belongs to the calling user and is currently `verified` — this schema only
 * validates structural shape + ULID format + enum membership.
 */
export const StartScanBodySchema = z.object({
  target_id: z.string().length(26).regex(CROCKFORD_ULID_REGEX),
  profile: ScanProfileEnum,
});

export type StartScanBody = z.infer<typeof StartScanBodySchema>;

/**
 * Path-param schema for scan routes shaped like
 * `/api/scans/:id` and `/api/scans/:id/cancel`.
 *
 * The `:id` segment is a Crockford ULID identifying a scan row.
 */
export const ScanIdParamSchema = z.object({
  id: z.string().length(26).regex(CROCKFORD_ULID_REGEX),
});

export type ScanIdParam = z.infer<typeof ScanIdParamSchema>;
