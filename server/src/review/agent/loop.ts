/**
 * The agentic orchestrator — a domain-agnostic think→call-tool→observe→repeat
 * loop shared by every tool-using service (PR Review / Whitebox / Blackbox).
 *
 * Given a chat transport (an `LlmClient.chat`), a catalog of {@link AgentTool}s,
 * and an initial message history, it drives the model: each round it asks the
 * model what to do; if the model requests tool calls it executes them, appends
 * their results to the transcript, and loops; when the model returns a plain
 * answer (no tool calls) the loop stops and relays that text.
 *
 * Hard safety properties (all enforced here, not trusted to the model):
 *  - **Never self-declares success.** The loop only relays the model's final
 *    text. Whether that text constitutes a real finding / proof / verdict is
 *    decided DOWNSTREAM (schema parse, response-oracle, scorer) — never here.
 *  - **Never throws on a tool failure.** Unknown tool, non-JSON arguments, or a
 *    throwing tool each become an `ERROR: …` tool-result fed back to the model,
 *    which can then recover or give up. A misbehaving tool can't crash the loop.
 *  - **Bounded.** Three independent caps stop runaway loops: `maxRounds` (model
 *    round-trips), `maxToolCalls` (total tools executed), and an optional
 *    `budget` checked BEFORE each round. Whichever trips first wins.
 *  - **Pure orchestration / immutable transcript.** The caller's `messages`
 *    array is never mutated; the loop threads a fresh array each step. The only
 *    side effects are the injected tools' own effects.
 *
 * Safety-by-construction: the loop has no filesystem, network, or shell access
 * of its own — it can only do what the injected tools allow. In Whitebox those
 * tools wrap scope-gate / url-guard / payload-lint / sandbox / response-oracle
 * per call, so the guardrails apply to every action regardless of what the model
 * decides to do.
 */
import type {
  ChatMessage,
  ChatResult,
  ToolCall,
  ToolChoice,
  ToolSpec,
} from "../llm/chat-types.ts";

/** A tool the loop can execute on the model's behalf. */
export interface AgentTool {
  spec: ToolSpec;
  /**
   * Execute with the model's parsed (validated-as-object) arguments and return a
   * string that is fed back to the model verbatim. May throw — the loop catches
   * it and converts it to an error tool-result (the tool need not be defensive
   * about the loop's contract, but SHOULD validate its own inputs).
   */
  run(args: Record<string, unknown>): Promise<string>;
}

/** The minimal chat transport the loop needs — an `LlmClient.chat`. */
export interface ChatTransport {
  chat(args: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    toolChoice?: ToolChoice;
  }): Promise<ChatResult>;
}

/** Optional spend guard; `assertWithin` throws once the ceiling is reached. */
export interface LoopBudget {
  assertWithin(): void;
}

/** Why the loop stopped. */
export type AgentStopReason = "final" | "max_rounds" | "max_tool_calls" | "budget";

export interface AgentLoopResult {
  /** The model's final answer text, or null if it never produced one. */
  finalContent: string | null;
  /** Number of model round-trips performed. */
  rounds: number;
  /** Number of tool calls actually executed. */
  toolCallsExecuted: number;
  stopReason: AgentStopReason;
  /**
   * The full transcript (initial messages + every assistant/tool turn).
   * OBSERVABILITY ONLY — not a resumable conversation: when `max_tool_calls`
   * trips mid-round, the last assistant turn may carry tool-call requests
   * without all matching `tool` results, which an OpenAI-compatible endpoint
   * would reject if replayed verbatim. Consumers use only `finalContent`.
   */
  messages: ChatMessage[];
}

export interface RunAgentLoopArgs {
  transport: ChatTransport;
  /** Initial history (system + user). Never mutated. */
  messages: ChatMessage[];
  tools: AgentTool[];
  /** Hard cap on model round-trips (must be >= 1). */
  maxRounds: number;
  /** Optional directive on how the model may use tools. */
  toolChoice?: ToolChoice;
  /** Optional spend guard checked before each round. */
  budget?: LoopBudget;
  /**
   * Cap on TOTAL tool calls across the whole loop. Defaults to `maxRounds * 8`
   * — generous, but a backstop against a single turn requesting thousands.
   */
  maxToolCalls?: number;
  /** Optional observability hook, called after each model round. */
  onRound?: (info: { round: number; result: ChatResult }) => void;
}

