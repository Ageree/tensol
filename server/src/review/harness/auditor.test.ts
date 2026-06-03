import { test, expect } from "bun:test";
import { runAuditor } from "./auditor.ts";
import type { ChatResult } from "../llm/chat-types.ts";
import type { ChatTransport, AgentTool } from "../agent/loop.ts";
import type { DiffFile, Candidate } from "../types.ts";

const files: DiffFile[] = [{ path: "a.ts", status: "added", contents: "const x = req.query.id;" }];
const candidates: Candidate[] = [{ id: "c1", filePath: "a.ts", source: "llm", hint: "tainted input" }];

const vulnJson = JSON.stringify({
  summary: "x",
  verdicts: [
    {
      candidate_id: "c1",
      file_path: "a.ts",
      is_vulnerability: true,
      category: "SQL Injection",
      cwe: ["CWE-89"],
      rationale_md: "tainted query",
      reachable: true,
      confidence: "high",
      cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
      title: "SQLi",
    },
  ],
});

test("auditor parses verdicts, tags the lens, keeps only vulnerabilities", async () => {
  const transport = { chat: async (): Promise<ChatResult> => ({ content: vulnJson, toolCalls: [] }) };
  const out = await runAuditor({
    lens: "injection",
    units: [],
    files,
    candidates,
    threatModelMd: "TM",
    transport,
    tools: [],
    maxRounds: 4,
  });
  expect(out).toHaveLength(1);
  expect(out[0]!.auditorLens).toBe("injection");
  expect(out[0]!.isVulnerability).toBe(true);
  expect(out[0]!.category).toBe("SQL Injection");
});

test("auditor drops non-vulnerabilities", async () => {
  const cleanJson = JSON.stringify({
    summary: "",
    verdicts: [
      {
        candidate_id: "c1",
        file_path: "a.ts",
        is_vulnerability: false,
        category: "x",
        cwe: [],
        rationale_md: "safe",
        reachable: false,
        confidence: "low",
        cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "N", I: "N", A: "N" },
        title: "t",
      },
    ],
  });
  const transport = { chat: async (): Promise<ChatResult> => ({ content: cleanJson, toolCalls: [] }) };
  const out = await runAuditor({
    lens: "injection",
    units: [],
    files,
    candidates,
    threatModelMd: "",
    transport,
    tools: [],
    maxRounds: 4,
  });
  expect(out).toHaveLength(0);
});

test("auditor salvages a final emit when the loop hits a cap without emitting JSON", async () => {
  const readTool: AgentTool = {
    spec: { name: "read_file", description: "r", parameters: { type: "object", properties: {} } },
    run: async () => "file contents",
  };
  // While tools are offered the model keeps calling one → never emits a final
  // answer → the loop trips max_rounds (finalContent=null). The salvage call
  // (no tools) returns the verdict JSON, so the lens still reports.
  let loopCalls = 0;
  const transport: ChatTransport = {
    chat: async (a) => {
      if (a.tools && a.tools.length > 0) {
        loopCalls += 1;
        return { content: "", toolCalls: [{ id: `t${loopCalls}`, name: "read_file", argumentsJson: "{}" }] };
      }
      return { content: vulnJson, toolCalls: [] };
    },
  };
  const out = await runAuditor({
    lens: "injection",
    units: [],
    files,
    candidates,
    threatModelMd: "",
    transport,
    tools: [readTool],
    maxRounds: 2,
  });
  expect(loopCalls).toBeGreaterThanOrEqual(2); // the loop ran to its cap
  expect(out).toHaveLength(1); // and the salvage recovered the finding
  expect(out[0]!.auditorLens).toBe("injection");
});
