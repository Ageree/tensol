import { z } from "zod";

/**
 * Crockford ULID format: 26 chars, uppercase alphabet excluding I, L, O, U.
 *
 * Duplicated (rather than imported from `targets.ts`) so this schema module
 * stays independently consumable per the T031 [P] parallelism contract.
 */
const CROCKFORD_ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Path-param schema for auth-proof routes shaped like
 * `/api/targets/:id/auth-proof/challenge` and
 * `/api/targets/:id/auth-proof/verify`.
 *
 * The `:id` segment is a Crockford ULID identifying a target row.
 */
export const TargetIdParamSchema = z.object({
  id: z.string().length(26).regex(CROCKFORD_ULID_REGEX),
});

export type TargetIdParam = z.infer<typeof TargetIdParamSchema>;

/**
 * The three auth-proof verification methods Tensol supports.
 *
 * - `dns_txt`         — TXT record at `_tensol-verify.<domain>` (or apex).
 * - `well_known_file` — File served at `/.well-known/tensol-verify.txt`.
 * - `meta_tag`        — `<meta name="tensol-verify" content="…">` in HTML head.
 *
 * The verify endpoint tries all three probes server-side; the optional
 * `prefer_method` hint in the verify body only changes ordering, not policy.
 */
export const ChallengeMethodEnum = z.enum([
  "dns_txt",
  "well_known_file",
  "meta_tag",
]);

export type ChallengeMethod = z.infer<typeof ChallengeMethodEnum>;

/**
 * Body schema for POST /api/targets/:id/auth-proof/verify.
 *
 * The endpoint is essentially bodyless — the server pulls the outstanding
 * challenge from the DB by target ID and runs all three probes regardless.
 *
 * `prefer_method` is an optional hint a client may pass to indicate which
 * probe it expects to be authoritative (useful for tests + debugging). It is
 * NOT a security control: the server still runs every probe.
 *
 * `.optional().default({})` makes `parse(undefined)` succeed, which matters
 * because Hono's `c.req.json()` may return `undefined` on a body-less POST.
 */
export const VerifyChallengeBodySchema = z
  .object({
    prefer_method: ChallengeMethodEnum.optional(),
  })
  .optional()
  .default({});

export type VerifyChallengeBody = z.infer<typeof VerifyChallengeBodySchema>;
