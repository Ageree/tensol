import { z } from "zod";

/**
 * Crockford ULID format: 26 chars, uppercase alphabet excluding I, L, O, U.
 *
 * See https://github.com/ulid/spec — the canonical encoding is 26 base-32
 * characters using the Crockford alphabet (0-9, A-Z minus I, L, O, U).
 * Path params arrive as untrusted strings; this regex is the cheapest gate
 * before any database lookup.
 */
const CROCKFORD_ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Body schema for POST /api/projects.
 *
 * Per OpenAPI contract: `{ name: string }`.
 * - Trimmed so leading/trailing whitespace never reaches storage.
 * - min(1) on the trimmed value rejects whitespace-only names.
 * - max(100) matches the `projects.name` column constraint in data-model.md.
 */
export const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

/**
 * Path-param schema for routes shaped like `/api/projects/:id`.
 *
 * The ULID format check is structural; ownership and existence are enforced
 * downstream by the service layer.
 */
export const ProjectIdParamSchema = z.object({
  id: z.string().length(26).regex(CROCKFORD_ULID_REGEX),
});

export type ProjectIdParam = z.infer<typeof ProjectIdParamSchema>;
