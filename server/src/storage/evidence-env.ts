export type EvidenceStorageEnv = {
	bucket: string;
	region: string;
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	prefix: string;
};

function firstNonEmpty(env: NodeJS.ProcessEnv, ...names: string[]): string {
	for (const name of names) {
		const value = env[name];
		if (value !== undefined && value !== "") return value;
	}
	return "";
}

export function resolveEvidenceStorageEnv(
	env: NodeJS.ProcessEnv = process.env,
): EvidenceStorageEnv {
	return {
		bucket: firstNonEmpty(env, "TENSOL_EVIDENCE_BUCKET"),
		region:
			firstNonEmpty(env, "AWS_REGION", "TENSOL_EVIDENCE_S3_REGION") ||
			"auto",
		endpoint: firstNonEmpty(
			env,
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
		prefix: firstNonEmpty(env, "TENSOL_EVIDENCE_PREFIX") || "scans/",
	};
}
