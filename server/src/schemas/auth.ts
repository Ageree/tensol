import { z } from "zod";

/**
 * Body schema for POST /api/auth/request-link.
 *
 * Per OpenAPI contract: `{ email: string<email> }`.
 * - Trimmed + lowercased so equality comparisons against the `users` table are
 *   canonical regardless of how the client capitalised the input.
 * - 254-character cap matches the RFC 5321 maximum forward-path length, which
 *   is the upper bound any real SMTP system will accept.
 */
export const RequestLinkBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export type RequestLinkBody = z.infer<typeof RequestLinkBodySchema>;

/**
 * Query schema for GET /api/auth/verify?token=...
 *
 * The token is a base64url-encoded 32-byte random value (~43 chars). We do not
 * enforce the alphabet here — the lookup against `magic_links.token_hash` is
 * the authoritative validator. The bounds exist purely to reject obviously
 * malformed input cheaply.
 */
export const VerifyLinkQuerySchema = z.object({
  token: z.string().min(1).max(128),
});

export type VerifyLinkQuery = z.infer<typeof VerifyLinkQuerySchema>;
