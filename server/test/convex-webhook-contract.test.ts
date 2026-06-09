import { describe, expect, test } from "bun:test";

import {
	normalizeWebhookFinding,
	parseSignature,
	parseTerminalStatus,
	webhookTarget,
} from "../../convex/lib/webhook";

describe("Convex scan-complete webhook contract helpers", () => {
	test("accepts the production vps-agent V2 body shape", () => {
		const body = {
			scan_order_id: "convex-order-id",
			status: "completed",
			completed_at: 1_776_000_000_000,
			duration_seconds: 42,
			findings: [
				{
					raw_yaml_frontmatter: {
						id: "finding-1",
						severity: "high",
						title: "Exposed admin panel",
						affected_target: "https://example.com/admin",
					},
					body_md: "The panel is reachable without authentication.",
					evidence_keys: ["evidence/request.txt", 123, "evidence/response.txt"],
				},
			],
		};

		expect(webhookTarget(body)).toEqual({ scanOrderId: "convex-order-id" });
		expect(parseTerminalStatus(body.status)).toBe("completed");
		expect(normalizeWebhookFinding(body.findings[0], 0)).toEqual({
			external_id: "finding-1",
			severity: "high",
			title: "Exposed admin panel",
			target: "https://example.com/admin",
			body_md: "The panel is reachable without authentication.",
			evidence_keys: ["evidence/request.txt", "evidence/response.txt"],
			cwe: [],
			mitre: [],
			confidence: "high",
		});
	});

	test("parses the strict X-Tensol-Signature envelope", () => {
		const parsed = parseSignature(`v1=${"A".repeat(64)}, t=1776000000`);

		expect(parsed).toEqual({ t: 1_776_000_000, v1: "a".repeat(64) });
		expect(parseSignature(`t=1776000000, v1=${"a".repeat(63)}`)).toBeNull();
		expect(
			parseSignature(`t=1776000000, v1=${"a".repeat(64)}, v0=legacy`),
		).toBeNull();
		expect(parseSignature(`t=-1, v1=${"a".repeat(64)}`)).toBeNull();
	});
});
