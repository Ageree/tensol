import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type GcsLike,
	type UploadEvidenceOpts,
	createEvidenceUploader,
} from "../src/evidence-upload.ts";

let workDir: string;
let smallFile: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "tensol-evidence-test-"));
	smallFile = join(workDir, "evidence.tar.gz");
	writeFileSync(smallFile, Buffer.from("hello-evidence", "utf8"));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function makeFakeGcs(etag = "fake-etag") {
	const calls: Array<{
		bucket: string;
		key: string;
		filePath: string;
		contentType: string;
	}> = [];
	const gcs: GcsLike = {
		uploadObject: async (input) => {
			calls.push(input);
			return { etag };
		},
	};
	return { gcs, calls };
}

function buildOpts(
	overrides: Partial<UploadEvidenceOpts> = {},
): UploadEvidenceOpts {
	const fake = makeFakeGcs();
	return {
		bucket: "tensol-evidence-prod",
		gcs: fake.gcs,
		...overrides,
	};
}

describe("createEvidenceUploader", () => {
	test("uploads to GCS with expected bucket, key, file path, and content type", async () => {
		const fake = makeFakeGcs("etag-1");
		const uploader = createEvidenceUploader({
			bucket: "tensol-evidence-prod",
			gcs: fake.gcs,
		});

		const result = await uploader.uploadEvidence({
			scanId: "scan_01HXX",
			filePath: smallFile,
		});

		expect(fake.calls).toEqual([
			{
				bucket: "tensol-evidence-prod",
				key: "evidence/scan_01HXX/evidence.tar.gz",
				filePath: smallFile,
				contentType: "application/gzip",
			},
		]);
		expect(result).toEqual({
			bucket: "tensol-evidence-prod",
			key: "evidence/scan_01HXX/evidence.tar.gz",
			size: "hello-evidence".length,
			etag: "etag-1",
		});
	});

	test("custom prefix and content type are honoured", async () => {
		const fake = makeFakeGcs();
		const uploader = createEvidenceUploader({
			bucket: "b",
			keyPrefix: "reports/",
			gcs: fake.gcs,
		});

		const result = await uploader.uploadEvidence({
			scanId: "scan_abc",
			filePath: smallFile,
			contentType: "application/octet-stream",
		});

		expect(result.key).toBe("reports/scan_abc/evidence.tar.gz");
		expect(fake.calls[0]?.contentType).toBe("application/octet-stream");
	});

	test("filename comes from basename(filePath)", async () => {
		const renamed = join(workDir, "har-bundle.tgz");
		writeFileSync(renamed, "x");
		const fake = makeFakeGcs();
		const uploader = createEvidenceUploader({ bucket: "b", gcs: fake.gcs });

		const result = await uploader.uploadEvidence({
			scanId: "scan_xyz",
			filePath: renamed,
		});

		expect(result.key).toBe("evidence/scan_xyz/har-bundle.tgz");
	});

	test("empty bucket throws synchronously at factory call", () => {
		expect(() => createEvidenceUploader(buildOpts({ bucket: "" }))).toThrow(
			/bucket.*required/i,
		);
	});

	test("missing file throws when uploading", async () => {
		const fake = makeFakeGcs();
		const uploader = createEvidenceUploader({ bucket: "b", gcs: fake.gcs });
		await expect(
			uploader.uploadEvidence({
				scanId: "scan_abc",
				filePath: join(workDir, "does-not-exist.tar.gz"),
			}),
		).rejects.toThrow();
	});

	test("default client gets a metadata token and posts a GCS media upload", async () => {
		const urls: string[] = [];
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			const href = url.toString();
			urls.push(href);
			if (href.includes("metadata.google.internal")) {
				expect(init?.headers).toEqual({ "Metadata-Flavor": "Google" });
				return Response.json({ access_token: "metadata-token" });
			}
			expect(init?.method).toBe("POST");
			expect(init?.headers).toMatchObject({
				Authorization: "Bearer metadata-token",
				"Content-Type": "application/gzip",
			});
			expect(init?.body).toBeDefined();
			return Response.json({ etag: "gcs-etag" });
		}) as typeof fetch;
		const uploader = createEvidenceUploader({
			bucket: "bucket",
			fetcher,
		});

		const result = await uploader.uploadEvidence({
			scanId: "scan_default",
			filePath: smallFile,
		});

		expect(urls[0]).toContain("metadata.google.internal");
		expect(urls[1]).toContain(
			"https://storage.googleapis.com/upload/storage/v1/b/bucket/o",
		);
		expect(urls[1]).toContain("uploadType=media");
		expect(urls[1]).toContain("name=evidence%2Fscan_default%2Fevidence.tar.gz");
		expect(result.etag).toBe("gcs-etag");
	});
});
