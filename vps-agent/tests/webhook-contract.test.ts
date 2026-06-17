/**
 * T137 — cross-package contract test: vps-agent webhook signer ↔ server verifier.
 *
 * Pairs with T070 (`server/src/routes/webhooks-scan-complete.ts`). The two
 * sides MUST agree byte-for-byte on:
 *
 *     X-Tensol-Signature: t=<unix-seconds>, v1=<64 lowercase hex hmac_sha256>
 *
 * with the HMAC body literally `${t}.${rawBody}`. T132 already cross-verifies
 * the agent signer against `node:crypto` locally; this file goes one step
 * further and reimplements the *server's* verifier shape (parse `t=N,
 * v1=<64 hex>`, recompute HMAC, timing-safe compare) — so any drift on EITHER
 * side surfaces here as a failing assertion before it can reach production.
 *
 * Why reimplement vs. import the server verifier:
 *   - `server/` and `vps-agent/` are sibling Bun packages with no path alias
 *     wiring between them. Adding one for a single test would couple build
 *     systems and break the standalone-bundle property of vps-agent (it ships
 *     to a remote VM cloud-init zip — see `vps-agent/README.md`).
 *   - The server's verifier is ~15 LOC of well-defined logic (header regex +
 *     HMAC recompute + timingSafeEqual). Reimplementing it locally with
 *     `node:crypto` gives us a clean, dependency-free contract probe.
 *
 * Constitution II (NON-NEGOTIABLE): if any test in this file fails, DO NOT
 * "fix" the test — investigate the envelope drift first. Both signer and
 * verifier are byte-frozen by the V2 contract in `contracts/webhook.md`.
 */
