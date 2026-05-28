/**
 * T131 — outbound webhook signing for vps-agent → backend.
 *
 * Produces the `X-Tensol-Signature` header in the exact envelope the server's
 * verifier expects (see `server/src/routes/webhooks-scan-complete.ts` and
 * `specs/002-blackbox-mvp/contracts/webhook.md`):
 *
 *     X-Tensol-Signature: t=<unix-seconds>, v1=<lowercase hex hmac_sha256>
 *
 * The HMAC payload is literally the concatenation `${t}.${body_bytes}` — so
 * both `t` and the body must travel together; tampering with either
 * invalidates the signature.
 *
 * Constitution II (NON-NEGOTIABLE): every byte here is mirrored by the
 * server-side verifier. If you change the envelope shape, change both sides
 * AND update the golden vector in `tests/webhook-sign.test.ts`.
 *
 * Why a separate module from the legacy `callback.ts` signer:
 *   - `callback.ts` ships the V1 contract (single-header `X-Tensol-Signature:
 *     <hex>` with no timestamp envelope) and is still wired into the older
 *     001-backend-v2 webhook receiver. The V2 receiver under
 *     002-blackbox-mvp introduces the Stripe-style `t=,v1=` envelope plus a
 *     ±5 minute replay window. Keeping the two signers in separate modules
 *     lets the legacy path retire independently when 001 is cut over.
 */
import { createHmac } from "node:crypto";

export interface SignWebhookOpts {
  /** Shared HMAC-SHA256 secret (`TENSOL_WEBHOOK_SECRET` on the server side,
   *  provisioned per-VM via cloud-init). */
  readonly secret: string;
  /** Raw outbound body bytes — must be byte-identical to what is sent over
   *  the wire. Pass a string for JSON, or a Buffer for binary-safe input. */
  readonly body: string | Buffer;
  /** Unix seconds. Defaults to `Math.floor(Date.now() / 1000)`. Inject in
   *  tests to pin determinism against a golden vector. */
  readonly timestamp?: number;
}

export interface SignWebhookResult {
  /** Full header value: `t=<sec>, v1=<hex>` — drop straight into the
   *  `X-Tensol-Signature` request header. */
  readonly signature: string;
  /** The unix seconds value that went into the signed-string prefix. Returned
   *  separately so callers (or tests) can re-verify without re-parsing the
   *  envelope. */
  readonly timestamp: number;
}

/**
 * Compute the X-Tensol-Signature envelope for the given body + secret.
 *
 * Pure function — does not mutate inputs, does not touch globals, does not
 * sleep. Same inputs → same output, always.
 */
export function signWebhook(opts: SignWebhookOpts): SignWebhookResult {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);

  // Normalise body to a Buffer so the HMAC sees the exact byte sequence the
  // network will carry. Strings are encoded as UTF-8 — same as Buffer.from
  // default and same as Node's `fetch` for string `body:` values.
  const bodyBuf =
    typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : opts.body;

  // Signed string per contract: "${t}.${body}". We build it via Buffer.concat
  // so a Buffer body is signed byte-for-byte without any utf8 re-encode pass.
  const prefix = Buffer.from(`${timestamp}.`, "utf8");
  const signedBytes = Buffer.concat([prefix, bodyBuf]);

  const hex = createHmac("sha256", opts.secret)
    .update(signedBytes)
    .digest("hex");

  return {
    signature: `t=${timestamp}, v1=${hex}`,
    timestamp,
  };
}

/**
 * Convenience wrapper — produces a headers object ready to spread into
 * `fetch(url, { headers })`. Always sets `Content-Type: application/json`
 * because the webhook body is JSON per `contracts/webhook.md` §"Body schema".
 */
export function buildSignedHeaders(
  opts: SignWebhookOpts,
): Record<string, string> {
  const result = signWebhook(opts);
  return {
    "Content-Type": "application/json",
    "X-Tensol-Signature": result.signature,
  };
}
