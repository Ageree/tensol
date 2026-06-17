import { describe, expect, test } from "bun:test";

import { createGcsSignedUrlPresigner } from "./presign.ts";

const FIXED_NOW = Date.UTC(2026, 5, 8, 12, 34, 56);

describe("createGcsSignedUrlPresigner", () => {
	test("returns a browser-usable GCS V4 signed URL", async () => {
		const presign = createGcsSignedUrlPresigner({
			clientEmail: "storage-signer@example.iam.gserviceaccount.com",
			sign: async () => Buffer.from("fake-signature").toString("base64"),
			expiresSeconds: 900,
		});

		const result = await presign({
			bucket: "tensol-evidence",
			key: "reports/hello report.pdf",
			expiresAt: FIXED_NOW + 60_000,
			nowMs: FIXED_NOW,
		});

		expect(result).not.toBeNull();
		expect(result?.expiresAt).toBe(FIXED_NOW + 60_000);
		const parsed = new URL(result?.url ?? "");
		expect(parsed.origin).toBe("https://storage.googleapis.com");
		expect(parsed.pathname).toBe("/tensol-evidence/reports/hello%20report.pdf");
		expect(parsed.searchParams.get("X-Goog-Algorithm")).toBe(
			"GOOG4-RSA-SHA256",
		);
		expect(parsed.searchParams.get("X-Goog-Credential")).toBe(
			"storage-signer@example.iam.gserviceaccount.com/20260608/auto/storage/goog4_request",
		);
		expect(parsed.searchParams.get("X-Goog-Date")).toBe("20260608T123456Z");
		expect(parsed.searchParams.get("X-Goog-Expires")).toBe("60");
		expect(parsed.searchParams.get("X-Goog-SignedHeaders")).toBe("host");
		expect(parsed.searchParams.get("X-Goog-Signature")).toBe(
			Buffer.from("fake-signature").toString("hex"),
		);
		expect(result?.url).not.toContain("s3://");
	});

	test("caps URL TTL to configured lifetime and GCS seven-day maximum", async () => {
		const presign = createGcsSignedUrlPresigner({
			clientEmail: "storage-signer@example.iam.gserviceaccount.com",
			sign: async () => Buffer.from("sig").toString("base64"),
			expiresSeconds: 999_999,
		});

		const result = await presign({
			bucket: "tensol-evidence",
			key: "reports/report.pdf",
			expiresAt: FIXED_NOW + 30 * 24 * 60 * 60 * 1000,
			nowMs: FIXED_NOW,
		});

		expect(result).not.toBeNull();
		expect(new URL(result?.url ?? "").searchParams.get("X-Goog-Expires")).toBe(
			"604800",
		);
		expect(result?.expiresAt).toBe(FIXED_NOW + 604_800_000);
	});

	test("returns null when input is incomplete or the artifact is expired", async () => {
		const presign = createGcsSignedUrlPresigner({
			clientEmail: "storage-signer@example.iam.gserviceaccount.com",
			sign: async () => Buffer.from("sig").toString("base64"),
		});

		expect(
			await presign({
				bucket: "",
				key: "reports/report.pdf",
				expiresAt: FIXED_NOW + 60_000,
				nowMs: FIXED_NOW,
			}),
		).toBeNull();
		expect(
			await presign({
				bucket: "tensol-evidence",
				key: "reports/report.pdf",
				expiresAt: FIXED_NOW - 1,
				nowMs: FIXED_NOW,
			}),
		).toBeNull();
	});
});
