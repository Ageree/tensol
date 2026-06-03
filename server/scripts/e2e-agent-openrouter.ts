/**
 * E2E verification — agentic tool-calling foundation against REAL OpenRouter.
 *
 * Exercises OUR code: createOpenRouterClient → createMeteredClient →
 * runAgentLoop / agentReview. Does NOT reimplement wire protocol.
 *
 * Tests:
 *  1. runAgentLoop forces a real tool call (get_secret_number → 4242).
 *  2. agentReview on SQL-injectable code via fake PrToolGitHub.
 *
 * Usage:
 *   bun run scripts/e2e-agent-openrouter.ts
 */

import { createOpenRouterClient } from "../src/review/llm/openrouter.ts";
import type { ChatTransport } from "../src/review/agent/loop.ts";
import { runAgentLoop } from "../src/review/agent/loop.ts";
import { agentReview } from "../src/review/agent/review.ts";
import { buildPrAgentTools } from "../src/review/agent/tools/pr-tools.ts";
import type { PrToolGitHub } from "../src/review/agent/tools/pr-tools.ts";
import { createBudget } from "../src/exploit/budget.ts";
import { createMeteredClient } from "../src/exploit/metered-client.ts";
import type { ContextBundle, Candidate, DiffFile } from "../src/review/types.ts";

// ---------------------------------------------------------------------------
// 0. Preconditions
// ---------------------------------------------------------------------------

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
if (!apiKey) {
  console.error("FATAL: OPENROUTER_API_KEY is not set. Cannot run E2E without a real API key.");
  process.exit(1);
}
console.log("Precondition: OPENROUTER_API_KEY present — proceeding.\n");

const BASE_URL = "https://openrouter.ai/api/v1";
const PRIMARY_MODEL = "openai/gpt-5.5";
const FALLBACK_MODELS = ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"];

// ---------------------------------------------------------------------------
// Helper: try models in fallback order for a given async action
// ---------------------------------------------------------------------------

async function withModelFallback<T>(
  action: (model: string) => Promise<T>,
  label: string,
): Promise<{ result: T; modelUsed: string }> {
  const models = [PRIMARY_MODEL, ...FALLBACK_MODELS];
  let lastErr: Error | null = null;
  for (const model of models) {
    try {
      const result = await action(model);
      if (model !== PRIMARY_MODEL) {
        console.log(`  [SUBSTITUTION] ${PRIMARY_MODEL} unavailable — using ${model} for ${label}`);
      }
      return { result, modelUsed: model };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // 404 or "not a valid model" → try next
      if (msg.includes("404") || msg.includes("not a valid model") || msg.includes("HTTP 404")) {
        console.log(`  [MODEL UNAVAILABLE] ${model}: ${msg.slice(0, 120)}`);
        lastErr = err as Error;
        continue;
      }
      // Any other error (budget, parse, etc.) — propagate immediately
      throw err;
    }
  }
  throw lastErr ?? new Error("All models failed");
}

// ---------------------------------------------------------------------------
// TEST 1 — runAgentLoop forces a real tool call
// ---------------------------------------------------------------------------

