/**
 * P2 — the agentic PR-review pass.
 *
 * `agentReview` is the tool-using counterpart of {@link review}. It reuses the
 * SAME system rules + strict-JSON output contract ({@link buildReviewPrompt})
 * and the SAME output gate ({@link parseReviewVerdicts}) — only the middle
 * changes: instead of one blind `complete()`, the model runs an agent loop and
 * may call tools (read_file / get_pr_diff) to investigate reachability before it
 * answers. Its final message is parsed by the identical schema, so the
 * deterministic scorer downstream is unaffected and the model can never
 * self-declare a finding past the gate.
 *
 * Returns the same `LlmVerdict[]` as `review`, plus loop telemetry for logging.
 * NEVER throws on a bad model answer (the parser collapses junk to `[]`); a
 * transport error still propagates (the caller's retry concern).
 */
import {
  buildReviewPrompt,
  parseReviewVerdicts,
} from "../reviewer.ts";
import {
  runAgentLoop,
  type AgentStopReason,
  type AgentTool,
  type ChatTransport,
  type LoopBudget,
} from "./loop.ts";
import type { Candidate, ContextBundle, LlmVerdict } from "../types.ts";

/**
 * Appended to the fixed review system prompt to teach the model the agentic
 * protocol: investigate with tools, then emit the strict JSON as a plain final
 * message (NOT inside a tool call). The hard rules + output shape are already in
 * the base prompt — this only governs HOW to use the loop.
 */
const AGENT_TOOL_PROTOCOL = `TOOL PROTOCOL — you are running in an agent loop with tools:
- You MAY call \`get_pr_diff\` to see exactly what changed and \`read_file\` to read whole files at the PR head (callers, callees, config, related modules).
- Investigate REACHABILITY with tools before you classify a candidate. Do not guess when a tool can confirm.
- When you have gathered enough evidence, STOP calling tools and return your FINAL answer as the strict JSON object described above — as a plain assistant message, NOT wrapped in a tool call, with no prose or code fences around it.`;

export interface AgentReviewResult {
  verdicts: LlmVerdict[];
  stopReason: AgentStopReason;
  rounds: number;
  toolCallsExecuted: number;
}

export async function agentReview(args: {
  context: ContextBundle;
  candidates: Candidate[];
  /** An `LlmClient.chat`-capable transport. */
  transport: ChatTransport;
  tools: AgentTool[];
  maxRounds: number;
  maxToolCalls?: number;
  budget?: LoopBudget;
  rulesMd?: string;
}): Promise<AgentReviewResult> {
  const { context, candidates, transport, tools, maxRounds, budget, rulesMd } = args;

  const prompt = buildReviewPrompt({
    context,
    candidates,
    ...(rulesMd !== undefined ? { rulesMd } : {}),
  });

  const result = await runAgentLoop({
    transport,
    messages: [
      { role: "system", content: `${prompt.system}\n\n${AGENT_TOOL_PROTOCOL}` },
      { role: "user", content: prompt.user },
    ],
    tools,
    maxRounds,
    ...(args.maxToolCalls !== undefined ? { maxToolCalls: args.maxToolCalls } : {}),
    ...(budget ? { budget } : {}),
  });

  return {
    verdicts: parseReviewVerdicts(result.finalContent),
    stopReason: result.stopReason,
    rounds: result.rounds,
    toolCallsExecuted: result.toolCallsExecuted,
  };
}
