/**
 * Tests for the LLM scenario router (TASK 1.3).
 *
 * Verifies: (a) snake_case wire -> camelCase Scenario coercion, (b) unknown
 * experts are dropped, (c) garbage / non-JSON output collapses to [] (never
 * throws), and (d) an empty routing-unit list short-circuits WITHOUT calling
 * the LLM.
 */
import { expect, test } from "bun:test";
import { routeScenarios } from "./routing.ts";
import { FakeLlmClient } from "../reviewer.ts";
import type { RoutingUnit } from "./types.ts";

const units: RoutingUnit[] = [
  { id: "U001", kind: "sql", category: "sinks", filePath: "a.ts", line: 2, snippet: "db.query(...)", signals: ["query("] },
];
const good = JSON.stringify({ scenarios: [
  { id: "S001", expert: "injection", routing_unit_ids: ["U001"], target_paths: ["a.ts"], proof_question: "Is the query attacker-controlled?", evidence_required: ["source","sink"], priority: "high" },
  { id: "S002", expert: "not-a-real-expert", routing_unit_ids: ["U001"], target_paths: ["a.ts"], proof_question: "x", evidence_required: ["y"] },
]});

test("parses scenarios and drops unknown experts", async () => {
  const out = await routeScenarios(units, new FakeLlmClient(() => good));
  expect(out).toHaveLength(1);
  expect(out[0]!.expert).toBe("injection");
  expect(out[0]!.routingUnitIds).toEqual(["U001"]);
});

test("coerces snake_case wire to camelCase Scenario shape", async () => {
  const out = await routeScenarios(units, new FakeLlmClient(() => good));
  expect(out[0]!).toEqual({
    id: "S001",
    expert: "injection",
    routingUnitIds: ["U001"],
    targetPaths: ["a.ts"],
    proofQuestion: "Is the query attacker-controlled?",
    evidenceRequired: ["source", "sink"],
    priority: "high",
  });
});

test("returns [] on garbage output", async () => {
  const out = await routeScenarios(units, new FakeLlmClient(() => "not json"));
  expect(out).toEqual([]);
});

test("returns [] on fenced JSON that is structurally invalid", async () => {
  const out = await routeScenarios(units, new FakeLlmClient(() => "```json\n{\"scenarios\": \"oops\"}\n```"));
  expect(out).toEqual([]);
});

test("strips a ```json code fence the model wrapped its output in", async () => {
  const fenced = "```json\n" + good + "\n```";
  const out = await routeScenarios(units, new FakeLlmClient(() => fenced));
  expect(out).toHaveLength(1);
  expect(out[0]!.expert).toBe("injection");
});

test("omits priority when the model leaves it out", async () => {
  const noPriority = JSON.stringify({ scenarios: [
    { id: "S001", expert: "injection", routing_unit_ids: ["U001"], target_paths: ["a.ts"], proof_question: "q", evidence_required: ["e"] },
  ]});
  const out = await routeScenarios(units, new FakeLlmClient(() => noPriority));
  expect(out).toHaveLength(1);
  expect("priority" in out[0]!).toBe(false);
});

test("missing scenarios array collapses to []", async () => {
  const out = await routeScenarios(units, new FakeLlmClient(() => JSON.stringify({ foo: "bar" })));
  expect(out).toEqual([]);
});

test("no units -> no llm call -> []", async () => {
  let called = false;
  const out = await routeScenarios([], new FakeLlmClient(() => { called = true; return good; }));
  expect(out).toEqual([]);
  expect(called).toBe(false);
});

test("the user prompt lists each routing unit's id, location and snippet", async () => {
  let seenUser = "";
  const llm = new FakeLlmClient((user) => { seenUser = user; return good; });
  await routeScenarios(units, llm);
  expect(seenUser).toContain("U001");
  expect(seenUser).toContain("a.ts:2");
  expect(seenUser).toContain("db.query(...)");
  expect(seenUser).toContain("sql");
});
