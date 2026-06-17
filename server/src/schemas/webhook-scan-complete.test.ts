import { describe, expect, it } from "bun:test";

import {
	FindingFromAgentSchema,
	FindingSeverityEnum,
	RawYamlFrontmatterSchema,
	WebhookScanCompleteBodySchema,
} from "./webhook-scan-complete";

/**
 * Tests for `server/src/schemas/webhook-scan-complete.ts` — Zod schemas for the
 * inbound webhook from `vps-agent` defined in
 * `specs/002-blackbox-mvp/contracts/webhook.md`.
 *
 * Fixture below is a synthetic 5-finding Juice Shop-style payload
 * (representative of the 2026-05-19 OAuth smoke output: 3 critical +
 * 1 high + 1 medium). A full 9-finding fixture lands in
 * `server/test/fixtures/webhook-scan-complete-juiceshop.json` under T050.
 */

const validScanOrderId = "01HZX5QK9V7Y3W2P8N6M4J0KAB";

const juiceShopFixture = {
	scan_order_id: validScanOrderId,
	completed_at: 1779180090123,
	decepticon_events_count: 759,
	duration_seconds: 2280,
	evidence_archive_url:
		"gs://tensol-evidence-prod/scans/01HZX5QK9V7Y3W2P8N6M4J0KAB/evidence.tar.gz",
	findings: [
		{
			raw_yaml_frontmatter: {
				id: "FIND-001",
				severity: "critical",
				title: "SQL injection in /rest/user/login allows authentication bypass",
				cvss_score: 9.8,
				cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
				cvss_version: "3.1",
				cwe: ["CWE-89"],
				mitre: ["T1190"],
				affected_target: "juice-shop.local",
				affected_component: "/rest/user/login",
				confidence: "verified",
				phase: "exploit",
				agent: "exploit",
				discovered_at: "2026-05-19T18:42:11Z",
			},
			body_md:
				"# [CRITICAL] SQL injection authentication bypass\n\n" +
				"## Steps to reproduce\n\nPOST `/rest/user/login` with payload `' OR 1=1--`\n\n" +
				"## Evidence\nSee attached jwt-decoded.txt for admin token.",
			evidence_keys: [
				"scans/01HZX5QK9V7Y3W2P8N6M4J0KAB/FIND-001_login-response.json",
				"scans/01HZX5QK9V7Y3W2P8N6M4J0KAB/FIND-001_jwt-decoded.txt",
			],
		},
		{
			raw_yaml_frontmatter: {
				id: "FIND-002",
				severity: "critical",
				title: "Hardcoded admin credentials in /api/admin",
				cvss_score: 9.1,
				cwe: ["CWE-798"],
				mitre: ["T1078"],
				affected_target: "juice-shop.local",
				confidence: "verified",
			},
			body_md:
				"# [CRITICAL] Hardcoded admin credentials\n\nAdmin login: admin/admin123",
			evidence_keys: ["scans/01HZX5QK9V7Y3W2P8N6M4J0KAB/FIND-002_creds.txt"],
		},
		{
			raw_yaml_frontmatter: {
				id: "FIND-003",
				severity: "critical",
				title: "JWT secret disclosed via /api/.well-known",
				cwe: ["CWE-200"],
			},
			body_md: "# [CRITICAL] JWT secret disclosure",
			evidence_keys: [],
		},
		{
			raw_yaml_frontmatter: {
				id: "FIND-004",
				severity: "high",
				title: "Stored XSS in product review submission",
				cvss_score: 8.0,
				cwe: ["CWE-79"],
			},
			body_md:
				"# [HIGH] Stored XSS\n\nPOST `/rest/products/1/reviews` with `<script>`",
			evidence_keys: [],
		},
		{
			raw_yaml_frontmatter: {
				id: "FIND-005",
				severity: "medium",
				title: "Missing CSRF token on /profile",
				cwe: ["CWE-352"],
			},
			body_md: "# [MEDIUM] CSRF token missing",
			evidence_keys: [],
		},
	],
};

// ─────────────────────────────────────────────────────────────────────────────
// FindingSeverityEnum — must match data-model.md E5 CHECK constraint.
// ─────────────────────────────────────────────────────────────────────────────

