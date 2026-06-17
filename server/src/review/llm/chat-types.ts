/**
 * Tool-calling chat types — the shared vocabulary for the agentic (function-
 * calling) path that powers PR Review / Whitebox / Blackbox.
 *
 * These model the OpenAI/OpenRouter function-calling wire shape in our own terms
 * so the rest of the codebase never depends on a provider's exact JSON. The
 * existing text-only `LlmClient.complete()` seam is untouched; this is the
 * ADDITIVE surface a tool-using model needs (multi-turn history, a tools
 * catalog, parsed tool calls, and exact token usage for real budgeting).
 *
 * Pure data — no behavior, no I/O. Kept in its own tiny module so both the
 * transport (`openrouter.ts`), the meter (`metered-client.ts`), and the agent
 * loop can share one definition without import cycles.
 */

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A single tool invocation the model emitted in one assistant turn. */
export interface ToolCall {
  /** Provider-assigned id; echoed back on the matching `tool` message. */
  id: string;
  name: string;
  /** Raw JSON arguments string — parse DEFENSIVELY (the model can emit junk). */
  argumentsJson: string;
}

/** One message in a tool-calling conversation (a discriminated union by role). */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** Exact token usage for one round-trip (from the provider when it reports it). */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The result of ONE chat round-trip. An empty `toolCalls` array means the model
 * produced its FINAL answer (in `content`); a non-empty array means it wants the
 * caller to run those tools and feed the results back.
 */
export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: ChatUsage;
}

/** How the model is allowed to use tools this turn. */
export type ToolChoice = "auto" | "none" | { name: string };
