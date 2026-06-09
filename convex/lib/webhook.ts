const HMAC_SHA256_HEX_LENGTH = 64;

const SEVERITIES = [
	"critical",
	"high",
	"medium",
	"low",
	"informational",
] as const;
type Severity = (typeof SEVERITIES)[number];

const CONFIDENCES = ["verified", "high", "medium", "low"] as const;
type Confidence = (typeof CONFIDENCES)[number];

export interface ParsedSignature {
	readonly t: number;
	readonly v1: string;
}

export interface WebhookTarget {
	readonly scanId?: string;
	readonly scanOrderId?: string;
}

export interface NormalizedFinding {
	readonly external_id: string;
	readonly severity: Severity;
	readonly title: string;
	readonly target?: string;
	readonly body_md?: string;
	readonly evidence_keys: string[];
	readonly cwe: string[];
	readonly mitre: string[];
	readonly confidence: Confidence;
}

export function parseSignature(raw: string | null): ParsedSignature | null {
	if (!raw) return null;
	const parts = raw.split(",").map((p) => p.trim());
	if (parts.length !== 2) return null;

	let t: number | null = null;
	let v1: string | null = null;
	for (const part of parts) {
		const eqIdx = part.indexOf("=");
		if (eqIdx <= 0) return null;
		const key = part.slice(0, eqIdx).trim();
		const value = part.slice(eqIdx + 1).trim();
		if (key === "t") {
			if (!/^\d+$/.test(value)) return null;
			const n = Number.parseInt(value, 10);
			if (!Number.isFinite(n) || n <= 0) return null;
			t = n;
		} else if (key === "v1") {
			if (
				value.length !== HMAC_SHA256_HEX_LENGTH ||
				!/^[0-9a-f]+$/i.test(value)
			) {
				return null;
			}
			v1 = value.toLowerCase();
		} else {
			return null;
		}
	}

	if (t === null || v1 === null) return null;
	return { t, v1 };
}

export function parseTerminalStatus(
	value: unknown,
): "completed" | "failed" | null {
	if (value === undefined || value === "completed") return "completed";
	if (value === "failed") return "failed";
	return null;
}

export function parseCompletedAt(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

export function failureReason(value: unknown): string {
	if (typeof value !== "string") return "agent_failed";
	const trimmed = value.trim();
	return trimmed.length === 0 ? "agent_failed" : trimmed.slice(0, 255);
}

export function webhookTarget(
	body: Record<string, unknown>,
): WebhookTarget | null {
	const scanId = stringOrUndefined(body.scan_id);
	const scanOrderId = stringOrUndefined(body.scan_order_id);
	if (scanId === undefined && scanOrderId === undefined) return null;
	return {
		...(scanId === undefined ? {} : { scanId }),
		...(scanOrderId === undefined ? {} : { scanOrderId }),
	};
}

export function normalizeWebhookFinding(
	value: unknown,
	index: number,
): NormalizedFinding {
	const finding = recordOrEmpty(value);
	const frontmatter = recordOrEmpty(finding.raw_yaml_frontmatter);
	const target = stringOrUndefined(
		finding.target ?? frontmatter.affected_target,
	);
	const bodyMd = stringOrUndefined(finding.body_md ?? finding.body);
	return {
		external_id:
			stringOrUndefined(finding.external_id) ??
			stringOrUndefined(frontmatter.id) ??
			`agent-${index + 1}`,
		severity: severity(finding.severity ?? frontmatter.severity),
		title:
			stringOrUndefined(finding.title) ??
			stringOrUndefined(frontmatter.title) ??
			"Agent finding",
		...(target === undefined ? {} : { target }),
		...(bodyMd === undefined ? {} : { body_md: bodyMd }),
		evidence_keys: stringArray(finding.evidence_keys),
		cwe: stringArray(finding.cwe ?? frontmatter.cwe),
		mitre: stringArray(finding.mitre ?? frontmatter.mitre),
		confidence: confidence(finding.confidence ?? frontmatter.confidence),
	};
}

export function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function optionalString(value: unknown): string | undefined {
	return stringOrUndefined(value);
}

export function optionalRecord(
	value: unknown,
): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function severity(value: unknown): Severity {
	return typeof value === "string" &&
		(SEVERITIES as readonly string[]).includes(value)
		? (value as Severity)
		: "medium";
}

function confidence(value: unknown): Confidence {
	return typeof value === "string" &&
		(CONFIDENCES as readonly string[]).includes(value)
		? (value as Confidence)
		: "high";
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function stringOrUndefined(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
