import { describe, expect, test } from "bun:test";

import {
	isEvidenceStorageConfigured,
	resolveEvidenceStorageEnv,
} from "./evidence-env.ts";

describe("resolveEvidenceStorageEnv", () => {
	test("uses AWS-compatible names when present", () => {
		const env = resolveEvidenceStorageEnv({
			TENSOL_EVIDENCE_BUCKET: "bucket",
			AWS_REGION: "aws-region",
			AWS_ENDPOINT_URL: "https://aws.example",
			AWS_ACCESS_KEY_ID: "aws-key",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			TENSOL_EVIDENCE_PREFIX: "reports/",
		});

		expect(env).toEqual({
			bucket: "bucket",
			region: "aws-region",
			endpoint: "https://aws.example",
			accessKeyId: "aws-key",
			secretAccessKey: "aws-secret",
			prefix: "reports/",
		});
	});

	test("uses explicit legacy S3-compatible aliases when present", () => {
		const env = resolveEvidenceStorageEnv({
			TENSOL_EVIDENCE_BUCKET: "bucket",
			TENSOL_EVIDENCE_S3_REGION: "auto",
			TENSOL_EVIDENCE_S3_ENDPOINT: "https://storage.googleapis.com",
			TENSOL_EVIDENCE_S3_ACCESS_KEY_ID: "gcs-key",
			TENSOL_EVIDENCE_S3_SECRET_KEY: "gcs-secret",
		});

		expect(env).toMatchObject({
			bucket: "bucket",
			region: "auto",
			endpoint: "https://storage.googleapis.com",
			accessKeyId: "gcs-key",
			secretAccessKey: "gcs-secret",
			prefix: "scans/",
		});
	});

	test("does not silently default to Google Cloud Storage", () => {
		const env = resolveEvidenceStorageEnv({
			TENSOL_EVIDENCE_BUCKET: "bucket",
			AWS_ACCESS_KEY_ID: "gcs-key",
			AWS_SECRET_ACCESS_KEY: "gcs-secret",
		});

		expect(env.region).toBe("auto");
		expect(env.endpoint).toBe("");
	});

	test("ignores empty AWS aliases and still uses explicit legacy aliases", () => {
		const env = resolveEvidenceStorageEnv({
			TENSOL_EVIDENCE_BUCKET: "bucket",
			AWS_ACCESS_KEY_ID: "",
			AWS_SECRET_ACCESS_KEY: "",
			TENSOL_EVIDENCE_S3_ACCESS_KEY_ID: "gcs-key",
			TENSOL_EVIDENCE_S3_SECRET_KEY: "gcs-secret",
		});

		expect(env.accessKeyId).toBe("gcs-key");
		expect(env.secretAccessKey).toBe("gcs-secret");
	});
});

describe("isEvidenceStorageConfigured", () => {
	test("requires bucket, endpoint, access key, and secret key", () => {
		expect(
			isEvidenceStorageConfigured({
				bucket: "bucket",
				region: "auto",
				endpoint: "",
				accessKeyId: "key",
				secretAccessKey: "secret",
				prefix: "scans/",
			}),
		).toBe(false);
	});

	test("accepts a fully explicit S3/GCS-compatible storage config", () => {
		expect(
			isEvidenceStorageConfigured({
				bucket: "bucket",
				region: "auto",
				endpoint: "https://storage.googleapis.com",
				accessKeyId: "key",
				secretAccessKey: "secret",
				prefix: "scans/",
			}),
		).toBe(true);
	});
});
