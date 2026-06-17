import { GoogleAuth } from "google-auth-library";

const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

type ObjectStorageBody = Buffer | Uint8Array | ArrayBuffer | Blob | string;

export interface PutObjectInput {
	readonly bucket: string;
	readonly key: string;
	readonly body: ObjectStorageBody;
	readonly contentType?: string;
}

export interface ObjectStorageClient {
	putObject(input: PutObjectInput): Promise<void>;
	getObject(input: { bucket: string; key: string }): Promise<Buffer>;
	deleteObject(input: { bucket: string; key: string }): Promise<void>;
}

export interface GcsObjectStorageOpts {
	readonly auth?: GoogleAuth;
	readonly fetcher?: typeof fetch;
}

function objectUrl(bucket: string, key: string): string {
	return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
}

async function readError(res: Response): Promise<string> {
	try {
		return (await res.text()).slice(0, 500);
	} catch {
		return "<unreadable>";
	}
}

export function createGcsObjectStorage(
	opts: GcsObjectStorageOpts = {},
): ObjectStorageClient {
	const auth = opts.auth ?? new GoogleAuth({ scopes: [GCS_SCOPE] });
	const fetcher = opts.fetcher ?? fetch;

	async function token(): Promise<string> {
		const client = await auth.getClient();
		const tokenResp = await client.getAccessToken();
		const value =
			typeof tokenResp === "string" ? tokenResp : (tokenResp?.token ?? "");
		if (!value) throw new Error("gcs storage: empty access token");
		return value;
	}

	return {
		async putObject(input) {
			const url = new URL(
				`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(input.bucket)}/o`,
			);
			url.searchParams.set("uploadType", "media");
			url.searchParams.set("name", input.key);
			const res = await fetcher(url.toString(), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${await token()}`,
					...(input.contentType ? { "Content-Type": input.contentType } : {}),
				},
				body: input.body,
			});
			if (!res.ok) {
				throw new Error(
					`gcs putObject: HTTP ${res.status} ${res.statusText} :: ${await readError(res)}`,
				);
			}
			await readError(res);
		},

		async getObject(input) {
			const url = new URL(objectUrl(input.bucket, input.key));
			url.searchParams.set("alt", "media");
			const res = await fetcher(url.toString(), {
				headers: { Authorization: `Bearer ${await token()}` },
			});
			if (!res.ok) {
				throw new Error(
					`gcs getObject: HTTP ${res.status} ${res.statusText} :: ${await readError(res)}`,
				);
			}
			return Buffer.from(await res.arrayBuffer());
		},

		async deleteObject(input) {
			const res = await fetcher(objectUrl(input.bucket, input.key), {
				method: "DELETE",
				headers: { Authorization: `Bearer ${await token()}` },
			});
			if (!res.ok && res.status !== 404) {
				throw new Error(
					`gcs deleteObject: HTTP ${res.status} ${res.statusText} :: ${await readError(res)}`,
				);
			}
			await readError(res);
		},
	};
}
