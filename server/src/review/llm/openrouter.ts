/**
 * 003-whitebox — OpenRouter-compatible chat-completions adapter.
 *
 * Implements the `LlmClient` contract by POSTing to an OpenAI-style
 * `/chat/completions` endpoint (OpenRouter, or any compatible gateway). The
 * model is asked to return a JSON object via `response_format: json_object`,
 * and the reviewer's prompt enforces the strict schema on top of that.
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

/** Default sampling temperature — low for stable security verdicts. */
const DEFAULT_TEMPERATURE = 0.1;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
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

/**
 * Create an `LlmClient` backed by an OpenRouter-compatible chat endpoint.
 *
 * @throws on construction never; `complete` throws on non-2xx or a response
 *   with no usable completion content.
 */
export function createOpenRouterClient(args: {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  temperature?: number;
}): LlmClient {
  const { apiKey, model } = args;
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const doFetch = args.fetchImpl ?? fetch;
  const temperature = args.temperature ?? DEFAULT_TEMPERATURE;

  if (!apiKey) throw new Error("openrouter: apiKey is required");
  if (!baseUrl) throw new Error("openrouter: baseUrl is required");
  if (!model) throw new Error("openrouter: model is required");

  return {
    async complete({ system, user }) {
      const url = `${baseUrl}/chat/completions`;
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature,
          response_format: { type: "json_object" },
        }),
      });

      if (!res.ok) {
        const detail = await safeBodyText(res);
        throw new Error(
          `openrouter: chat completion failed with HTTP ${res.status} ${res.statusText} — ${detail}`,
        );
      }

      let data: ChatCompletionResponse;
      try {
        data = (await res.json()) as ChatCompletionResponse;
      } catch (err) {
        throw new Error(
          `openrouter: failed to parse JSON response — ${(err as Error).message}`,
        );
      }

      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error(
          "openrouter: response contained no completion content (empty choices)",
        );
      }
      return content;
    },
  };
}
