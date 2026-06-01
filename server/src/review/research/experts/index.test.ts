/**
 * Tests for the OWASP expert agents (LLM) — TASK 1.4.
 *
 * Verifies: a verified expert result parses (with decomposed CVSS + proof
 * obligations), malformed model output collapses to a safe `rejected` result
 * (never throws), and all 12 expert prompts load.
 */
import { expect, test } from "bun:test";
import { runExpert, loadAllExpertPrompts } from "./index.ts";
import { FakeLlmClient } from "../../reviewer.ts";
import { EXPERT_KEYS } from "../types.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "S001",
  expert: "injection",
  routingUnitIds: ["U001"],
  targetPaths: ["a.ts"],
  proofQuestion: "?",
  evidenceRequired: ["source"],
};
const ctx = { files: [{ path: "a.ts", content: 'db.query("SELECT "+id)' }] };
const verified = JSON.stringify({
  scenario_id: "S001",
  expert: "injection",
  status: "verified",
  primary_vulnerability_class: "SQL Injection",
  summary: "attacker-controlled id concatenated into SQL",
  evidence: [{ path: "a.ts", line: 1, snippet: "db.query", note: "sink" }],
  proof_obligations: [
    { id: "reaches-sink", status: "proven_vulnerable", summary: "id flows to query" },
  ],
  cwe: ["CWE-89"],
  cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
});

test("parses a verified expert result with proof obligations + cvss", async () => {
  const r = await runExpert(scenario, ctx, new FakeLlmClient(() => verified));
  expect(r.status).toBe("verified");
  expect(r.cvss.C).toBe("H");
  expect(r.proofObligations[0]!.status).toBe("proven_vulnerable");
  expect(r.cwe).toContain("CWE-89");
});
test("bad output -> safe rejected result, never throws", async () => {
  const r = await runExpert(scenario, ctx, new FakeLlmClient(() => "garbage"));
  expect(r.status).toBe("rejected");
});
test("all 12 expert prompts load", async () => {
  const all = await loadAllExpertPrompts();
  expect(Object.keys(all).sort()).toEqual([...EXPERT_KEYS].sort());
  for (const k of EXPERT_KEYS) expect(all[k].length).toBeGreaterThan(100);
});
