import { statSync } from "node:fs";
import { basename } from "node:path";

const DEFAULT_KEY_PREFIX = "evidence/";
const DEFAULT_CONTENT_TYPE = "application/gzip";
const METADATA_TOKEN_URL =
	"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export interface GcsLike {
	uploadObject(input: {
		bucket: string;
		key: string;
		filePath: string;
		contentType: string;
	}): Promise<{ etag?: string | undefined }>;
}

export interface UploadEvidenceOpts {
	readonly bucket: string;
	readonly keyPrefix?: string;
	readonly gcs?: GcsLike;
	readonly fetcher?: typeof fetch;
}

export interface UploadEvidenceArgs {
	readonly scanId: string;
	readonly filePath: string;
	readonly contentType?: string;
}

export interface UploadEvidenceResult {
	readonly bucket: string;
	readonly key: string;
	readonly size: number;
	readonly etag?: string | undefined;
}

export interface EvidenceUploader {
	uploadEvidence(args: UploadEvidenceArgs): Promise<UploadEvidenceResult>;
}

async function readBodySafe(res: Response): Promise<string> {
	try {
		return (await res.text()).slice(0, 500);
	} catch {
		return "<unreadable>";
	}
}

async function metadataAccessToken(fetcher: typeof fetch): Promise<string> {
	const res = await fetcher(METADATA_TOKEN_URL, {
		headers: { "Metadata-Flavor": "Google" },
	});
	if (!res.ok) {
		throw new Error(
			`gcs metadata token: HTTP ${res.status} ${res.statusText} :: ${await readBodySafe(res)}`,
		);
	}
	const body = (await res.json()) as { access_token?: unknown };
	if (typeof body.access_token !== "string" || body.access_token === "") {
		throw new Error("gcs metadata token: response lacked access_token");
	}
	return body.access_token;
}

function createDefaultGcsClient(fetcher: typeof fetch): GcsLike {
	return {
		async uploadObject(input) {
			const url = new URL(
				`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(input.bucket)}/o`,
			);
			url.searchParams.set("uploadType", "media");
			url.searchParams.set("name", input.key);
			const res = await fetcher(url.toString(), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${await metadataAccessToken(fetcher)}`,
					"Content-Type": input.contentType,
				},
				body: Bun.file(input.filePath),
			});
			if (!res.ok) {
				throw new Error(
					`gcs uploadObject: HTTP ${res.status} ${res.statusText} :: ${await readBodySafe(res)}`,
				);
			}
			const body = (await res.json().catch(() => ({}))) as { etag?: unknown };
			return typeof body.etag === "string" ? { etag: body.etag } : {};
		},
	};
}

export function createEvidenceUploader(
	opts: UploadEvidenceOpts,
): EvidenceUploader {
	if (!opts.bucket || opts.bucket.trim() === "") {
		throw new Error("evidence-upload: bucket is required");
	}

	const bucket = opts.bucket;
	const keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
	const gcs = opts.gcs ?? createDefaultGcsClient(opts.fetcher ?? fetch);

	return {
		async uploadEvidence(args) {
			const filename = basename(args.filePath);
			const key = `${keyPrefix}${args.scanId}/${filename}`;
			const contentType = args.contentType ?? DEFAULT_CONTENT_TYPE;
			const size = statSync(args.filePath).size;
			const result = await gcs.uploadObject({
				bucket,
				key,
				filePath: args.filePath,
				contentType,
			});
			return { bucket, key, size, etag: result.etag };
		},
	};
}