async function runTest1(): Promise<{ pass: boolean; details: string }> {
  console.log("=== TEST 1: runAgentLoop + real tool call ===\n");

  let modelUsed = PRIMARY_MODEL;
  let rounds = 0;
  let toolCallsExecuted = 0;
  let finalContent: string | null = null;
  let stopReason: string = "";
  let spentUsd = 0;

  const { result, modelUsed: mu } = await withModelFallback(async (model) => {
    const budget = createBudget({
      ceilingUsd: 0.25,
      usdPerMTokOut: 30,
      usdPerMTokIn: 5,
    });

    const inner = createOpenRouterClient({ apiKey, baseUrl: BASE_URL, model, jsonMode: false });
    const transport = createMeteredClient(inner, budget);

    if (typeof transport.chat !== "function") {
      throw new Error("createMeteredClient did not propagate .chat from createOpenRouterClient");
    }

    const tools = [
      {
        spec: {
          name: "get_secret_number",
          description: "Returns the secret number for this session. Must be called to learn it.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        async run(_args: Record<string, unknown>): Promise<string> {
          return "the secret number is 4242";
        },
      },
    ];

    const messages = [
      {
        role: "system" as const,
        content: "You are a helpful assistant. Use tools when needed. Never guess the secret number — always call the tool.",
      },
      {
        role: "user" as const,
        content:
          "Call the get_secret_number tool now, then tell me the secret number in a sentence.",
      },
    ];

    const loopResult = await runAgentLoop({
      transport: transport as unknown as ChatTransport,
      messages,
      tools,
      maxRounds: 4,
      budget,
    });

    return { loopResult, budget };
  }, "TEST1");

  modelUsed = mu;
  rounds = result.loopResult.rounds;
  toolCallsExecuted = result.loopResult.toolCallsExecuted;
  finalContent = result.loopResult.finalContent;
  stopReason = result.loopResult.stopReason;
  spentUsd = result.budget.spentUsd();

  console.log(`  Model used:          ${modelUsed}`);
  console.log(`  Rounds:              ${rounds}`);
  console.log(`  Tool calls executed: ${toolCallsExecuted}`);
  console.log(`  Stop reason:         ${stopReason}`);
  console.log(`  Final content:       ${(finalContent ?? "").slice(0, 200)}`);
  console.log(`  Budget spent:        $${spentUsd.toFixed(6)}`);

  // Sanity: anomalously cheap = likely short-circuited
  if (spentUsd < 0.000_01) {
    const details = `FAIL — suspiciously cheap ($${spentUsd.toFixed(8)}): loop likely short-circuited; real model was NOT called`;
    console.log(`  Result: ${details}\n`);
    return { pass: false, details };
  }

  const checks = {
    toolCalled: toolCallsExecuted >= 1,
    finalAnswer: stopReason === "final",
    contains4242: (finalContent ?? "").includes("4242"),
    budgetCharged: spentUsd > 0,
  };

  console.log(`  Checks: toolCalled=${checks.toolCalled}, finalAnswer=${checks.finalAnswer}, contains4242=${checks.contains4242}, budgetCharged=${checks.budgetCharged}`);

  const pass = checks.toolCalled && checks.finalAnswer && checks.contains4242 && checks.budgetCharged;
  const details = pass
    ? `PASS — model(${modelUsed}) called tool, replied with 4242, spent $${spentUsd.toFixed(6)}`
    : `FAIL — checks failed: ${JSON.stringify(checks)}; finalContent="${(finalContent ?? "").slice(0, 100)}"`;

  console.log(`  Result: ${details}\n`);
  return { pass, details };
}

// ---------------------------------------------------------------------------
// TEST 2 — agentReview on SQL-injectable code
// ---------------------------------------------------------------------------

