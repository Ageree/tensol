import { test, expect } from "bun:test";
import { debate } from "./debate.ts";
import type { CandidateFinding, HarnessSession } from "./types.ts";

const finding: CandidateFinding = {
  filePath: "a.ts",
  startLine: 3,
  isVulnerability: true,
  category: "SQLi",
  cwe: ["CWE-89"],
  rationaleMd: "tainted",
  reachable: true,
  confidence: "high",
  cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
  title: "SQLi",
  auditorLens: "injection",
};

const refute = (refuted: boolean, confidence: "high" | "low" = "high") => ({
  chat: async () => ({
    content: JSON.stringify({ refuted, confidence, reason_md: "x", reachable: !refuted }),
    toolCalls: [],
  }),
});

const sess = (debater: unknown, counterpoint: unknown, distinct = true): HarnessSession =>
  ({
    models: { debater, counterpoint, auditor: debater, recon: {}, triage: {} },
    modelNames: { auditor: "A", debater: "D", counterpoint: "C", recon: "R" },
    budget: { assertWithin() {} },
    counterpointDistinct: distinct,
  }) as never;

test("R1 refutes (high) → dropped", async () => {
  const r = await debate({ finding, files: [], session: sess(refute(true), refute(false)), tools: [], maxRounds: 3 });
  expect(r.survived).toBe(false);
});

test("both fail to refute → high credibility, survives, annotated", async () => {
  const r = await debate({ finding, files: [], session: sess(refute(false), refute(false)), tools: [], maxRounds: 3 });
  expect(r.survived).toBe(true);
  expect(r.credibility).toBeGreaterThanOrEqual(0.85);
  expect(r.finding.rationaleMd).toContain("Multi-model debate");
});

test("R1 fails, R2 refutes → contested downgrade, survives at low confidence", async () => {
  const r = await debate({ finding, files: [], session: sess(refute(false), refute(true)), tools: [], maxRounds: 3 });
  expect(r.survived).toBe(true);
  expect(r.credibility).toBeLessThan(0.6);
  expect(r.finding.confidence).toBe("low");
  expect(r.finding.rationaleMd.toLowerCase()).toContain("contested");
});

test("counterpoint not distinct → credibility capped (no true ensemble)", async () => {
  const r = await debate({
    finding,
    files: [],
    session: sess(refute(false), refute(false), false),
    tools: [],
    maxRounds: 3,
  });
  expect(r.credibility).toBeLessThanOrEqual(0.7);
});

test("non-distinct agree-agree does NOT demote the auditor's confidence below original", async () => {
  // finding.confidence = "high". In the default (empty-counterpoint, non-distinct)
  // agree-agree path the old code clobbered this to "medium" → unverified → dropped
  // from the 0-5 score. The validator must HOLD at the auditor's original "high"
  // (it may raise, never lower, when neither model could refute).
  const r = await debate({
    finding,
    files: [],
    session: sess(refute(false), refute(false), false),
    tools: [],
    maxRounds: 3,
  });
  expect(r.survived).toBe(true);
  expect(r.finding.confidence).toBe("high");
});
