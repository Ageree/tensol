/**
 * Tests for {@link agentReview} — the agentic PR-review pass.
 *
 * Uses {@link FakeChatClient} to script the "model" and the PR tools over a fake
 * GitHub client. Asserts the loop's final message flows through the SAME strict
 * verdict gate as the fixed-prompt path: only `is_vulnerability:true` verdicts
 * survive, junk collapses to `[]` (never throws), and the model can read context
 * via tools mid-loop.
 */
import { expect, test } from "bun:test";
import { agentReview } from "./review.ts";
import { buildPrAgentTools, type PrToolGitHub, type PrToolTarget } from "./tools/pr-tools.ts";
import { FakeChatClient } from "../reviewer.ts";
import type { ContextBundle, Candidate } from "../types.ts";

const context: ContextBundle = {
  diffSummary: "1 file changed",
  files: [{ path: "a.ts", reason: "changed", content: "query('SELECT '+id)" }],
  relatedSymbols: [],
  tokenEstimate: 12,
};

const candidates: Candidate[] = [
  {
    id: "c1",
    filePath: "a.ts",
    source: "sast",
    hint: "string-concat SQL",
    cwe: ["CWE-89"],
  },
];

const target: PrToolTarget = { owner: "o", name: "r", pr: 7, ref: "head" };

/** A schema-valid review JSON with one real vulnerability. */
const validVerdictJson = JSON.stringify({
  summary: "one issue",
  verdicts: [
    {
      candidate_id: "c1",
      file_path: "a.ts",
      is_vulnerability: true,
      category: "SQL Injection",
      cwe: ["CWE-89"],
      rationale_md: "user id flows unsanitized into the query string",
      reachable: true,
      confidence: "high",
      cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
      title: "SQL injection in a.ts",
    },
  ],
});

function fakeGh(over: Partial<PrToolGitHub> = {}): PrToolGitHub {
  return {
    async getFileContents() {
      return "full file source";
    },
    async getPullRequestFiles() {
      return [{ path: "a.ts", status: "modified", patch: "@@ +1 @@\n+query" }];
    },
    ...over,
  };
}

test("returns parsed verdicts when the model answers immediately", async () => {
  const transport = new FakeChatClient(() => ({ content: validVerdictJson, toolCalls: [] }));
  const res = await agentReview({
    context,
    candidates,
    transport,
    tools: buildPrAgentTools(fakeGh(), target),
    maxRounds: 6,
  });
  expect(res.stopReason).toBe("final");
  expect(res.verdicts).toHaveLength(1);
  expect(res.verdicts[0]!.category).toBe("SQL Injection");
  expect(res.verdicts[0]!.confidence).toBe("high");
});

test("the model can read a file via a tool, then answer", async () => {
  let toolWasCalled = false;
  const gh = fakeGh({
    async getFileContents() {
      toolWasCalled = true;
      return "function handler(id){ return query('SELECT '+id) }";
    },
  });
  const transport = new FakeChatClient((args, i) => {
    if (i === 0) {
      return {
        content: null,
        toolCalls: [{ id: "t1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
      };
    }
    // The tool result must be present in the history fed back.
    const toolMsg = args.messages.find((m) => m.role === "tool");
    expect(toolMsg && "content" in toolMsg ? toolMsg.content : "").toContain("handler");
    return { content: validVerdictJson, toolCalls: [] };
  });

  const res = await agentReview({
    context,
    candidates,
    transport,
    tools: buildPrAgentTools(gh, target),
    maxRounds: 6,
  });

  expect(toolWasCalled).toBe(true);
  expect(res.toolCallsExecuted).toBe(1);
  expect(res.rounds).toBe(2);
  expect(res.verdicts).toHaveLength(1);
});

test("a non-vulnerability verdict is filtered out by the shared gate", async () => {
  const notVuln = JSON.stringify({
    summary: "nothing",
    verdicts: [
      {
        candidate_id: "c1",
        file_path: "a.ts",
        is_vulnerability: false,
        category: "SQL Injection",
        cwe: ["CWE-89"],
        rationale_md: "the id is an integer column — not exploitable",
        reachable: false,
        confidence: "low",
        cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "N", I: "N", A: "N" },
        title: "not exploitable",
      },
    ],
  });
  const transport = new FakeChatClient(() => ({ content: notVuln, toolCalls: [] }));
  const res = await agentReview({
    context,
    candidates,
    transport,
    tools: buildPrAgentTools(fakeGh(), target),
    maxRounds: 6,
  });
  expect(res.verdicts).toHaveLength(0);
});

test("a junk final answer collapses to [] (never throws)", async () => {
  const transport = new FakeChatClient(() => ({ content: "I think it's fine, no JSON here", toolCalls: [] }));
  const res = await agentReview({
    context,
    candidates,
    transport,
    tools: buildPrAgentTools(fakeGh(), target),
    maxRounds: 6,
  });
  expect(res.verdicts).toEqual([]);
  expect(res.stopReason).toBe("final");
});

test("a tripped budget yields [] verdicts and stopReason 'budget'", async () => {
  const budget = {
    assertWithin() {
      throw new Error("over budget");
    },
  };
  const transport = new FakeChatClient(() => ({ content: validVerdictJson, toolCalls: [] }));
  const res = await agentReview({
    context,
    candidates,
    transport,
    tools: buildPrAgentTools(fakeGh(), target),
    maxRounds: 6,
    budget,
  });
  expect(res.stopReason).toBe("budget");
  expect(res.verdicts).toEqual([]);
});

test("hitting maxRounds without an answer yields [] (no self-declared finding)", async () => {
  // Model loops forever calling a tool, never answering.
  const transport = new FakeChatClient(() => ({
    content: null,
    toolCalls: [{ id: "t", name: "get_pr_diff", argumentsJson: "{}" }],
  }));
  const res = await agentReview({
    context,
    candidates,
    transport,
    tools: buildPrAgentTools(fakeGh(), target),
    maxRounds: 3,
  });
  expect(res.stopReason).toBe("max_rounds");
  expect(res.verdicts).toEqual([]);
});
