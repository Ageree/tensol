/**
 * 003-whitebox — GitHub App cryptographic primitives.
 *
 * Two pure, side-effect-free helpers:
 *   - `verifyWebhookSignature` validates the `X-Hub-Signature-256` header that
 *     GitHub attaches to every webhook delivery (HMAC-SHA256 over the raw
 *     request body, keyed by the app's webhook secret). Comparison is
 *     constant-time to avoid signature-oracle timing leaks.
 *   - `buildAppJwt` mints the short-lived RS256 JWT that authenticates the App
 *     to the GitHub REST API (used to exchange for an installation token).
 *
 * No network, no clock reads in the hot path: `buildAppJwt` accepts an
 * injectable `nowSec` so callers/tests stay deterministic. Boundary inputs are
 * validated (empty secret / missing header → reject).
 */
import { createSign } from "node:crypto";

import { hmacSha256, timingSafeEqual } from "../../lib/crypto.ts";

/** GitHub prefixes the hex digest with this scheme marker. */
const SIGNATURE_PREFIX = "sha256=";

/** App JWT validity window per GitHub docs: clock-skew slack + 9 minutes. */
const JWT_IAT_SKEW_SEC = 60;
const JWT_TTL_SEC = 540;

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header against the raw body.
 *
 * @param secret           The app's configured webhook secret. Empty → false.
 * @param rawBody          The exact bytes received (must be the raw,
 *                         unparsed request body — re-serialized JSON will not
 *                         match).
 * @param signatureHeader  Value of `X-Hub-Signature-256`, e.g. `sha256=<hex>`.
 *                         Missing/empty/malformed → false.
 * @returns true only when the recomputed HMAC matches the header.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): boolean {
  if (!secret) return false;
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

  const expected = `${SIGNATURE_PREFIX}${hmacSha256(secret, rawBody)}`;
  return timingSafeEqual(expected, signatureHeader);
}

/** Base64url-encode a UTF-8 string with no padding (JWT segment encoding). */
function b64urlString(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/**
 * Normalize a PEM that may have been flattened into a single line with literal
 * `\n` escape sequences (common when stored in an env var) back into a real
 * multi-line PEM that `node:crypto` accepts.
 */
function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

/**
 * Build the RS256 JWT a GitHub App uses to authenticate to the REST API.
 *
 * @param args.appId         The numeric App ID (string), placed in `iss`.
 * @param args.privateKeyPem The App's PKCS#1/PKCS#8 RSA private key (PEM).
 *                           Literal `\n` escapes are normalized to newlines.
 * @param args.nowSec        Epoch seconds; defaults to the current time.
 *                           Injectable for deterministic tests.
 * @returns A signed `header.payload.signature` JWT string.
 */
export function buildAppJwt(args: {
  appId: string;
  privateKeyPem: string;
  nowSec?: number;
}): string {
  const { appId } = args;
  if (!appId) throw new Error("buildAppJwt: appId is required");
  if (!args.privateKeyPem) {
    throw new Error("buildAppJwt: privateKeyPem is required");
  }

  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const privateKeyPem = normalizePem(args.privateKeyPem);

  const header = { alg: "RS256", typ: "JWT" } as const;
  const payload = {
    iat: nowSec - JWT_IAT_SKEW_SEC,
    exp: nowSec + JWT_TTL_SEC,
    iss: appId,
  } as const;

  const headerSeg = b64urlString(JSON.stringify(header));
  const payloadSeg = b64urlString(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signatureSeg = signer.sign(privateKeyPem).toString("base64url");

  return `${signingInput}.${signatureSeg}`;
}
