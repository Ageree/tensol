import {
  createHmac,
  randomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";

/**
 * HMAC-SHA256, returning lower-case hex digest.
 * Stable against RFC 4231 test vectors.
 */
export function hmacSha256(
  key: string | Uint8Array,
  message: string | Uint8Array,
): string {
  const h = createHmac("sha256", key);
  h.update(message);
  return h.digest("hex");
}

/**
 * Constant-time string comparison.
 * Early-exit on length mismatch is permitted (length leak is not a secret-content leak).
 * Content comparison itself uses node's timingSafeEqual to avoid early termination on first diff.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return nodeTimingSafeEqual(ab, bb);
}

/**
 * Cryptographically random token, base64url-encoded (no padding).
 * Default 32 bytes → 43 chars.
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
