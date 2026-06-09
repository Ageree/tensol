/**
 * T132 — golden-vector + cross-verification tests for webhook-sign.ts (T131).
 *
 * Pins the exact signature envelope shape required by the server-side verifier
 * at `server/src/routes/webhooks-scan-complete.ts` (T069):
 *
 *     X-Tensol-Signature: t=<unix-seconds>, v1=<64 lowercase hex hmac_sha256>
 *
 * The HMAC body is literally `${t}.${rawBody}`. Any drift in either the
 * envelope format or the signed-string composition will break the server
 * round-trip, so every test here is a contract test.
 */
import { describe, expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";

import { buildSignedHeaders, signWebhook } from "../src/webhook-sign.ts";

const SECRET = "webhook-test-secret";

/**
 * Golden vector — pinned via:
 *
 *   bun -e 'console.log(require("node:crypto")
 *     .createHmac("sha256","webhook-test-secret")
 *     .update("1716000000.{\"hello\":\"world\"}")
 *     .digest("hex"))'
 *
 * If this hex ever changes, EITHER the contract format drifted OR somebody
 * "fixed" the signing module — investigate before re-pinning.
 */
const GOLDEN_TS = 1716000000;
const GOLDEN_BODY = '{"hello":"world"}';
const GOLDEN_HEX =
	"794bc65855733968a9faef7ced3111c72e563bc19c9d36d211b993b609efc28e";

function must(value: string | undefined, label: string): string {
	if (value === undefined) {
		throw new Error(`Expected ${label}`);
	}
	return value;
}

function parseSignatureEnvelope(signature: string): { ts: string; v1: string } {
	const match = signature.match(/^t=(\d+), v1=([0-9a-f]{64})$/);
	if (!match) {
		throw new Error(`Signature did not match server contract: ${signature}`);
	}
	return {
		ts: must(match[1], "timestamp"),
		v1: must(match[2], "v1 digest"),
	};
}

function v1FromSignature(signature: string): string {
	return must(signature.split("v1=")[1], "v1 digest");
}

describe("signWebhook — golden vector", () => {
	test('ts=1716000000, body=\'{"hello":"world"}\' → pinned hex', () => {
		const r = signWebhook({
			secret: SECRET,
			body: GOLDEN_BODY,
			timestamp: GOLDEN_TS,
		});
		expect(r.timestamp).toBe(GOLDEN_TS);
		expect(r.signature).toBe(`t=${GOLDEN_TS}, v1=${GOLDEN_HEX}`);
	});

	test("envelope format matches server regex /^t=(\\d+), v1=([0-9a-f]{64})$/", () => {
		const r = signWebhook({
			secret: SECRET,
			body: GOLDEN_BODY,
			timestamp: GOLDEN_TS,
		});
		const envelope = parseSignatureEnvelope(r.signature);
		expect(envelope.ts).toBe(String(GOLDEN_TS));
		expect(envelope.v1).toBe(GOLDEN_HEX);
	});

	test("hex is lowercase only", () => {
		const r = signWebhook({
			secret: SECRET,
			body: GOLDEN_BODY,
			timestamp: GOLDEN_TS,
		});
		const hexPart = v1FromSignature(r.signature);
		expect(hexPart).toBe(hexPart.toLowerCase());
		expect(/^[0-9a-f]{64}$/.test(hexPart)).toBe(true);
	});
});

describe("signWebhook — defaults", () => {
	test("omits timestamp → falls back to ~Date.now()/1000", () => {
		const before = Math.floor(Date.now() / 1000);
		const r = signWebhook({ secret: SECRET, body: GOLDEN_BODY });
		const after = Math.floor(Date.now() / 1000);
		expect(r.timestamp).toBeGreaterThanOrEqual(before);
		expect(r.timestamp).toBeLessThanOrEqual(after);
	});
});

describe("buildSignedHeaders", () => {
	test("returns X-Tensol-Signature + Content-Type", () => {
		const headers = buildSignedHeaders({
			secret: SECRET,
			body: GOLDEN_BODY,
			timestamp: GOLDEN_TS,
		});
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers["X-Tensol-Signature"]).toBe(
			`t=${GOLDEN_TS}, v1=${GOLDEN_HEX}`,
		);
	});
});

