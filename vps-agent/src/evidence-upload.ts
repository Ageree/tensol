import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
/**
 * T133 — evidence upload to explicit S3/GCS-compatible object storage for
 * vps-agent.
 *
 * After Decepticon finishes a scan inside the ephemeral VM, vps-agent
 * compresses HAR/screenshot/log artifacts into `evidence.tar.gz` and uploads
 * the bundle so the backend can reference it from the final report. GCP
 * The configured object-storage provider speaks the S3 wire protocol, so we
 * drive it with the AWS SDK v3 (per research §R9). The credentials and bucket
 * are scoped per-scan by cloud-init, baked into the VM env at spawn time.
 *
 * Constitution II (NON-NEGOTIABLE): this module is the ONLY upload path for
 * scan evidence. Any future encryption / SSE / lifecycle policy lives here.
 *
 * Why DI for both the client and the `Upload` constructor:
 *   - `s3` injection keeps tests hermetic — we never make a real HTTPS
 *     call or sign a real request when running `bun test`.
 *   - `uploadCtor` injection lets us assert which code path (single-shot
 *     PutObject vs. multipart Upload) was taken — the threshold matters
 *     for cost (multipart has per-part overhead) and for correctness
 *     (GCP enforces a minimum part size).
 *
 * Multipart threshold = 5 MiB:
 *   - S3 multipart spec requires every non-final part to be >= 5 MiB.
 *   - Anything smaller is better served by a single PutObject — fewer round
 *     trips, no part-coordination cost.
 *   - Boundary is `>=` so a file exactly at 5 MiB goes through Upload, which
 *     handles the "single-part multipart" case correctly.
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

/** 5 MiB — below this we use single-shot PutObject. */
const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** Multipart chunk size — matches the S3 minimum so we never over-split. */
const MULTIPART_PART_BYTES = 5 * 1024 * 1024;

/** Default S3 key prefix when the caller does not override. */
const DEFAULT_KEY_PREFIX = "evidence/";

/** Default content type — Decepticon evidence bundles are gzipped tarballs. */
const DEFAULT_CONTENT_TYPE = "application/gzip";

/**
 * Minimal shape we rely on from the S3 client. Matches `S3Client.send` but
 * stays loose so tests can inject a hand-rolled fake without dragging in the
 * full SDK class hierarchy.
 */
export interface S3Like {
	send: (cmd: unknown) => Promise<unknown>;
}

/**
 * Minimal shape we rely on from the `Upload` class. Mirrors the public
 * surface of `@aws-sdk/lib-storage`'s `Upload`. We only need construction
 * with `{client, params, ...}` and an awaitable `.done()`.
 */
export interface UploadLike {
	done(): Promise<unknown>;
}

/**
 * Constructor signature for an `Upload`-like class. Typed loosely so tests
 * can inject their own class — the real SDK type has many optional fields
 * we don't exercise.
 */
export interface UploadCtorArgs {
	readonly client: S3Like;
	readonly params: Record<string, unknown>;
	readonly queueSize?: number;
	readonly partSize?: number;
}

export type UploadCtor = new (args: UploadCtorArgs) => UploadLike;

export interface UploadEvidenceOpts {
	/** Target bucket in S3/GCS-compatible object storage. Required. */
	readonly bucket: string;
	/** Key prefix joined verbatim with `<scanId>/<filename>`. Default
	 *  `"evidence/"`. Pass with a trailing slash if you want a slash. */
	readonly keyPrefix?: string;
	/** Injected S3 client. Defaults to a real `S3Client` reading env. */
	readonly s3?: S3Like;
	/** Env override for default S3 client construction. Tests use this to keep
	 *  env-contract checks hermetic; production leaves it unset. */
	readonly env?: NodeJS.ProcessEnv;
	/** Injected multipart Upload constructor. Defaults to the real
	 *  `Upload` from `@aws-sdk/lib-storage`. */
	readonly uploadCtor?: UploadCtor;
}