import { describe, expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";

import { signWebhook } from "../src/webhook-sign.ts";

// Synthetic test secrets — never reused from production env. Static string
// literals so the golden vector below is reproducible from any machine.
const SECRET = "contract-test-secret";
const GOLDEN_SECRET = "webhook-test-secret"; // pairs with T132 golden vector
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

/**
 * Mirror of the server's verifier in
 * `server/src/routes/webhooks-scan-complete.ts` — minus the audit-log
 * emission and the Hono response wrappers. Pure boolean: does this
 * `(secret, signatureHeader, body)` triple verify?
 *
 * Tolerates the same envelope variants the server accepts:
 *   - any whitespace around the `,` separator
 *   - any ordering of the `t=` / `v1=` pairs
 *   - lower or upper case hex (normalised to lowercase before compare)
 */
function verifyWebhookServerSide(
	secret: string,
	signatureHeader: string | undefined,
	body: string,
): boolean {
	if (!signatureHeader) return false;
	const parts = signatureHeader.split(",").map((p) => p.trim());
	if (parts.length !== 2) return false;

	let ts: string | null = null;
	let providedHex: string | null = null;
	for (const part of parts) {
		const eqIdx = part.indexOf("=");
		if (eqIdx <= 0) return false;
		const key = part.slice(0, eqIdx).trim();
		const value = part.slice(eqIdx + 1).trim();
		if (key === "t") {
			if (!/^\d+$/.test(value)) return false;
			const n = Number.parseInt(value, 10);
			if (!Number.isFinite(n) || n <= 0) return false;
			ts = value;
		} else if (key === "v1") {
			if (value.length !== 64 || !/^[0-9a-fA-F]+$/.test(value)) return false;
			providedHex = value.toLowerCase();
		} else {
			return false;
		}
	}
	if (ts === null || providedHex === null) return false;

	const expectedHex = createHmac("sha256", secret)
		.update(`${ts}.${body}`)
		.digest("hex");

	const a = Buffer.from(providedHex, "hex");
	const b = Buffer.from(expectedHex, "hex");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

describe("webhook contract: vps-agent signer ↔ server verifier", () => {
	test("agent-signed payload verifies under server-style logic", () => {
		const body =
			'{"scan_order_id":"01ABCDEFGHJKMNPQRSTVWXYZ00","completed_at":1716000000000}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		expect(verifyWebhookServerSide(SECRET, r.signature, body)).toBe(true);
	});

	test("default-timestamp signed payload verifies (clock drift = 0)", () => {
		// No explicit timestamp → signer uses Date.now()/1000. Verifier extracts
		// it from the header, so this still round-trips deterministically.
		const body = '{"a":1,"b":2}';
		const r = signWebhook({ secret: SECRET, body });
		expect(verifyWebhookServerSide(SECRET, r.signature, body)).toBe(true);
	});

	test("tampered body rejected", () => {
		const body = '{"scan_order_id":"01ABCDEFGHJKMNPQRSTVWXYZ00"}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		// Verifier sees the original sig but a body with one trailing space.
		expect(verifyWebhookServerSide(SECRET, r.signature, `${body} `)).toBe(
			false,
		);
	});

	test("tampered timestamp in header rejected", () => {
		const body = '{"a":1}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		// Flip exactly one digit in the t= field. HMAC re-computation uses the
		// new ts but the v1= hex is still bound to the old one → mismatch.
		const tampered = r.signature.replace(
			`t=${GOLDEN_TS}`,
			`t=${GOLDEN_TS + 1}`,
		);
		expect(verifyWebhookServerSide(SECRET, tampered, body)).toBe(false);
	});

	test("wrong secret rejected", () => {
		const body = '{"a":1}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		expect(
			verifyWebhookServerSide("a-different-secret", r.signature, body),
		).toBe(false);
	});

	test("malformed signature header rejected (no v1)", () => {
		const body = '{"a":1}';
		expect(verifyWebhookServerSide(SECRET, `t=${GOLDEN_TS}`, body)).toBe(false);
	});

	test("malformed signature header rejected (non-hex v1)", () => {
		const body = '{"a":1}';
		expect(
			verifyWebhookServerSide(SECRET, `t=${GOLDEN_TS}, v1=NOTHEX`, body),
		).toBe(false);
	});

	test("malformed signature header rejected (short v1 digest)", () => {
		const body = '{"a":1}';
		expect(
			verifyWebhookServerSide(SECRET, `t=${GOLDEN_TS}, v1=abc123`, body),
		).toBe(false);
	});

	test("missing signature header rejected", () => {
		expect(verifyWebhookServerSide(SECRET, undefined, "{}")).toBe(false);
	});
});

describe("webhook contract: golden vector (T132) cross-check", () => {
	test("signer + server verifier agree on T132 pinned hex", () => {
		const r = signWebhook({
			secret: GOLDEN_SECRET,
			body: GOLDEN_BODY,
			timestamp: GOLDEN_TS,
		});
		expect(r.signature).toBe(`t=${GOLDEN_TS}, v1=${GOLDEN_HEX}`);
		expect(
			verifyWebhookServerSide(GOLDEN_SECRET, r.signature, GOLDEN_BODY),
		).toBe(true);
	});

	test("server-style verifier alone (no signer) accepts the golden header", () => {
		// Construct the header by hand to confirm the verifier doesn't
		// accidentally depend on the signer's exact string layout.
		const header = `t=${GOLDEN_TS}, v1=${GOLDEN_HEX}`;
		expect(verifyWebhookServerSide(GOLDEN_SECRET, header, GOLDEN_BODY)).toBe(
			true,
		);
	});
});

describe("webhook contract: Juice-Shop-shape payload (realistic body)", () => {
	test("multi-finding completion body round-trips", () => {
		const body = JSON.stringify({
			scan_order_id: "01JJCSHPTESTSCANRDER000001",
			completed_at: 1716114000000,
			duration_seconds: 2280,
			decepticon_events_count: 759,
			evidence_archive_url:
				"gs://tensol-evidence/01JJCSHPTESTSCANRDER000001.tar.gz",
			findings: [
				{
					slug: "sqli-login-admin-bypass",
					raw_yaml_frontmatter: {
						id: "f1",
						severity: "critical",
						title: "SQL injection in /rest/user/login enables admin bypass",
						cwe: "CWE-89",
					},
					body_md: "## PoC\n`' OR 1=1--`\n",
					evidence_keys: ["req-001.http", "resp-001.http"],
				},
				{
					slug: "stored-xss-feedback",
					raw_yaml_frontmatter: {
						id: "f2",
						severity: "high",
						title: "Stored XSS in feedback form",
					},
					body_md: "Body…",
					evidence_keys: [],
				},
			],
		});
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		expect(verifyWebhookServerSide(SECRET, r.signature, body)).toBe(true);
	});
});

describe("webhook contract: server-side header parser tolerance", () => {
	// The signer emits `t=N, v1=<64 hex>` (one space after comma). The server's
	// parser also accepts the no-space and any-whitespace variants — these
	// tests pin that property end-to-end so a future signer refactor that
	// drops the space stays compatible.
	test("space variant `, v1=` accepted (signer default)", () => {
		const body = '{"a":1}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		expect(r.signature).toContain(", v1=");
		expect(verifyWebhookServerSide(SECRET, r.signature, body)).toBe(true);
	});

	test("no-space variant `,v1=` accepted (forward-compat)", () => {
		const body = '{"a":1}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		const collapsed = r.signature.replace(", v1=", ",v1=");
		expect(verifyWebhookServerSide(SECRET, collapsed, body)).toBe(true);
	});

	test("reversed-order `v1=<64 hex>, t=N` accepted (server tolerance)", () => {
		const body = '{"a":1}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		const match = r.signature.match(/^t=(\d+), v1=([0-9a-f]{64})$/);
		if (!match) {
			throw new Error(
				`Signature did not match server contract: ${r.signature}`,
			);
		}
		const reversed = `v1=${must(match[2], "v1 digest")}, t=${must(match[1], "timestamp")}`;
		expect(verifyWebhookServerSide(SECRET, reversed, body)).toBe(true);
	});

	test("uppercase hex digest accepted (server normalises to lowercase)", () => {
		const body = '{"a":1}';
		const r = signWebhook({ secret: SECRET, body, timestamp: GOLDEN_TS });
		const upper = r.signature.replace(
			/v1=([0-9a-f]{64})/,
			(_, hex: string) => `v1=${hex.toUpperCase()}`,
		);
		expect(verifyWebhookServerSide(SECRET, upper, body)).toBe(true);
	});
});
