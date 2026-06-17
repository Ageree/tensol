import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

const GCS_SIGNED_URL_ALGORITHM = "GOOG4-RSA-SHA256";
const GCS_SIGNED_URL_SCOPE = "auto/storage/goog4_request";
const MAX_GCS_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_PRESIGN_SECONDS = 15 * 60;

export interface GcsSignedUrlPresignerConfig {
	readonly auth?: GoogleAuth;
	readonly clientEmail?: string;
	readonly sign?: (data: string) => Promise<string>;
	readonly expiresSeconds?: number;
}

export interface GcsSignedUrlInput {
	readonly bucket: string;
	readonly key: string;
	readonly expiresAt: number | null;
	readonly nowMs: number;
}

export interface PresignedDownloadUrl {
	readonly url: string;
	readonly expiresAt: number;
}

export type GcsSignedUrlPresigner = (
	input: GcsSignedUrlInput,
) => Promise<PresignedDownloadUrl | null>;

function sha256Hex(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function utcDateParts(ms: number): { date: string; dateTime: string } {
	const d = new Date(ms);
	const date = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
	const dateTime = `${date}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
	return { date, dateTime };
}

function uriEncode(value: string, encodeSlash: boolean): string {
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
		if (unreserved || (!encodeSlash && ch === "/")) out += ch;
		else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

function canonicalQuery(params: ReadonlyArray<readonly [string, string]>): string {
	return [...params]
		.map(([key, value]) => [
			uriEncode(key, true),
			uriEncode(value, true),
		] as const)
		.sort(([aKey, aValue], [bKey, bValue]) =>
			aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
		)
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
}

function ttlSeconds(configuredSeconds: number, input: GcsSignedUrlInput): number | null {
	if (input.expiresAt !== null && input.expiresAt <= input.nowMs) return null;
	const artifactSeconds =
		input.expiresAt === null
			? MAX_GCS_SIGNED_URL_SECONDS
			: Math.floor((input.expiresAt - input.nowMs) / 1000);
	const ttl = Math.min(
		configuredSeconds,
		artifactSeconds,
		MAX_GCS_SIGNED_URL_SECONDS,
	);
	return ttl >= 1 ? ttl : null;
}

export function createGcsSignedUrlPresigner(
	config: GcsSignedUrlPresignerConfig = {},
): GcsSignedUrlPresigner {
	const auth = config.auth ?? new GoogleAuth();
	const configuredTtl = Math.floor(
		config.expiresSeconds ?? DEFAULT_PRESIGN_SECONDS,
	);
	let clientEmailPromise: Promise<string> | null = null;

	async function clientEmail(): Promise<string> {
		if (config.clientEmail) return config.clientEmail.trim();
		clientEmailPromise ??= auth.getCredentials().then((creds) => {
			if (!creds.client_email) {
				throw new Error("gcs signed url: client_email unavailable");
			}
			return creds.client_email;
		});
		return clientEmailPromise;
	}

	async function sign(data: string): Promise<string> {
		return config.sign ? config.sign(data) : auth.sign(data);
	}

	return async (input) => {
		if (configuredTtl < 1) return null;
		if (input.bucket.trim() === "" || input.key.trim() === "") return null;
		const ttl = ttlSeconds(configuredTtl, input);
		if (ttl === null) return null;

		const email = await clientEmail();
		if (!email) return null;
		const { date, dateTime } = utcDateParts(input.nowMs);
		const credential = `${email}/${date}/${GCS_SIGNED_URL_SCOPE}`;
		const canonicalUri = `/${uriEncode(input.bucket, true)}/${uriEncode(input.key, false)}`;
		const params: Array<readonly [string, string]> = [
			["X-Goog-Algorithm", GCS_SIGNED_URL_ALGORITHM],
			["X-Goog-Credential", credential],
			["X-Goog-Date", dateTime],
			["X-Goog-Expires", String(ttl)],
			["X-Goog-SignedHeaders", "host"],
		];
		const query = canonicalQuery(params);
		const canonicalRequest = [
			"GET",
			canonicalUri,
			query,
			"host:storage.googleapis.com\n",
			"host",
			"UNSIGNED-PAYLOAD",
		].join("\n");
		const stringToSign = [
			GCS_SIGNED_URL_ALGORITHM,
			dateTime,
			`${date}/${GCS_SIGNED_URL_SCOPE}`,
			sha256Hex(canonicalRequest),
		].join("\n");
		const signature = Buffer.from(await sign(stringToSign), "base64").toString(
			"hex",
		);

		return {
			url: `https://storage.googleapis.com${canonicalUri}?${query}&X-Goog-Signature=${signature}`,
			expiresAt: input.nowMs + ttl * 1000,
		};
	};
}
