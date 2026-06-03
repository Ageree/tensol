/**
 * 003-whitebox — OpenRouter-compatible chat-completions adapter.
 *
 * Implements the `LlmClient` contract by POSTing to an OpenAI-style
 * `/chat/completions` endpoint (OpenRouter, or any compatible gateway):
 *
 *  - `complete()` — the text-only path. The model is asked to return a JSON
 *    object via `response_format: json_object`, and the reviewer's prompt
 *    enforces the strict schema on top of that.
 *  - `chat()` — the agentic (tool-calling) path used by gpt-5.5. Sends a
 *    multi-turn message history plus a `tools` catalog (+ optional `tool_choice`)
 *    and parses `choices[0].message.tool_calls` / `finish_reason` / `usage`.
 *    `response_format` is NEVER sent here — it is mutually exclusive with tools
 *    on OpenAI-compatible gateways, and structured final output is obtained via
 *    a dedicated submit-tool instead.
 *
 * `fetchImpl` is injectable so tests can assert the request shape and stub
 * responses without touching the network. Temperature defaults low (0.1) for
 * near-deterministic security verdicts. Non-2xx responses throw a clear,
 * non-secret-leaking error.
 *
 * Determinism: no clock, no RNG. The only nondeterminism is the remote model,
 * isolated behind `fetchImpl`.
 */
import type { LlmClient } from "../reviewer.ts";
import type {
  ChatMessage,
  ChatUsage,
  ToolCall,
  ToolChoice,
  ToolSpec,
} from "./chat-types.ts";

/** Default sampling temperature — low for stable security verdicts. */
const DEFAULT_TEMPERATURE = 0.1;

/**
 * Default per-request timeout (ms). Bun's global `fetch` has no response
 * timeout, so a stalled/half-open upstream would hang the synchronous
 * `POST /v1/review` handler forever and pin async jobs in `running`. Aborting
 * turns the stall into a thrown error so the runner-retry + sync-500 paths
 * engage.
 */
const DEFAULT_TIMEOUT_MS = 90_000;

/** Wire shape of a single tool call in an assistant message. */
interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  content?: string | null;
  tool_calls?: WireToolCall[];
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: WireMessage; finish_reason?: string }>;
  usage?: WireUsage;
}

/**
 * Trim a single trailing slash so `${baseUrl}/chat/completions` never doubles.
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Read the response body as text defensively (never throws) for error context.
 */
async function safeBodyText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    // Cap to avoid dumping huge bodies into an Error message.
    return t.length > 500 ? `${t.slice(0, 500)}…` : t;
  } catch {
    return "<unreadable body>";
  }
}

/** Map our internal {@link ChatMessage} union to the OpenAI wire shape. */
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.argumentsJson },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

/** Map our {@link ToolSpec}s to the OpenAI `tools` wire shape. */
function toWireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Map our {@link ToolChoice} to the OpenAI `tool_choice` wire shape. */
function toWireToolChoice(tc: ToolChoice): unknown {
  return typeof tc === "string"
    ? tc
    : { type: "function", function: { name: tc.name } };
}

/** Parse the assistant message's `tool_calls`, skipping malformed entries. */
function parseToolCalls(raw: WireToolCall[] | undefined): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tc): tc is WireToolCall & { function: { name: string } } =>
      Boolean(tc.function?.name),
    )
    .map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function.name,
      // The model can emit invalid JSON here — callers parse defensively.
      argumentsJson: tc.function.arguments ?? "{}",
    }));
}

/**
 * Create an `LlmClient` backed by an OpenRouter-compatible chat endpoint.
 *
 * @throws on construction never; `complete`/`chat` throw on non-2xx or a
 *   response with no usable content.
 */
export function createOpenRouterClient(args: {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  temperature?: number;
  /** Per-request response timeout in ms (default 90s). */
  timeoutMs?: number;
  /**
   * Request a strict JSON object from the model (default `true`). Set `false`
   * for free-form completions (e.g. PoC code generation) where the
   * `response_format: json_object` constraint would corrupt non-JSON output.
   * Only affects `complete()`; `chat()` never sends `response_format`.
   */
  jsonMode?: boolean;
}): LlmClient {
  const { apiKey, model } = args;
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const doFetch = args.fetchImpl ?? fetch;
  const temperature = args.temperature ?? DEFAULT_TEMPERATURE;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jsonMode = args.jsonMode ?? true;

  if (!apiKey) throw new Error("openrouter: apiKey is required");
  if (!baseUrl) throw new Error("openrouter: baseUrl is required");
  if (!model) throw new Error("openrouter: model is required");

  const url = `${baseUrl}/chat/completions`;

  /**
   * POST one chat-completions request and return the parsed JSON body. Owns the
   * AbortController timeout (not bare `AbortSignal.timeout`) so a timeout abort
   * is distinguishable from any other abort and surfaces a clear message.
   * Shared by `complete` and `chat`.
   */
  async function postCompletion(
    body: Record<string, unknown>,
  ): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) {
        throw new Error(
          `openrouter: chat completion timed out after ${timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await safeBodyText(res);
      throw new Error(
        `openrouter: chat completion failed with HTTP ${res.status} ${res.statusText} — ${detail}`,
      );
    }

    try {
      return (await res.json()) as ChatCompletionResponse;
    } catch (err) {
      throw new Error(
        `openrouter: failed to parse JSON response — ${(err as Error).message}`,
      );
    }
  }

  return {
    async complete({ system, user }) {
      const data = await postCompletion({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature,
        // Omit `response_format` entirely in free-form mode; JSON.stringify
        // drops keys with `undefined` values so the field never appears.
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      });

      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error(
          "openrouter: response contained no completion content (empty choices)",
        );
      }
      return content;
    },

    async chat({ messages, tools, toolChoice }) {
      const data = await postCompletion({
        model,
        messages: toWireMessages(messages),
        temperature,
        ...(tools && tools.length > 0 ? { tools: toWireTools(tools) } : {}),
        ...(toolChoice ? { tool_choice: toWireToolChoice(toolChoice) } : {}),
      });

      const message = data.choices?.[0]?.message;
      const toolCalls = parseToolCalls(message?.tool_calls);
      const content =
        typeof message?.content === "string" ? message.content : null;

      // A turn with no content AND no tool calls is a malformed/empty response.
      // (Empty content WITH tool calls is valid — the model wants tools.)
      if (content === null && toolCalls.length === 0) {
        throw new Error(
          "openrouter: chat response had neither content nor tool_calls",
        );
      }

      const usage: ChatUsage | undefined = data.usage
        ? {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
          }
        : undefined;

      // Under `exactOptionalPropertyTypes`, omit `usage` entirely when absent
      // rather than setting it to `undefined`.
      return { content, toolCalls, ...(usage ? { usage } : {}) };
    },
  };
}
