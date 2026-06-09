import { describe, expect, test } from "bun:test";

import { createS3CompatiblePresigner } from "./presign.ts";

const FIXED_NOW = Date.UTC(2026, 5, 8, 12, 34, 56);

describe("createS3CompatiblePresigner", () => {
	test("returns a browser-usable AWS SigV4 query URL for an S3-compatible object", () => {
		const presign = createS3CompatiblePresigner({
			endpoint: "https://storage.googleapis.com",
			region: "auto",
			accessKeyId: "TESTACCESSKEY",
			secretAccessKey: "test-secret-key",
			expiresSeconds: 900,
		});

		const result = presign({
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
		expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe(
			"AWS4-HMAC-SHA256",
		);
		expect(parsed.searchParams.get("X-Amz-Credential")).toBe(
			"TESTACCESSKEY/20260608/auto/s3/aws4_request",
		);
		expect(parsed.searchParams.get("X-Amz-Date")).toBe("20260608T123456Z");
		expect(parsed.searchParams.get("X-Amz-Expires")).toBe("60");
		expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
		expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
		expect(result?.url).not.toContain("test-secret-key");
		expect(result?.url).not.toContain("s3://");
	});

	test("caps URL TTL to the configured presign lifetime and S3 seven-day maximum", () => {
		const presign = createS3CompatiblePresigner({
			endpoint: "https://storage.googleapis.com",
			region: "auto",
			accessKeyId: "TESTACCESSKEY",
			secretAccessKey: "test-secret-key",
			expiresSeconds: 999_999,
		});

		const result = presign({
			bucket: "tensol-evidence",
			key: "reports/report.pdf",
			expiresAt: FIXED_NOW + 30 * 24 * 60 * 60 * 1000,
			nowMs: FIXED_NOW,
		});

		expect(result).not.toBeNull();
		expect(new URL(result?.url ?? "").searchParams.get("X-Amz-Expires")).toBe(
			"604800",
		);
		expect(result?.expiresAt).toBe(FIXED_NOW + 604_800_000);
	});

	test("returns null when storage config is incomplete or the artifact is expired", () => {
		const missingConfig = createS3CompatiblePresigner({
			endpoint: "",
			region: "auto",
			accessKeyId: "TESTACCESSKEY",
			secretAccessKey: "test-secret-key",
		});
		expect(
			missingConfig({
				bucket: "tensol-evidence",
				key: "reports/report.pdf",
				expiresAt: FIXED_NOW + 60_000,
				nowMs: FIXED_NOW,
			}),
		).toBeNull();

		const presign = createS3CompatiblePresigner({
			endpoint: "https://storage.googleapis.com",
			region: "auto",
			accessKeyId: "TESTACCESSKEY",
			secretAccessKey: "test-secret-key",
		});
		expect(
			presign({
				bucket: "tensol-evidence",
				key: "reports/report.pdf",
				expiresAt: FIXED_NOW - 1,
				nowMs: FIXED_NOW,
			}),
		).toBeNull();
	});
});
