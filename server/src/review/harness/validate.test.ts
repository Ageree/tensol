import { expect, test } from "bun:test";
import type { ChatTransport } from "../agent/loop.ts";
import type { LlmClient } from "../reviewer.ts";
import type { CandidateFinding, HarnessSession } from "./types.ts";
import { runValidate } from "./validate.ts";

const cand = (file: string): CandidateFinding => ({
	filePath: file,
	startLine: 1,
	isVulnerability: true,
	category: "SQLi",
	cwe: ["CWE-89"],
	rationaleMd: "r",
	reachable: true,
	confidence: "high",
	cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
	title: "t",
	auditorLens: "injection",
});

const idleLlm: LlmClient = {
	complete: async () => "",
};

const refute = (refuted: boolean): ChatTransport => ({
	chat: async () => ({
		content: JSON.stringify({
			refuted,
			confidence: "high",
			reason_md: "x",
			reachable: !refuted,
		}),
		toolCalls: [],
	}),
});

const sess = (refuted: boolean): HarnessSession => ({
	models: {
		debater: refute(refuted),
		counterpoint: refute(false),
		auditor: refute(false),
		recon: idleLlm,
		triage: idleLlm,
	},
	modelNames: { auditor: "A", debater: "D", counterpoint: "C", recon: "R" },
	budget: { assertWithin() {} },
	counterpointDistinct: true,
});

const opts = { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 };

test("drops refuted, keeps survivors as plain LlmVerdict[]", async () => {
	const survivors = await runValidate({
		candidates: [cand("a.ts"), cand("b.ts")],
		files: [],
		session: sess(false),
		tools: [],
		opts,
	});
	expect(survivors.length).toBe(2);
	expect(
		(survivors[0] as unknown as Record<string, unknown>).auditorLens,
	).toBeUndefined();
	expect(survivors[0]?.rationaleMd).toContain("Multi-model debate");
});

test("all refuted → empty", async () => {
	const survivors = await runValidate({
		candidates: [cand("a.ts")],
		files: [],
		session: sess(true),
		tools: [],
		opts,
	});
	expect(survivors.length).toBe(0);
});

test("budget exhaustion keeps the finding at its ORIGINAL confidence (still scored, not demoted)", async () => {
	const exhausted: HarnessSession = {
		models: {
			debater: refute(false),
			counterpoint: refute(false),
			auditor: refute(false),
			recon: idleLlm,
			triage: idleLlm,
		},
		modelNames: { auditor: "A", debater: "D", counterpoint: "C", recon: "R" },
		budget: {
			assertWithin() {
				throw new Error("budget exhausted");
			},
		},
		counterpointDistinct: true,
	};
	const survivors = await runValidate({
		candidates: [cand("a.ts")], // confidence "high"
		files: [],
		session: exhausted,
		tools: [],
		opts,
	});
	expect(survivors.length).toBe(1);
	// NOT demoted to "medium" — a flagged finding must stay in the scored set when
	// debate simply couldn't run.
	expect(survivors[0]?.confidence).toBe("high");
	expect(
		(survivors[0] as unknown as Record<string, unknown>).auditorLens,
	).toBeUndefined();
});
