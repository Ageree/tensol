import { TENSOL_I18N } from "../../src/i18n.ts";

const TECHNICAL_KEY_RE = /[A-Z_]/;

function collectLeakCandidates(
	obj: unknown,
	path: readonly string[] = [],
	acc: string[] = [],
): string[] {
	if (typeof obj !== "object" || obj === null) return acc;
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		const nextPath = [...path, k];
		if (typeof v === "object" && v !== null && !Array.isArray(v)) {
			collectLeakCandidates(v, nextPath, acc);
			continue;
		}
		acc.push(nextPath.join("."));
		if (TECHNICAL_KEY_RE.test(k)) {
			acc.push(k);
		}
	}
	return acc;
}

export const i18nKeys: readonly string[] = Object.freeze(
	collectLeakCandidates(TENSOL_I18N.en),
);

export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