describe("FindingSeverityEnum", () => {
	it.each([
		["critical"] as const,
		["high"] as const,
		["medium"] as const,
		["low"] as const,
		["informational"] as const,
	])("accepts %s", (sev) => {
		expect(FindingSeverityEnum.parse(sev)).toBe(sev);
	});

	it.each([
		["info"], // old v1 spelling — must NOT be accepted
		["CRITICAL"], // wrong case
		["urgent"],
		[""],
		["null"],
	])("rejects invalid severity %s", (sev) => {
		expect(() => FindingSeverityEnum.parse(sev)).toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// RawYamlFrontmatterSchema — required id/severity/title plus optional extras.
// ─────────────────────────────────────────────────────────────────────────────

describe("RawYamlFrontmatterSchema", () => {
	it("accepts the minimum required keys (id+severity+title)", () => {
		const parsed = RawYamlFrontmatterSchema.parse({
			id: "FIND-001",
			severity: "critical",
			title: "SQLi in /login",
		});
		expect(parsed.id).toBe("FIND-001");
		expect(parsed.severity).toBe("critical");
		expect(parsed.title).toBe("SQLi in /login");
	});

	it("preserves optional typed extras (cvss/cwe/mitre/confidence)", () => {
		const parsed = RawYamlFrontmatterSchema.parse({
			id: "FIND-002",
			severity: "high",
			title: "XSS in /reviews",
			cvss_score: 8.1,
			cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:N",
			cvss_version: "3.1",
			cwe: ["CWE-79"],
			mitre: ["T1059"],
			confidence: "verified",
		});
		expect(parsed.cvss_score).toBe(8.1);
		expect(parsed.cwe).toEqual(["CWE-79"]);
		expect(parsed.mitre).toEqual(["T1059"]);
		expect(parsed.confidence).toBe("verified");
	});

	it("preserves unknown keys (forward-compat per webhook.md)", () => {
		const parsed = RawYamlFrontmatterSchema.parse({
			id: "FIND-003",
			severity: "medium",
			title: "Missing CSRF",
			future_field_we_dont_know_yet: "some-value",
			another_unknown: { nested: true },
		});
		// Cast to any to read unknown passthrough key without TS friction.
		expect(
			(parsed as Record<string, unknown>).future_field_we_dont_know_yet,
		).toBe("some-value");
	});

	it.each([["id"], ["severity"], ["title"]])(
		"rejects missing required key %s",
		(key) => {
			const base: Record<string, unknown> = {
				id: "FIND-001",
				severity: "critical",
				title: "Some title",
			};
			delete base[key];
			expect(() => RawYamlFrontmatterSchema.parse(base)).toThrow();
		},
	);

	it("rejects empty id", () => {
		expect(() =>
			RawYamlFrontmatterSchema.parse({ id: "", severity: "high", title: "T" }),
		).toThrow();
	});

	it("rejects empty title", () => {
		expect(() =>
			RawYamlFrontmatterSchema.parse({
				id: "FIND-001",
				severity: "high",
				title: "",
			}),
		).toThrow();
	});

	it("rejects invalid severity", () => {
		expect(() =>
			RawYamlFrontmatterSchema.parse({
				id: "FIND-001",
				severity: "info", // old v1 spelling not allowed
				title: "T",
			}),
		).toThrow();
	});

	it("rejects out-of-range cvss_score", () => {
		expect(() =>
			RawYamlFrontmatterSchema.parse({
				id: "FIND-001",
				severity: "high",
				title: "T",
				cvss_score: 11,
			}),
		).toThrow();
		expect(() =>
			RawYamlFrontmatterSchema.parse({
				id: "FIND-001",
				severity: "high",
				title: "T",
				cvss_score: -0.1,
			}),
		).toThrow();
	});

	it("rejects invalid confidence enum", () => {
		expect(() =>
			RawYamlFrontmatterSchema.parse({
				id: "FIND-001",
				severity: "high",
				title: "T",
				confidence: "definitely-maybe",
			}),
		).toThrow();
	});
});

describe("WebhookScanCompleteBodySchema — terminal status", () => {
	it("keeps legacy success payloads valid by defaulting status to completed", () => {
		const parsed = WebhookScanCompleteBodySchema.parse(juiceShopFixture);

		expect(parsed.status).toBe("completed");
		expect(parsed.failure_reason).toBeNull();
		expect(parsed.evidence_archive_url).toBe(
			juiceShopFixture.evidence_archive_url,
		);
	});

	it("accepts failed terminal callbacks without evidence_archive_url", () => {
		const parsed = WebhookScanCompleteBodySchema.parse({
			scan_order_id: validScanOrderId,
			status: "failed",
			failure_reason: "decepticon_failed: docker_exit_137",
			completed_at: 1779180090123,
			duration_seconds: 17,
			findings: [],
		});

		expect(parsed.status).toBe("failed");
		expect(parsed.failure_reason).toBe("decepticon_failed: docker_exit_137");
		expect(parsed.evidence_archive_url).toBeNull();
	});

	it("rejects failed terminal callbacks without a failure_reason", () => {
		expect(() =>
			WebhookScanCompleteBodySchema.parse({
				scan_order_id: validScanOrderId,
				status: "failed",
				completed_at: 1779180090123,
				duration_seconds: 17,
				findings: [],
			}),
		).toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// raw_yaml_frontmatter string-parse path
// ─────────────────────────────────────────────────────────────────────────────

describe("raw_yaml_frontmatter string-parse path", () => {
	it("parses a simple inline YAML frontmatter string", () => {
		const yamlString = [
			"id: FIND-001",
			"severity: critical",
			"title: SQLi in /login",
		].join("\n");

		const finding = FindingFromAgentSchema.parse({
			raw_yaml_frontmatter: yamlString,
			body_md: "# body",
			evidence_keys: [],
		});
		expect(finding.raw_yaml_frontmatter.id).toBe("FIND-001");
		expect(finding.raw_yaml_frontmatter.severity).toBe("critical");
		expect(finding.raw_yaml_frontmatter.title).toBe("SQLi in /login");
	});

	it("string variant rejects missing id key", () => {
		const yamlString = "severity: high\ntitle: Some finding";
		expect(() =>
			FindingFromAgentSchema.parse({
				raw_yaml_frontmatter: yamlString,
				body_md: "# body",
				evidence_keys: [],
			}),
		).toThrow();
	});

	it("strips surrounding --- frontmatter fences if present", () => {
		const yamlString = [
			"---",
			"id: FIND-007",
			"severity: high",
			'title: "Quoted: title with colon"',
			"---",
		].join("\n");

		const finding = FindingFromAgentSchema.parse({
			raw_yaml_frontmatter: yamlString,
			body_md: "# body",
			evidence_keys: [],
		});
		expect(finding.raw_yaml_frontmatter.id).toBe("FIND-007");
		expect(finding.raw_yaml_frontmatter.title).toBe("Quoted: title with colon");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FindingFromAgentSchema — one finding wire shape
// ─────────────────────────────────────────────────────────────────────────────

describe("FindingFromAgentSchema", () => {
	it("requires raw_yaml_frontmatter, body_md, evidence_keys", () => {
		const full = juiceShopFixture.findings[0];
		expect(() => FindingFromAgentSchema.parse(full)).not.toThrow();
	});

	it.each([["raw_yaml_frontmatter"], ["body_md"], ["evidence_keys"]])(
		"rejects missing top-level field %s",
		(key) => {
			const base = { ...juiceShopFixture.findings[0] } as Record<
				string,
				unknown
			>;
			delete base[key];
			expect(() => FindingFromAgentSchema.parse(base)).toThrow();
		},
	);

	it("rejects when raw_yaml_frontmatter is missing id+severity+title", () => {
		expect(() =>
			FindingFromAgentSchema.parse({
				raw_yaml_frontmatter: { severity: "high", title: "no id" },
				body_md: "# body",
				evidence_keys: [],
			}),
		).toThrow();
	});

	it("rejects when raw_yaml_frontmatter is neither object nor string", () => {
		expect(() =>
			FindingFromAgentSchema.parse({
				raw_yaml_frontmatter: 42,
				body_md: "# body",
				evidence_keys: [],
			}),
		).toThrow();
	});

	it("accepts empty evidence_keys array", () => {
		const parsed = FindingFromAgentSchema.parse({
			raw_yaml_frontmatter: {
				id: "FIND-001",
				severity: "low",
				title: "T",
			},
			body_md: "# body",
			evidence_keys: [],
		});
		expect(parsed.evidence_keys).toEqual([]);
	});

	it("rejects body_md exceeding the 50 KiB cap", () => {
		const huge = "x".repeat(50_001);
		expect(() =>
			FindingFromAgentSchema.parse({
				raw_yaml_frontmatter: {
					id: "FIND-001",
					severity: "high",
					title: "T",
				},
				body_md: huge,
				evidence_keys: [],
			}),
		).toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// WebhookScanCompleteBodySchema — full top-level body
// ─────────────────────────────────────────────────────────────────────────────

describe("WebhookScanCompleteBodySchema", () => {
	it("accepts a valid Juice-Shop-style fixture", () => {
		const parsed = WebhookScanCompleteBodySchema.parse(juiceShopFixture);
		expect(parsed.scan_order_id).toBe(validScanOrderId);
		expect(parsed.findings).toHaveLength(5);
		const [first, , , fourth] = parsed.findings;
		expect(first?.raw_yaml_frontmatter.id).toBe("FIND-001");
		expect(first?.raw_yaml_frontmatter.severity).toBe("critical");
		expect(fourth?.raw_yaml_frontmatter.severity).toBe("high");
	});

	it("accepts zero-findings payload", () => {
		const parsed = WebhookScanCompleteBodySchema.parse({
			...juiceShopFixture,
			findings: [],
		});
		expect(parsed.findings).toEqual([]);
	});

	it("decepticon_events_count is optional", () => {
		const { decepticon_events_count: _ignored, ...rest } = juiceShopFixture;
		const parsed = WebhookScanCompleteBodySchema.parse(rest);
		expect(parsed.decepticon_events_count).toBeUndefined();
	});

	it.each([
		["scan_order_id"],
		["completed_at"],
		["findings"],
		["evidence_archive_url"],
		["duration_seconds"],
	])("rejects missing required top-level field %s", (key) => {
		const broken = { ...juiceShopFixture } as Record<string, unknown>;
		delete broken[key];
		expect(() => WebhookScanCompleteBodySchema.parse(broken)).toThrow();
	});

	it("rejects malformed scan_order_id (not a Crockford ULID)", () => {
		expect(() =>
			WebhookScanCompleteBodySchema.parse({
				...juiceShopFixture,
				scan_order_id: "not-a-ulid",
			}),
		).toThrow();
		expect(() =>
			WebhookScanCompleteBodySchema.parse({
				...juiceShopFixture,
				scan_order_id: "01HZX5QK9V7Y3W2P8N6M4J0KAi", // lowercase i (excluded)
			}),
		).toThrow();
	});

	it("rejects non-integer completed_at", () => {
		expect(() =>
			WebhookScanCompleteBodySchema.parse({
				...juiceShopFixture,
				completed_at: 1779180090123.45,
			}),
		).toThrow();
	});

	it("rejects negative duration_seconds", () => {
		expect(() =>
			WebhookScanCompleteBodySchema.parse({
				...juiceShopFixture,
				duration_seconds: -1,
			}),
		).toThrow();
	});

	it("rejects evidence_archive_url that is not a storage URI", () => {
		expect(() =>
			WebhookScanCompleteBodySchema.parse({
				...juiceShopFixture,
				evidence_archive_url: "https://example.com/archive.tar.gz",
			}),
		).toThrow();
		expect(() =>
			WebhookScanCompleteBodySchema.parse({
				...juiceShopFixture,
				evidence_archive_url: "not-a-uri",
			}),
		).toThrow();
	});

	it("rejects findings array exceeding the 1000-entry cap", () => {
		const oneFinding = juiceShopFixture.findings[0];
		const overflow = {
			...juiceShopFixture,
			findings: Array.from({ length: 1001 }, () => oneFinding),
		};
		expect(() => WebhookScanCompleteBodySchema.parse(overflow)).toThrow();
	});

	it("rejects when a single finding has invalid raw_yaml_frontmatter", () => {
		const broken = {
			...juiceShopFixture,
			findings: [
				...juiceShopFixture.findings.slice(0, 1),
				{
					...juiceShopFixture.findings[1],
					raw_yaml_frontmatter: { severity: "high", title: "missing id" },
				},
			],
		};
		expect(() => WebhookScanCompleteBodySchema.parse(broken)).toThrow();
	});

	it("severity_breakdown computed via input: 3 critical / 1 high / 1 medium", () => {
		const parsed = WebhookScanCompleteBodySchema.parse(juiceShopFixture);
		const counts = parsed.findings.reduce<Record<string, number>>((acc, f) => {
			const sev = f.raw_yaml_frontmatter.severity;
			acc[sev] = (acc[sev] ?? 0) + 1;
			return acc;
		}, {});
		expect(counts.critical).toBe(3);
		expect(counts.high).toBe(1);
		expect(counts.medium).toBe(1);
	});
});
