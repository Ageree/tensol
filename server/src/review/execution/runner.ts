import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ReviewResult } from "../types.ts";
import {
	EXECUTION_ARTIFACT_KINDS,
	type PrExecutionInput,
	type PrExecutionResult,
	type ReviewExecutionArtifactInput,
	type ReviewExecutionArtifactKind,
} from "./types.ts";

export interface PrExecutionRunner {
	run(input: PrExecutionInput): Promise<PrExecutionResult>;
}

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

export interface RemotePrExecutionRunnerOptions {
	readonly url: string;
	readonly secret: string;
	readonly timeoutMs?: number;
	readonly maxArtifacts?: number;
	readonly maxInlineBytes?: number;
	readonly fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 11 * 60_000;
const DEFAULT_MAX_ARTIFACTS = 24;
const DEFAULT_MAX_INLINE_BYTES = 32_768;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const SUMMARY_LIMIT = 12_000;
const LABEL_LIMIT = 160;
const MIME_LIMIT = 120;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const FULL_COMMIT_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const KIND_SET = new Set<string>(EXECUTION_ARTIFACT_KINDS);
const PR_EXECUTION_AUDIENCE = "sthrip-pr-worker";
const PR_EXECUTION_ENVELOPE_TTL_SECONDS = 5 * 60;

export function appendExecutionSummary(
	result: ReviewResult,
	execution: PrExecutionResult | null,
): ReviewResult {
	if (execution === null) return result;
	const executionSummary = execution.summaryMd.trim();
	return {
		...result,
		score0to5:
			execution.status === "failed" ? Math.min(result.score0to5, 2) : result.score0to5,
		summaryMd:
			executionSummary === ""
				? result.summaryMd
				: `${result.summaryMd.trim()}\n\n---\n\n${executionSummary}`,
	};
}

export function createRemotePrExecutionRunner(
	opts: RemotePrExecutionRunnerOptions,
): PrExecutionRunner {
	const endpoint = new URL(opts.url);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = opts.fetchImpl ?? fetch;
	return {
		async run(input) {
			if (!FULL_COMMIT_SHA_RE.test(input.headSha)) {
				throw new Error("PR execution requires a full immutable head SHA");
			}
			const issuedAt = Math.floor(Date.now() / 1000);
			const body = JSON.stringify({
				type: "pr_execution",
				iat: issuedAt,
				exp: issuedAt + PR_EXECUTION_ENVELOPE_TTL_SECONDS,
				nonce: randomUUID(),
				aud: PR_EXECUTION_AUDIENCE,
				input,
			});
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await fetchImpl(endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-sthrip-execution-signature": signPayload(body, opts.secret),
					},
					body,
					signal: controller.signal,
				});
				if (!res.ok) {
					throw new Error(`PR execution worker returned HTTP ${res.status}`);
				}
				const responseText = await readCappedResponseText(
					res,
					DEFAULT_MAX_RESPONSE_BYTES,
				);
				return normalizeExecutionResult(JSON.parse(responseText), opts);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

async function readCappedResponseText(
	res: Response,
	maxBytes: number,
): Promise<string> {
	const contentLength = res.headers.get("content-length");
	if (contentLength !== null && Number(contentLength) > maxBytes) {
		throw new Error("PR execution worker response exceeded size limit");
	}
	if (res.body === null) return "";

	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error("PR execution worker response exceeded size limit");
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export function signPayload(body: string, secret: string): string {
	const digest = createHmac("sha256", secret).update(body).digest("hex");
	return `sha256=${digest}`;
}

export function verifyPayloadSignature(
	body: string,
	secret: string,
	header: string | null | undefined,
): boolean {
	if (!header?.startsWith("sha256=")) return false;
	const expected = Buffer.from(signPayload(body, secret));
	const received = Buffer.from(header);
	return (
		expected.length === received.length && timingSafeEqual(expected, received)
	);
}

export function normalizeExecutionResult(
	value: unknown,
	opts: {
		readonly maxArtifacts?: number;
		readonly maxInlineBytes?: number;
	} = {},
): PrExecutionResult {
	const record = value && typeof value === "object" ? value : {};
	const raw = record as {
		status?: unknown;
		summaryMd?: unknown;
		summary_md?: unknown;
		artifacts?: unknown;
	};
	const status = normalizeStatus(raw.status);
	const artifacts = Array.isArray(raw.artifacts)
		? raw.artifacts
				.slice(0, opts.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS)
				.map((artifact) =>
					normalizeArtifact(artifact, opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES),
				)
				.filter((artifact): artifact is ReviewExecutionArtifactInput =>
					artifact !== null,
				)
		: [];
	return {
		status,
		summaryMd: trimText(
			typeof raw.summaryMd === "string"
				? raw.summaryMd
				: typeof raw.summary_md === "string"
					? raw.summary_md
					: buildDefaultSummary(status, artifacts),
			SUMMARY_LIMIT,
		),
		artifacts,
	};
}

function normalizeStatus(value: unknown): PrExecutionResult["status"] {
	switch (value) {
		case "skipped":
		case "running":
		case "passed":
		case "failed":
		case "error":
			return value;
		default:
			return "error";
	}
}

function normalizeArtifact(
	value: unknown,
	maxInlineBytes: number,
): ReviewExecutionArtifactInput | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const kind = normalizeKind(raw.kind);
	if (kind === null) return null;
	const inlineBody =
		typeof raw.inlineBody === "string"
			? raw.inlineBody
			: typeof raw.inline_body === "string"
				? raw.inline_body
				: null;
	const createdAt =
		typeof raw.createdAt === "number"
			? raw.createdAt
			: typeof raw.created_at === "number"
				? raw.created_at
				: undefined;
	return {
		kind,
		label: trimText(String(raw.label ?? kind), LABEL_LIMIT),
		summaryMd: trimText(
			typeof raw.summaryMd === "string"
				? raw.summaryMd
				: typeof raw.summary_md === "string"
					? raw.summary_md
					: "",
			SUMMARY_LIMIT,
		),
		storageKey: nullableString(raw.storageKey ?? raw.storage_key),
		inlineBody:
			inlineBody === null ? null : trimUtf8Bytes(inlineBody, maxInlineBytes),
		mimeType: nullableTrimmed(raw.mimeType ?? raw.mime_type, MIME_LIMIT),
		sha256:
			typeof raw.sha256 === "string" && SHA256_RE.test(raw.sha256)
				? raw.sha256.toLowerCase()
				: null,
		byteSize: normalizeByteSize(raw.byteSize ?? raw.byte_size),
		...(createdAt === undefined ? {} : { createdAt }),
	};
}

function normalizeKind(value: unknown): ReviewExecutionArtifactKind | null {
	if (typeof value !== "string" || !KIND_SET.has(value)) return null;
	return value as ReviewExecutionArtifactKind;
}

function normalizeByteSize(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: null;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nullableTrimmed(value: unknown, max: number): string | null {
	return typeof value === "string" && value.trim() !== ""
		? trimText(value, max)
		: null;
}

function trimText(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function trimUtf8Bytes(value: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= maxBytes) return value;
	return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

function buildDefaultSummary(
	status: PrExecutionResult["status"],
	artifacts: readonly ReviewExecutionArtifactInput[],
): string {
	const label =
		status === "passed"
			? "passed"
			: status === "failed"
				? "found runtime failures"
				: status === "skipped"
					? "was skipped"
					: "ended with an error";
	return `## Runtime evidence\n\nPR execution ${label}. Artifacts collected: ${artifacts.length}.`;
}
