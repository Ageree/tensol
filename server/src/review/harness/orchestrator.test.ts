import { expect, test } from "bun:test";
import type { ChatTransport } from "../agent/loop.ts";
import type { LlmClient } from "../reviewer.ts";
import type { DiffFile } from "../types.ts";
import { runHarness } from "./orchestrator.ts";
import type { HarnessSession } from "./types.ts";

const files: DiffFile[] = [
	{
		path: "a.ts",
		status: "added",
		contents:
			"const id = req.query.id; db.query(`SELECT * FROM users WHERE id=${id}`);",
	},
];

const auditorJson = JSON.stringify({
	summary: "",
	verdicts: [
		{
			candidate_id: "c",
			file_path: "a.ts",
			start_line: 1,
			is_vulnerability: true,
			category: "SQLi",
			cwe: ["CWE-89"],
			rationale_md: "tainted",
			reachable: true,
			confidence: "high",
			cvss: {
				AV: "N",
				AC: "L",
				PR: "N",
				UI: "N",
				S: "U",
				C: "H",
				I: "H",
				A: "H",
			},
			title: "SQLi",
		},
	],
});
const auditor: ChatTransport = {
	chat: async () => ({ content: auditorJson, toolCalls: [] }),
};
const noRefute: ChatTransport = {
	chat: async () => ({
		content: JSON.stringify({
			refuted: false,
			confidence: "high",
			reason_md: "ok",
			reachable: true,
		}),
		toolCalls: [],
	}),
};
const reconLlm: LlmClient = { complete: async () => "threat model" };
const triageLlm: LlmClient = { complete: async () => "" };

const session: HarnessSession = {
	models: {
		auditor,
		debater: noRefute,
		counterpoint: noRefute,
		recon: reconLlm,
		triage: triageLlm,
	},
	modelNames: { auditor: "A", debater: "D", counterpoint: "C", recon: "R" },
	budget: { assertWithin() {} },
	counterpointDistinct: true,
};

test("runHarness returns surviving LlmVerdict[] from Prepare→Scan→Validate", async () => {
	const verdicts = await runHarness({ files, repoDir: "/repo" }, session, {
		opts: { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 },
	});
	expect(verdicts.length).toBe(1);
	expect(verdicts[0]?.category).toBe("SQLi");
	expect(verdicts[0]?.rationaleMd).toContain("Multi-model debate");
});

test("runHarness returns [] when Scan yields no candidates", async () => {
	const emptyAuditor: ChatTransport = {
		chat: async () => ({
			content: JSON.stringify({ summary: "", verdicts: [] }),
			toolCalls: [],
		}),
	};
	const emptySession: HarnessSession = {
		...session,
		models: { ...session.models, auditor: emptyAuditor },
	};
	const verdicts = await runHarness({ files, repoDir: "/repo" }, emptySession, {
		opts: { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 },
	});
	expect(verdicts).toEqual([]);
});
