/**
 * Tests for `github/sign.ts`.
 *
 * Covers:
 *   - `verifyWebhookSignature(secret, rawBody, header)` — GitHub
 *     `X-Hub-Signature-256` HMAC verification (true/false/tamper/empty).
 *   - `buildAppJwt({ appId, privateKeyPem, nowSec })` — RS256 GitHub App JWT.
 *
 * Determinism: a fresh RSA keypair is generated inside the suite via
 * `node:crypto.generateKeyPairSync`; `nowSec` is injected so the payload
 * timestamps are fixed.
 */
import { describe, expect, test } from "bun:test";
import {
  createVerify,
  generateKeyPairSync,
} from "node:crypto";

import { hmacSha256 } from "../../lib/crypto.ts";
import { buildAppJwt, verifyWebhookSignature } from "./sign.ts";

// ───────────────────────────────────────────────────────────────────────────
// verifyWebhookSignature
// ───────────────────────────────────────────────────────────────────────────

describe("verifyWebhookSignature", () => {
  const secret = "s3cr3t-webhook-key";
  const body = JSON.stringify({ action: "opened", number: 7 });

  function header(b: string): string {
    return `sha256=${hmacSha256(secret, b)}`;
  }

  test("returns true for a correct signature", () => {
    expect(verifyWebhookSignature(secret, body, header(body))).toBe(true);
  });

  test("returns false for a tampered body", () => {
    const tampered = body + " ";
    expect(verifyWebhookSignature(secret, tampered, header(body))).toBe(false);
  });

  test("returns false for a tampered signature", () => {
    const good = header(body);
    const bad = good.slice(0, -1) + (good.endsWith("a") ? "b" : "a");
    expect(verifyWebhookSignature(secret, body, bad)).toBe(false);
  });

  test("returns false for a wrong secret", () => {
    const wrong = `sha256=${hmacSha256("other-secret", body)}`;
    expect(verifyWebhookSignature(secret, body, wrong)).toBe(false);
  });

  test("returns false for a missing/null/undefined header", () => {
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "")).toBe(false);
  });

  test("returns false for an empty secret even with a header", () => {
    expect(verifyWebhookSignature("", body, header(body))).toBe(false);
  });

  test("returns false when the header lacks the sha256= prefix", () => {
    const hex = hmacSha256(secret, body);
    expect(verifyWebhookSignature(secret, body, hex)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildAppJwt
// ───────────────────────────────────────────────────────────────────────────

function b64urlToJson(seg: string): Record<string, unknown> {
  const json = Buffer.from(seg, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

describe("buildAppJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const privateKeyPem = privateKey as string;
  const publicKeyPem = publicKey as string;

  const appId = "123456";
  const nowSec = 1_700_000_000;

  test("produces a 3-segment JWT", () => {
    const jwt = buildAppJwt({ appId, privateKeyPem, nowSec });
    expect(jwt.split(".")).toHaveLength(3);
  });

  test("header decodes to {alg:RS256,typ:JWT}", () => {
    const jwt = buildAppJwt({ appId, privateKeyPem, nowSec });
    const seg = jwt.split(".");
    const head = b64urlToJson(seg[0]!);
    expect(head).toEqual({ alg: "RS256", typ: "JWT" });
  });

  test("payload decodes to expected iss/iat/exp", () => {
    const jwt = buildAppJwt({ appId, privateKeyPem, nowSec });
    const seg = jwt.split(".");
    const payload = b64urlToJson(seg[1]!);
    expect(payload).toEqual({
      iat: nowSec - 60,
      exp: nowSec + 540,
      iss: appId,
    });
  });

  test("signature verifies against the public key", () => {
    const jwt = buildAppJwt({ appId, privateKeyPem, nowSec });
    const seg = jwt.split(".");
    const signingInput = `${seg[0]}.${seg[1]}`;
    const sig = Buffer.from(seg[2]!, "base64url");
    const v = createVerify("RSA-SHA256");
    v.update(signingInput);
    v.end();
    expect(v.verify(publicKeyPem, sig)).toBe(true);
  });

  test("normalizes literal backslash-n in the PEM to real newlines", () => {
    // Collapse the real PEM to one line with literal "\n" escape sequences.
    const escaped = privateKeyPem.replace(/\n/g, "\\n");
    expect(escaped).toContain("\\n");
    const jwt = buildAppJwt({ appId, privateKeyPem: escaped, nowSec });
    const seg = jwt.split(".");
    const signingInput = `${seg[0]}.${seg[1]}`;
    const sig = Buffer.from(seg[2]!, "base64url");
    const v = createVerify("RSA-SHA256");
    v.update(signingInput);
    v.end();
    expect(v.verify(publicKeyPem, sig)).toBe(true);
  });

  test("defaults nowSec to the current epoch seconds when omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = buildAppJwt({ appId, privateKeyPem });
    const after = Math.floor(Date.now() / 1000);
    const seg = jwt.split(".");
    const payload = b64urlToJson(seg[1]!);
    const iat = payload.iat as number;
    // iat = now-60, so reconstruct now and bound it.
    const reconstructedNow = iat + 60;
    expect(reconstructedNow).toBeGreaterThanOrEqual(before);
    expect(reconstructedNow).toBeLessThanOrEqual(after);
  });
});