const ERROR_PREFIX = "ERROR";

/**
 * Execute one tool call, never throwing. Resolution order: unknown tool →
 * non-object/invalid JSON args → the tool's own thrown error. Each failure mode
 * yields a descriptive `ERROR: …` string fed back to the model.
 */
async function executeToolCall(
  toolsByName: Map<string, AgentTool>,
  call: ToolCall,
): Promise<string> {
  const tool = toolsByName.get(call.name);
  if (!tool) {
    const available = [...toolsByName.keys()].join(", ") || "(none)";
    return `${ERROR_PREFIX}: unknown tool "${call.name}". Available tools: ${available}`;
  }

  let parsedArgs: Record<string, unknown>;
  try {
    const raw = call.argumentsJson.trim();
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return `${ERROR_PREFIX}: tool "${call.name}" arguments must be a JSON object, got ${
        Array.isArray(parsed) ? "array" : typeof parsed
      }`;
    }
    parsedArgs = parsed as Record<string, unknown>;
  } catch (err) {
    return `${ERROR_PREFIX}: tool "${call.name}" arguments were not valid JSON — ${
      (err as Error).message
    }`;
  }

  try {
    return await tool.run(parsedArgs);
  } catch (err) {
    return `${ERROR_PREFIX}: tool "${call.name}" failed — ${(err as Error).message}`;
  }
}

/**
 * Drive an agentic tool-calling loop to completion (or a safety cap).
 *
 * @throws only on programmer error (`maxRounds < 1`) or if the transport itself
 *   throws (a transport failure is not the loop's to swallow). Tool failures are
 *   never thrown — see module docs.
 */
export async function runAgentLoop(
  args: RunAgentLoopArgs,
): Promise<AgentLoopResult> {
  const { transport, tools, maxRounds, toolChoice, budget, onRound } = args;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(`runAgentLoop: maxRounds must be an integer >= 1, got ${maxRounds}`);
  }
  const maxToolCalls = args.maxToolCalls ?? maxRounds * 8;

  const toolSpecs = tools.map((t) => t.spec);
  const toolsByName = new Map(tools.map((t) => [t.spec.name, t]));

  // Fresh transcript — the caller's array is never mutated.
  let messages: ChatMessage[] = [...args.messages];
  let rounds = 0;
  let toolCallsExecuted = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    // Spend gate BEFORE incurring the next model round.
    if (budget) {
      try {
        budget.assertWithin();
      } catch {
        return { finalContent: null, rounds, toolCallsExecuted, stopReason: "budget", messages };
      }
    }

    const result = await transport.chat({
      messages,
      tools: toolSpecs,
      // Omit when unset (exactOptionalPropertyTypes): never pass `undefined`.
      ...(toolChoice ? { toolChoice } : {}),
    });
    rounds += 1;
    onRound?.({ round, result });

    // No tool calls ⇒ the model produced its final answer.
    if (result.toolCalls.length === 0) {
      return {
        finalContent: result.content,
        rounds,
        toolCallsExecuted,
        stopReason: "final",
        messages,
      };
    }

    // Record the assistant turn (carrying its tool-call requests).
    messages = [
      ...messages,
      { role: "assistant", content: result.content, toolCalls: result.toolCalls },
    ];

    // Execute each requested tool, appending a tool-result message per call.
    for (const call of result.toolCalls) {
      if (toolCallsExecuted >= maxToolCalls) {
        return {
          finalContent: result.content,
          rounds,
          toolCallsExecuted,
          stopReason: "max_tool_calls",
          messages,
        };
      }
      const toolResult = await executeToolCall(toolsByName, call);
      toolCallsExecuted += 1;
      messages = [
        ...messages,
        { role: "tool", toolCallId: call.id, content: toolResult },
      ];
    }
  }

  // Exhausted maxRounds without a final answer.
  return { finalContent: null, rounds, toolCallsExecuted, stopReason: "max_rounds", messages };
}
