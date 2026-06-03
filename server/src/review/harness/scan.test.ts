import { test, expect } from "bun:test";
import { runScan } from "./scan.ts";
import type { ExpertKey } from "../research/types.ts";
import type { AttackSurfaceUnit, HarnessSession } from "./types.ts";
import type { Candidate } from "../types.ts";

const okVerdict = (file: string) =>
  JSON.stringify({
    summary: "",
    verdicts: [
      {
        candidate_id: "c",
        file_path: file,
        start_line: 1,
        is_vulnerability: true,
        category: "SQLi",
        cwe: ["CWE-89"],
        rationale_md: "r",
        reachable: true,
        confidence: "high",
        cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
        title: "t",
      },
    ],
  });

const session = (auditor: unknown): HarnessSession =>
  ({
    models: { auditor, debater: auditor, counterpoint: auditor, recon: {}, triage: {} },
    modelNames: { auditor: "A", debater: "D", counterpoint: "C", recon: "R" },
    budget: { assertWithin() {} },
    counterpointDistinct: true,
  }) as never;

const unit = (lens: ExpertKey, file: string): AttackSurfaceUnit => ({
  id: `${lens}:${file}`,
  lens,
  filePath: file,
  line: 1,
  snippet: "s",
  signals: ["x"],
  priority: 0.5,
});

const candidates: Candidate[] = [{ id: "c", filePath: "a.ts", source: "llm", hint: "h" }];
const files = [{ path: "a.ts", status: "added" as const, contents: "x" }];
const opts = { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 };

test("fans out over lenses and dedups identical findings", async () => {
  const transport = { chat: async () => ({ content: okVerdict("a.ts"), toolCalls: [] }) };
  const out = await runScan({
    units: [unit("injection", "a.ts"), unit("broken-access-control", "a.ts")],
    files,
    candidates,
    threatModelMd: "",
    session: session(transport),
    tools: [],
    opts,
  });
  expect(out.length).toBe(1); // both auditors emit a.ts:1 SQLi → deduped
});

test("a throwing auditor transport does not abort the scan", async () => {
  const transport = { chat: async () => { throw new Error("boom"); } };
  const out = await runScan({
    units: [unit("injection", "a.ts"), unit("cryptographic-failures", "b.ts")],
    files,
    candidates,
    threatModelMd: "",
    session: session(transport),
    tools: [],
    opts,
  });
  expect(out).toEqual([]); // graceful: failures degrade to no findings, no throw
});

test("falls back to one generalist auditor when recon finds no units but candidates exist", async () => {
  let calls = 0;
  const transport = {
    chat: async () => {
      calls += 1;
      return { content: okVerdict("a.ts"), toolCalls: [] };
    },
  };
  const out = await runScan({
    units: [], // recon detected nothing
    files,
    candidates, // ...but there are candidates to audit
    threatModelMd: "",
    session: session(transport),
    tools: [],
    opts,
  });
  expect(calls).toBe(1);
  expect(out.length).toBe(1);
});

test("no units and no candidates → no auditors, no findings", async () => {
  let calls = 0;
  const transport = { chat: async () => { calls += 1; return { content: okVerdict("a.ts"), toolCalls: [] }; } };
  const out = await runScan({
    units: [],
    files: [],
    candidates: [],
    threatModelMd: "",
    session: session(transport),
    tools: [],
    opts,
  });
  expect(calls).toBe(0);
  expect(out).toEqual([]);
});

test("caps the number of auditors at maxAuditors", async () => {
  let calls = 0;
  const transport = { chat: async () => { calls += 1; return { content: JSON.stringify({ summary: "", verdicts: [] }), toolCalls: [] }; } };
  await runScan({
    units: [unit("injection", "a.ts"), unit("authentication-failures", "b.ts"), unit("cryptographic-failures", "c.ts")],
    files,
    candidates,
    threatModelMd: "",
    session: session(transport),
    tools: [],
    opts: { ...opts, maxAuditors: 2 },
  });
  expect(calls).toBe(2); // 3 lenses available, only 2 auditors spawned
});
