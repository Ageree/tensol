import { describe, expect, test } from "bun:test";

import {
	isEvidenceStorageConfigured,
	resolveEvidenceStorageEnv,
} from "./evidence-env.ts";

describe("resolveEvidenceStorageEnv", () => {
	test("uses bucket and prefix only", () => {
		const env = resolveEvidenceStorageEnv({
			TENSOL_EVIDENCE_BUCKET: "bucket",
			TENSOL_EVIDENCE_PREFIX: "reports/",
		});

		expect(env).toEqual({
			bucket: "bucket",
			prefix: "reports/",
		});
	});

	test("defaults prefix to scans/", () => {
		const env = resolveEvidenceStorageEnv({
			TENSOL_EVIDENCE_BUCKET: "bucket",
		});

		expect(env).toEqual({
			bucket: "bucket",
			prefix: "scans/",
		});
	});
});

describe("isEvidenceStorageConfigured", () => {
	test("requires only the GCS bucket", () => {
		expect(
			isEvidenceStorageConfigured({
				bucket: "",
				prefix: "scans/",
			}),
		).toBe(false);

		expect(
			isEvidenceStorageConfigured({
				bucket: "bucket",
				prefix: "scans/",
			}),
		).toBe(true);
	});
});
