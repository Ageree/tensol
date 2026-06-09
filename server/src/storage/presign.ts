import { createHash, createHmac } from "node:crypto";

const AWS4_ALGORITHM = "AWS4-HMAC-SHA256";
const AWS4_REQUEST = "aws4_request";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const MAX_S3_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_PRESIGN_SECONDS = 15 * 60;

export interface S3CompatiblePresignerConfig {
	readonly endpoint: string;
	readonly region: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly expiresSeconds?: number;
}

export interface S3CompatiblePresignInput {
	readonly bucket: string;
	readonly key: string;
	readonly expiresAt: number | null;
	readonly nowMs: number;
}

export interface PresignedDownloadUrl {
	readonly url: string;
	readonly expiresAt: number;
}

export type S3CompatiblePresigner = (
	input: S3CompatiblePresignInput,
) => PresignedDownloadUrl | null;

function hmac(key: string | Buffer, data: string): Buffer {
	return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

function hex(bytes: Buffer): string {
	return bytes.toString("hex");
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function awsDateParts(ms: number): { date: string; dateTime: string } {
	const d = new Date(ms);
	const date = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
	const dateTime = `${date}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
	return { date, dateTime };
}

function awsUriEncode(value: string, encodeSlash: boolean): string {
	const bytes = Buffer.from(value, "utf8");
	let out = "";
	for (const byte of bytes) {
		const ch = String.fromCharCode(byte);
		const unreserved =
			(byte >= 0x41 && byte <= 0x5a) ||
			(byte >= 0x61 && byte <= 0x7a) ||
			(byte >= 0x30 && byte <= 0x39) ||
			ch === "-" ||
			ch === "." ||
			ch === "_" ||
			ch === "~";
		if (unreserved || (!encodeSlash && ch === "/")) {
			out += ch;
		} else {
			out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return out;
}

function canonicalQuery(params: ReadonlyArray<readonly [string, string]>): string {
	return [...params]
		.map(([key, value]) => [
			awsUriEncode(key, true),
			awsUriEncode(value, true),
		] as const)
		.sort(([aKey, aValue], [bKey, bValue]) =>
			aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
		)
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
}

function signingKey(
	secretAccessKey: string,
	date: string,
	region: string,
): Buffer {
	const kDate = hmac(`AWS4${secretAccessKey}`, date);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, SERVICE);
	return hmac(kService, AWS4_REQUEST);
}

function ttlSeconds(
	configuredSeconds: number,
	input: S3CompatiblePresignInput,
): number | null {
	if (input.expiresAt !== null && input.expiresAt <= input.nowMs) return null;
	const artifactSeconds =
		input.expiresAt === null
			? MAX_S3_PRESIGN_SECONDS
			: Math.floor((input.expiresAt - input.nowMs) / 1000);
	const ttl = Math.min(
		configuredSeconds,
		artifactSeconds,
		MAX_S3_PRESIGN_SECONDS,
	);
	return ttl >= 1 ? ttl : null;
}

export function createS3CompatiblePresigner(
	config: S3CompatiblePresignerConfig,
): S3CompatiblePresigner {
	let endpoint: URL | null = null;
	try {
		endpoint = new URL(config.endpoint);
	} catch {
		endpoint = null;
	}
	const region = config.region.trim();
	const accessKeyId = config.accessKeyId.trim();
	const secretAccessKey = config.secretAccessKey.trim();
	const configuredTtl = Math.floor(
		config.expiresSeconds ?? DEFAULT_PRESIGN_SECONDS,
	);
	const enabled =
		endpoint !== null &&
		endpoint.protocol === "https:" &&
		region !== "" &&
		accessKeyId !== "" &&
		secretAccessKey !== "" &&
		configuredTtl >= 1;

	return (input: S3CompatiblePresignInput): PresignedDownloadUrl | null => {
		if (!enabled || endpoint === null) return null;
		if (input.bucket.trim() === "" || input.key.trim() === "") return null;
		const ttl = ttlSeconds(configuredTtl, input);
		if (ttl === null) return null;

		const { date, dateTime } = awsDateParts(input.nowMs);
		const scope = `${date}/${region}/${SERVICE}/${AWS4_REQUEST}`;
		const credential = `${accessKeyId}/${scope}`;
		const basePath = endpoint.pathname.replace(/\/+$/g, "");
		const canonicalUri = `${basePath}/${awsUriEncode(input.bucket, true)}/${awsUriEncode(input.key, false)}`;
		const params: Array<readonly [string, string]> = [
			["X-Amz-Algorithm", AWS4_ALGORITHM],
			["X-Amz-Credential", credential],
			["X-Amz-Date", dateTime],
			["X-Amz-Expires", String(ttl)],
			["X-Amz-SignedHeaders", "host"],
		];
		const query = canonicalQuery(params);
		const canonicalHeaders = `host:${endpoint.host}\n`;
		const canonicalRequest = [
			"GET",
			canonicalUri,
			query,
			canonicalHeaders,
			"host",
			UNSIGNED_PAYLOAD,
		].join("\n");
		const stringToSign = [
			AWS4_ALGORITHM,
			dateTime,
			scope,
			sha256Hex(canonicalRequest),
		].join("\n");
		const signature = hex(
			hmac(signingKey(secretAccessKey, date, region), stringToSign),
		);

		return {
			url: `${endpoint.origin}${canonicalUri}?${query}&X-Amz-Signature=${signature}`,
			expiresAt: input.nowMs + ttl * 1000,
		};
	};
}