describe("server-side verifier round-trip (cross-verify locally)", () => {
	test("signWebhook output passes node:crypto HMAC + timingSafeEqual", () => {
		const body =
			'{"scan_order_id":"01HXX000000000000000000000","completed_at":1716000000000,"findings":[]}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });

		const { ts, v1 } = parseSignatureEnvelope(r.signature);

		const expected = createHmac("sha256", SECRET)
			.update(`${ts}.${body}`)
			.digest("hex");

		expect(v1).toBe(expected);
		expect(
			timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(expected, "hex")),
		).toBe(true);
	});

	test("tampering with body invalidates signature", () => {
		const original = '{"scan_order_id":"01HXX","findings":[]}';
		const tampered = '{"scan_order_id":"01HXY","findings":[]}';
		const r = signWebhook({
			secret: SECRET,
			body: original,
			timestamp: GOLDEN_TS,
		});

		const v1 = v1FromSignature(r.signature);
		const recomputedOnTampered = createHmac("sha256", SECRET)
			.update(`${GOLDEN_TS}.${tampered}`)
			.digest("hex");

		expect(v1).not.toBe(recomputedOnTampered);
	});

	test("tampering with timestamp invalidates signature", () => {
		const body = '{"a":1}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		const v1 = v1FromSignature(r.signature);

		const recomputedOnDifferentTs = createHmac("sha256", SECRET)
			.update(`${GOLDEN_TS + 1}.${body}`)
			.digest("hex");

		expect(v1).not.toBe(recomputedOnDifferentTs);
	});
});

describe("edge cases", () => {
	test("empty body still produces a valid sig", () => {
		const r = signWebhook({ secret: SECRET, body: "", timestamp: GOLDEN_TS });
		const v1 = v1FromSignature(r.signature);
		const expected = createHmac("sha256", SECRET)
			.update(`${GOLDEN_TS}.`)
			.digest("hex");
		expect(v1).toBe(expected);
	});

	test("UTF-8 multibyte body — signs the UTF-8 byte sequence, not code points", () => {
		// Mix of Cyrillic + emoji + CJK — exercises multi-byte encoding.
		const body = '{"msg":"привет 🐎 世界"}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		const v1 = v1FromSignature(r.signature);
		const expected = createHmac("sha256", SECRET)
			.update(`${GOLDEN_TS}.${body}`, "utf8")
			.digest("hex");
		expect(v1).toBe(expected);
	});

	test("Buffer body equivalent to string body of same bytes", () => {
		const str = '{"hello":"world"}';
		const buf = Buffer.from(str, "utf8");
		const fromStr = signWebhook({
			secret: SECRET,
			body: str,
			timestamp: GOLDEN_TS,
		});
		const fromBuf = signWebhook({
			secret: SECRET,
			body: buf,
			timestamp: GOLDEN_TS,
		});
		expect(fromBuf.signature).toBe(fromStr.signature);
	});

	test("different bodies → different signatures", () => {
		const a = signWebhook({
			secret: SECRET,
			body: '{"a":1}',
			timestamp: GOLDEN_TS,
		});
		const b = signWebhook({
			secret: SECRET,
			body: '{"a":2}',
			timestamp: GOLDEN_TS,
		});
		expect(a.signature).not.toBe(b.signature);
	});

	test("different secrets → different signatures", () => {
		const a = signWebhook({
			secret: "secret-A",
			body: GOLDEN_BODY,
			timestamp: GOLDEN_TS,
		});
		const b = signWebhook({
			secret: "secret-B",
			body: GOLDEN_BODY,
			timestamp: GOLDEN_TS,
		});
		expect(a.signature).not.toBe(b.signature);
	});

	test("large body (256 KiB) still signs correctly", () => {
		const body = "x".repeat(256 * 1024);
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		const v1 = v1FromSignature(r.signature);
		const expected = createHmac("sha256", SECRET)
			.update(`${GOLDEN_TS}.${body}`)
			.digest("hex");
		expect(v1).toBe(expected);
	});
});