async function runTest2(): Promise<{ pass: boolean; details: string; softOnly?: boolean }> {
  console.log("=== TEST 2: agentReview on SQL-injectable code ===\n");

  const VULNERABLE_CODE = `
// src/users.ts
import { db } from './db';

export async function handler(req: Request) {
  const id = (req as any).query.id;
  // DANGER: string concatenation — SQL injection
  const result = await db.query("SELECT * FROM users WHERE id=" + id);
  return result;
}
`.trim();

  const fakeFiles: DiffFile[] = [
    {
      path: "src/users.ts",
      status: "modified",
      patch: "@@ -0,0 +1,8 @@\n+import { db } from './db';\n+\n+export async function handler(req: Request) {\n+  const id = (req as any).query.id;\n+  const result = await db.query(\"SELECT * FROM users WHERE id=\" + id);\n+  return result;\n+}",
    },
  ];

  const fakeGh: PrToolGitHub = {
    async getFileContents(a) {
      if (a.path === "src/users.ts") return VULNERABLE_CODE;
      return null;
    },
    async getPullRequestFiles(_a) {
      return fakeFiles;
    },
  };

  const context: ContextBundle = {
    diffSummary: "1 file changed: src/users.ts — query builder refactor",
    files: [
      {
        path: "src/users.ts",
        reason: "changed in this PR",
        content: VULNERABLE_CODE,
      },
    ],
    relatedSymbols: [],
    tokenEstimate: 50,
  };

  const candidates: Candidate[] = [
    {
      id: "c1",
      filePath: "src/users.ts",
      source: "sast",
      hint: "String concatenation in SQL query — classic injection pattern",
      cwe: ["CWE-89"],
    },
  ];

  let modelUsed = PRIMARY_MODEL;
  let verdicts: unknown[] = [];
  let stopReason = "";
  let agentRounds = 0;
  let agentToolCalls = 0;
  let spentUsd = 0;
  let threw = false;
  let thrownMessage = "";

  try {
    const { result, modelUsed: mu } = await withModelFallback(async (model) => {
      const budget = createBudget({
        ceilingUsd: 0.25,
        usdPerMTokOut: 30,
        usdPerMTokIn: 5,
      });

      const inner = createOpenRouterClient({ apiKey, baseUrl: BASE_URL, model, jsonMode: false });
      const transport = createMeteredClient(inner, budget);

      const prTools = buildPrAgentTools(fakeGh, {
        owner: "o",
        name: "r",
        pr: 1,
        ref: "head",
      });

      const reviewResult = await agentReview({
        context,
        candidates,
        transport: transport as unknown as ChatTransport,
        tools: prTools,
        maxRounds: 6,
        budget,
      });

      return { reviewResult, budget };
    }, "TEST2");

    modelUsed = mu;
    verdicts = result.reviewResult.verdicts;
    stopReason = result.reviewResult.stopReason;
    agentRounds = result.reviewResult.rounds;
    agentToolCalls = result.reviewResult.toolCallsExecuted;
    spentUsd = result.budget.spentUsd();
  } catch (err) {
    threw = true;
    thrownMessage = (err as Error).message ?? String(err);
  }

  if (threw) {
    const details = `FAIL — agentReview threw: ${thrownMessage}`;
    console.log(`  Result: ${details}\n`);
    return { pass: false, details };
  }

  if (spentUsd < 0.000_01) {
    const details = `FAIL — suspiciously cheap ($${spentUsd.toFixed(8)}): loop likely short-circuited`;
    console.log(`  Result: ${details}\n`);
    return { pass: false, details };
  }

  console.log(`  Model used:          ${modelUsed}`);
  console.log(`  Rounds:              ${agentRounds}`);
  console.log(`  Tool calls executed: ${agentToolCalls}`);
  console.log(`  Stop reason:         ${stopReason}`);
  console.log(`  Verdicts count:      ${verdicts.length}`);
  if (verdicts.length > 0) {
    const v = verdicts[0] as Record<string, unknown>;
    console.log(`  First verdict:       category="${v.category}", isVulnerability=${v.isVulnerability}, confidence=${v.confidence}`);
  }
  console.log(`  Budget spent:        $${spentUsd.toFixed(6)}`);

  // Hard PASS: loop ran without throwing + stopReason is final
  const hardPass = stopReason === "final";

  // Soft: verdicts mention SQL/injection
  const sqlFound = verdicts.some((v) => {
    const cat = String((v as Record<string, unknown>).category ?? "").toLowerCase();
    const cwe = JSON.stringify((v as Record<string, unknown>).cwe ?? "").toLowerCase();
    return cat.includes("sql") || cat.includes("inject") || cwe.includes("89");
  });

  let details: string;
  let softOnly = false;
  if (!hardPass) {
    details = `FAIL — stopReason="${stopReason}" (expected "final"); plumbing broken`;
  } else if (verdicts.length === 0) {
    details = `SOFT PASS — plumbing works (stopReason=final, spent $${spentUsd.toFixed(6)}) but model returned 0 verdicts (model judgment)`;
    softOnly = true;
  } else if (!sqlFound) {
    details = `SOFT PASS — plumbing works, ${verdicts.length} verdict(s) returned but none mention SQL/CWE-89 (model judgment); spent $${spentUsd.toFixed(6)}`;
    softOnly = true;
  } else {
    details = `PASS — plumbing works + ${verdicts.length} verdict(s) with SQL/injection category; spent $${spentUsd.toFixed(6)}`;
  }

  console.log(`  Result: ${details}\n`);
  return { pass: hardPass, details, softOnly };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("========================================================");
  console.log("  E2E Agent + OpenRouter real-model verification");
  console.log(`  Primary model: ${PRIMARY_MODEL}`);
  console.log(`  Fallbacks: ${FALLBACK_MODELS.join(", ")}`);
  console.log("========================================================\n");

  const t1 = await runTest1();
  const t2 = await runTest2();

  const totalTests = 2;
  const passed = [t1, t2].filter((t) => t.pass).length;

  console.log("========================================================");
  console.log("  FINAL REPORT");
  console.log("========================================================");
  console.log(`  TEST 1 (runAgentLoop + tool call): ${t1.pass ? "PASS" : "FAIL"}`);
  console.log(`    ${t1.details}`);
  console.log(`  TEST 2 (agentReview on SQLi code): ${t2.pass ? (t2.softOnly ? "SOFT PASS" : "PASS") : "FAIL"}`);
  console.log(`    ${t2.details}`);
  console.log(`\n  Overall: ${passed}/${totalTests} hard tests passed`);

  if (passed === totalTests) {
    console.log("  VERDICT: ALL PASS — agentic tool-calling foundation is working end-to-end.");
    process.exit(0);
  } else {
    console.log("  VERDICT: FAILURES detected — see details above.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("UNHANDLED ERROR:", err);
  process.exit(2);
});
