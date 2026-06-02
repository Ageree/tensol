/**
 * Tests for the independent finding-triage agent (TASK 1.5).
 *
 * Verifies: (a) accepted/duplicate decisions are coerced from the snake_case
 * wire shape to the camelCase `TriageDecision` (incl. `duplicateOf` and the
 * mapped `finalConfidence`), (b) garbage / non-JSON output collapses to []
 * (never throws), and (c) an empty candidate list short-circuits WITHOUT
 * calling the LLM.
 */
import { expect, test } from "bun:test";
import { triage } from "./triage.ts";
import { FakeLlmClient } from "../reviewer.ts";
import type { FindingCandidate } from "./types.ts";

const cvss = { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" } as const;
const cands: FindingCandidate[] = [
  { candidateId: "S001-F001", scenarioId: "S001", expert: "injection", title: "SQLi in list()", cwe: ["CWE-89"], cvss, rationaleMd: "id -> query", evidence: [], filePath: "a.ts" },
  { candidateId: "S002-F001", scenarioId: "S002", expert: "injection", title: "SQLi in list() (dup)", cwe: ["CWE-89"], cvss, rationaleMd: "same", evidence: [], filePath: "a.ts" },
];
const out = JSON.stringify({ decisions: [
  { candidate_id: "S001-F001", decision: "accepted", confidence: "high", severity_rationale: "reachable" },
  { candidate_id: "S002-F001", decision: "duplicate", confidence: "medium", severity_rationale: "same root", duplicate_of: "S001-F001" },
]});

test("accepts one and dedupes the other", async () => {
  const decisions = await triage(cands, new FakeLlmClient(() => out));
  expect(decisions).toHaveLength(2);
  const dup = decisions.find(d => d.decision === "duplicate");
  expect(dup?.duplicateOf).toBe("S001-F001");
  expect(decisions.find(d => d.decision === "accepted")?.finalConfidence).toBe("high");
});
test("garbage -> []", async () => {
  expect(await triage(cands, new FakeLlmClient(() => "x"))).toEqual([]);
});

test("strips a ```json code fence the model wrapped its output in", async () => {
  const fenced = "```json\n" + out + "\n```";
  const decisions = await triage(cands, new FakeLlmClient(() => fenced));
  expect(decisions).toHaveLength(2);
  expect(decisions.find(d => d.decision === "accepted")?.candidateId).toBe("S001-F001");
});

test("omits duplicateOf for non-duplicate decisions", async () => {
  const decisions = await triage(cands, new FakeLlmClient(() => out));
  const accepted = decisions.find(d => d.decision === "accepted");
  expect(accepted).toBeDefined();
  expect("duplicateOf" in (accepted as object)).toBe(false);
});

test("maps confidence levels straight through (high/medium/low)", async () => {
  const decisions = await triage(cands, new FakeLlmClient(() => out));
  expect(decisions.find(d => d.candidateId === "S001-F001")?.finalConfidence).toBe("high");
  expect(decisions.find(d => d.candidateId === "S002-F001")?.finalConfidence).toBe("medium");
});

test("structurally-invalid JSON (decisions not an array) collapses to []", async () => {
  const bad = JSON.stringify({ decisions: "oops" });
  expect(await triage(cands, new FakeLlmClient(() => bad))).toEqual([]);
});

test("missing decisions array collapses to []", async () => {
  expect(await triage(cands, new FakeLlmClient(() => JSON.stringify({ foo: "bar" })))).toEqual([]);
});

test("unknown decision enum value collapses to []", async () => {
  const bad = JSON.stringify({ decisions: [
    { candidate_id: "S001-F001", decision: "totally-bogus", confidence: "high", severity_rationale: "x" },
  ]});
  expect(await triage(cands, new FakeLlmClient(() => bad))).toEqual([]);
});

test("empty candidates -> no llm call -> []", async () => {
  let called = false;
  const decisions = await triage([], new FakeLlmClient(() => { called = true; return out; }));
  expect(decisions).toEqual([]);
  expect(called).toBe(false);
});

test("the user prompt lists each candidate's id, expert, title, cwe and file", async () => {
  let seenUser = "";
  const llm = new FakeLlmClient((user) => { seenUser = user; return out; });
  await triage(cands, llm);
  expect(seenUser).toContain("S001-F001");
  expect(seenUser).toContain("injection");
  expect(seenUser).toContain("SQLi in list()");
  expect(seenUser).toContain("CWE-89");
  expect(seenUser).toContain("a.ts");
});

test("the system prompt includes the loaded finding-triage.md content", async () => {
  let seenSystem = "";
  const llm = new FakeLlmClient(() => out);
  // Wrap complete to capture the system prompt.
  const wrapped = {
    async complete(args: { system: string; user: string }) {
      seenSystem = args.system;
      return llm.complete(args);
    },
  };
  await triage(cands, wrapped);
  expect(seenSystem).toContain("Finding Triage");
  expect(seenSystem).toContain("decisions");
});