export interface UploadEvidenceArgs {
	/** Logical scan identifier — becomes the second segment of the key. */
	readonly scanId: string;
	/** Local filesystem path to the evidence bundle (typically tar.gz). */
	readonly filePath: string;
	/** Optional content type override. Default `"application/gzip"`. */
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

/**
 * Object-storage env resolved from cloud-init exports. The endpoint and keys
 * must be explicit; only the SigV4 region falls back to `auto`, which is the
 * documented GCS-compatible value in the repo examples.
 */
export interface EvidenceUploadEnv {
	readonly region: string;
	readonly endpoint: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}

function firstNonEmpty(env: NodeJS.ProcessEnv, ...names: string[]): string {
	for (const name of names) {
		const value = env[name];
		if (value !== undefined && value !== "") return value;
	}
	return "";
}

export function resolveEvidenceUploadEnv(
	env: NodeJS.ProcessEnv = process.env,
): EvidenceUploadEnv {
	return {
		region:
			firstNonEmpty(env, "AWS_REGION", "TENSOL_EVIDENCE_S3_REGION") || "auto",
		endpoint: firstNonEmpty(
			env,
			"AWS_ENDPOINT",
			"AWS_ENDPOINT_URL",
			"TENSOL_EVIDENCE_S3_ENDPOINT",
		),
		accessKeyId: firstNonEmpty(
			env,
			"AWS_ACCESS_KEY_ID",
			"TENSOL_EVIDENCE_S3_ACCESS_KEY_ID",
		),
		secretAccessKey: firstNonEmpty(
			env,
			"AWS_SECRET_ACCESS_KEY",
			"TENSOL_EVIDENCE_S3_SECRET_KEY",
		),
	};
}

function requireDefaultS3Env(env: EvidenceUploadEnv): void {
	const missing: string[] = [];
	if (env.endpoint.trim() === "") {
		missing.push("AWS_ENDPOINT or AWS_ENDPOINT_URL");
	}
	if (env.accessKeyId.trim() === "") {
		missing.push("AWS_ACCESS_KEY_ID");
	}
	if (env.secretAccessKey.trim() === "") {
		missing.push("AWS_SECRET_ACCESS_KEY");
	}
	if (missing.length > 0) {
		throw new Error(
			`evidence-upload: explicit object-storage env required (${missing.join(", ")})`,
		);
	}
}

function buildDefaultS3Client(env = process.env): S3Client {
	const storageEnv = resolveEvidenceUploadEnv(env);
	requireDefaultS3Env(storageEnv);
	return new S3Client({
		region: storageEnv.region,
		endpoint: storageEnv.endpoint,
		credentials: {
			accessKeyId: storageEnv.accessKeyId,
			secretAccessKey: storageEnv.secretAccessKey,
		},
	});
}

/**
 * Construct an evidence uploader bound to a specific bucket + prefix.
 *
 * Pure factory — no I/O, no env reads except inside the default S3 client
 * builder. Throws synchronously on invalid configuration (empty bucket)
 * so the per-scan VM fails fast at boot rather than after Decepticon has
 * already done expensive work.
 */
export function createEvidenceUploader(
	opts: UploadEvidenceOpts,
): EvidenceUploader {
	if (!opts.bucket || opts.bucket.trim() === "") {
		throw new Error("evidence-upload: bucket is required");
	}

	const s3: S3Like =
		opts.s3 ?? (buildDefaultS3Client(opts.env) as unknown as S3Like);
	const UploadClass: UploadCtor =
		opts.uploadCtor ?? (Upload as unknown as UploadCtor);
	const keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
	const bucket = opts.bucket;

	return {
		async uploadEvidence(
			args: UploadEvidenceArgs,
		): Promise<UploadEvidenceResult> {
			const filename = basename(args.filePath);
			const key = `${keyPrefix}${args.scanId}/${filename}`;
			const contentType = args.contentType ?? DEFAULT_CONTENT_TYPE;

			// statSync throws on missing/unreadable files — that's the desired
			// behaviour: surface filesystem errors before opening a stream.
			const stat = statSync(args.filePath);
			const size = stat.size;

			if (size >= MULTIPART_THRESHOLD_BYTES) {
				// Multipart path — required for files >=5 MiB and friendlier to the
				// network on flaky links (retries one part instead of the whole
				// bundle). Each call gets a fresh stream so retries inside the
				// SDK can re-read from the start.
				const body = createReadStream(args.filePath);
				const upload = new UploadClass({
					client: s3,
					params: {
						Bucket: bucket,
						Key: key,
						Body: body,
						ContentType: contentType,
					},
					queueSize: 4,
					partSize: MULTIPART_PART_BYTES,
				});
				const result = (await upload.done()) as { ETag?: string } | undefined;
				return {
					bucket,
					key,
					size,
					etag: result?.ETag,
				};
			}

			// Single-shot PutObject — cheaper and one fewer signed request.
			const body = createReadStream(args.filePath);
			const cmd = new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				Body: body,
				ContentType: contentType,
			});
			const result = (await s3.send(cmd)) as { ETag?: string } | undefined;
			return {
				bucket,
				key,
				size,
				etag: result?.ETag,
			};
		},
	};
}
