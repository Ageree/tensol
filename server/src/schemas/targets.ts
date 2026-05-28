import { z } from "zod";

/**
 * Crockford ULID format: 26 chars, uppercase alphabet excluding I, L, O, U.
 * Kept local (rather than importing from `projects.ts`) so the two schema
 * modules stay independently consumable.
 */
const CROCKFORD_ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Body schema for POST /api/projects/:projectId/targets.
 *
 * Per OpenAPI contract: `{ url: string<url> }`.
 * - Trimmed so accidental whitespace from copy-paste does not poison the URL.
 * - `.url()` enforces the WHATWG URL syntax; it does NOT enforce HTTP(S)
 *   scheme — that, plus private-IP/localhost rejection, lives in the
 *   `url-guard` invariant invoked by the service layer (T020 / T029).
 * - 2048 char cap mirrors the de-facto browser/CDN URL length ceiling.
 */
export const CreateTargetBodySchema = z.object({
  url: z.string().trim().url().max(2048),
});

export type CreateTargetBody = z.infer<typeof CreateTargetBodySchema>;

/**
 * Path-param schema for routes shaped like `/api/targets/:id`.
 */
export const TargetIdParamSchema = z.object({
  id: z.string().length(26).regex(CROCKFORD_ULID_REGEX),
});

export type TargetIdParam = z.infer<typeof TargetIdParamSchema>;
