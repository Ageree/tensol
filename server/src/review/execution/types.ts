import type { DiffFile } from "../types.ts";

export const EXECUTION_ARTIFACT_KINDS = [
	"log",
	"screenshot",
	"api_trace",
	"generated_test",
	"video",
	"file",
] as const;

export type ReviewExecutionArtifactKind =
	(typeof EXECUTION_ARTIFACT_KINDS)[number];

export type ReviewExecutionStatus =
	| "skipped"
	| "running"
	| "passed"
	| "failed"
	| "error";

export interface PrExecutionInput {
	readonly reviewId: string;
	readonly repoId: string;
	readonly owner: string;
	readonly name: string;
	readonly prNumber: number;
	readonly headSha: string;
	readonly baseSha?: string | null;
	readonly files: readonly DiffFile[];
}

export interface ReviewExecutionArtifactInput {
	readonly kind: ReviewExecutionArtifactKind;
	readonly label: string;
	readonly summaryMd: string;
	readonly storageKey?: string | null;
	readonly inlineBody?: string | null;
	readonly mimeType?: string | null;
	readonly sha256?: string | null;
	readonly byteSize?: number | null;
	readonly createdAt?: number;
}

export interface PrExecutionResult {
	readonly status: ReviewExecutionStatus;
	readonly summaryMd: string;
	readonly artifacts: readonly ReviewExecutionArtifactInput[];
}
