export type EvidenceStorageEnv = {
	bucket: string;
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
		prefix: firstNonEmpty(env, "TENSOL_EVIDENCE_PREFIX") || "scans/",
	};
}

export function isEvidenceStorageConfigured(env: EvidenceStorageEnv): boolean {
	return env.bucket.trim() !== "";
}
