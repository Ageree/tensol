/**
 * Orchestrator (TASK 1.6) — end-to-end deep-research pipeline tests with a
 * staged FakeLlmClient. The fake returns DIFFERENT canned JSON per pipeline
 * stage, detected by a substring in the USER prompt each module builds:
 *
 *   - router  user prompt:  "## Routing units" / "scoped scenarios"
 *   - triage  user prompt:  "candidates to triage"
 *   - expert  user prompt:  "## Scenario" + "proof_question" (fallthrough)
 *
 * No network/process — the whole pipeline runs over the injected fake LLM.
 */
import { expect, test } from "bun:test";
import { runResearch } from "./orchestrator.ts";
import { FakeLlmClient } from "../reviewer.ts";
import type { DiffFile } from "../types.ts";

const files: DiffFile[] = [
  {
    path: "a.ts",
    status: "modified",
    contents:
      'function f(req){ return db.query("SELECT * FROM t WHERE id="+req.id); }',
  },
];

/** Stage-detecting fake: router → triage → expert (fallthrough). */
function scripted(user: string): string {
  // Router stage — recognised by the routing-unit listing header / doctrine line.
  if (/routing units|scoped scenarios/i.test(user)) {
    return JSON.stringify({
      scenarios: [
        {
          id: "S001",
          expert: "injection",
          routing_unit_ids: ["U001"],
          target_paths: ["a.ts"],
          proof_question: "attacker controlled?",
          evidence_required: ["source", "sink"],
          priority: "high",
        },
      ],
    });
  }
  // Triage stage — recognised by the triage prompt's header.
  if (/candidates to triage/i.test(user)) {
    return JSON.stringify({
      decisions: [
        {
          candidate_id: "S001-F001",
          decision: "accepted",
          confidence: "high",
          severity_rationale: "reachable",
        },
      ],
    });
  }
  // Expert stage (fallthrough).
  return JSON.stringify({
    scenario_id: "S001",
    expert: "injection",
    status: "verified",
    primary_vulnerability_class: "SQL Injection",
    summary: "id concatenated into SQL",
    evidence: [{ path: "a.ts", line: 1, snippet: "db.query", note: "sink" }],
    proof_obligations: [
      { id: "reach", status: "proven_vulnerable", summary: "flows" },
    ],
    cwe: ["CWE-89"],
    cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
  });
}

test("end-to-end research produces a reachable SQLi verdict", async () => {
  const verdicts = await runResearch(files, new FakeLlmClient(scripted));
  expect(verdicts).toHaveLength(1);
  expect(verdicts[0]!.isVulnerability).toBe(true);
  expect(verdicts[0]!.reachable).toBe(true);
  expect(verdicts[0]!.cwe).toContain("CWE-89");
  // A `verified`-status source result lifts confidence to "verified"
  // (triage emitted "high"; the verified source overrides — see types.ts
  // TriageDecision.finalConfidence contract).
  expect(verdicts[0]!.confidence).toBe("verified");
  expect(verdicts[0]!.category).toBe("SQL Injection");
  expect(verdicts[0]!.candidateId).toBe("S001-F001");
  expect(verdicts[0]!.filePath).toBe("a.ts");
});

test("no routing units -> [] without calling the LLM", async () => {
  let called = false;
  const fake = new FakeLlmClient(() => {
    called = true;
    return "{}";
  });
  // A file with no security-relevant tokens yields no routing units.
  const benign: DiffFile[] = [
    { path: "b.ts", status: "modified", contents: "const x = 1 + 2;\n" },
  ];
  const verdicts = await runResearch(benign, fake);
  expect(verdicts).toEqual([]);
  expect(called).toBe(false);
});

test("rejected triage decision yields no verdict", async () => {
  function rejecter(user: string): string {
    if (/routing units|scoped scenarios/i.test(user)) {
      return JSON.stringify({
        scenarios: [
          {
            id: "S001",
            expert: "injection",
            routing_unit_ids: ["U001"],
            target_paths: ["a.ts"],
            proof_question: "attacker controlled?",
            evidence_required: ["source", "sink"],
          },
        ],
      });
    }
    if (/candidates to triage/i.test(user)) {
      return JSON.stringify({
        decisions: [
          {
            candidate_id: "S001-F001",
            decision: "rejected",
            confidence: "low",
            severity_rationale: "not reachable",
          },
        ],
      });
    }
    return JSON.stringify({
      scenario_id: "S001",
      expert: "injection",
      status: "candidate",
      primary_vulnerability_class: "SQL Injection",
      summary: "maybe",
      evidence: [{ path: "a.ts", line: 1, snippet: "db.query", note: "sink" }],
      proof_obligations: [],
      cwe: ["CWE-89"],
      cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
    });
  }
  const verdicts = await runResearch(files, new FakeLlmClient(rejecter));
  expect(verdicts).toEqual([]);
});

test("a throwing expert never aborts the whole run", async () => {
  // Router emits one scenario; the expert stage throws; the run must not reject.
  function throwingExpert(user: string): string {
    if (/routing units|scoped scenarios/i.test(user)) {
      return JSON.stringify({
        scenarios: [
          {
            id: "S001",
            expert: "injection",
            routing_unit_ids: ["U001"],
            target_paths: ["a.ts"],
            proof_question: "q?",
            evidence_required: [],
          },
        ],
      });
    }
    if (/candidates to triage/i.test(user)) {
      return JSON.stringify({ decisions: [] });
    }
    throw new Error("expert transport blew up");
  }
  const verdicts = await runResearch(files, new FakeLlmClient(throwingExpert));
  // The throwing expert is treated as a rejected result -> no candidate ->
  // no verdict, but the run resolves cleanly.
  expect(verdicts).toEqual([]);
});

test("budget assertWithin is invoked per scenario", async () => {
  let calls = 0;
  const budget = {
    assertWithin() {
      calls += 1;
    },
  };
  await runResearch(files, new FakeLlmClient(scripted), { budget });
  expect(calls).toBeGreaterThanOrEqual(1);
});
