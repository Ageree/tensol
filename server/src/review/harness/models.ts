/**
 * 005-whitebox-mdash — per-role multi-model client routing.
 *
 * MDASH is multi-model on purpose ("no single model is best at every stage").
 * Each role gets its own `LlmClient`/`ChatTransport`, all metered against ONE
 * shared per-scan budget so the dollar ceiling bounds the whole scan. Auditor =
 * SOTA (discovery); debater = cheap (high-volume refute); counterpoint = a 2nd
 * independent SOTA (the disagreement signal). recon/triage = cheap, text-only.
 */
import type { LlmClient } from "../reviewer.ts";
import type { ChatTransport } from "../agent/loop.ts";
import type { Budget } from "../../exploit/budget.ts";
import { createOpenRouterClient } from "../llm/openrouter.ts";
import { createMeteredClient } from "../../exploit/metered-client.ts";
import type { HarnessSession } from "./types.ts";

type ClientFactory = (a: {
  apiKey: string;
  baseUrl: string;
  model: string;
  jsonMode?: boolean;
}) => LlmClient;

export function buildHarnessModels(args: {
  apiKey: string;
  baseUrl: string;
  auditorModel: string;
  debaterModel: string;
  counterpointModel: string;
  reconModel: string;
  budget: Budget;
  makeClient?: ClientFactory;
}): HarnessSession {
  const make: ClientFactory = args.makeClient ?? ((a) => createOpenRouterClient(a));
  const metered = (model: string, jsonMode: boolean): LlmClient =>
    createMeteredClient(make({ apiKey: args.apiKey, baseUrl: args.baseUrl, model, jsonMode }), args.budget);

  const counterpointDistinct = args.counterpointModel.trim() !== "";
  const resolvedCounterpoint = counterpointDistinct ? args.counterpointModel : args.auditorModel;
  if (!counterpointDistinct) {
    // Mirrors the existing server.ts agent-fallback warn-on-degrade pattern.
    console.warn(
      "[tensol] TENSOL_HARNESS_MODEL_COUNTERPOINT unset — debate counterpoint falls back to the auditor model; this is NOT a true multi-model ensemble.",
    );
  }

  const auditor = metered(args.auditorModel, false);
  const debater = metered(args.debaterModel, false);
  const counterpoint = metered(resolvedCounterpoint, false);
  const recon = metered(args.reconModel, true);
  const triage = metered(args.reconModel, true);

  const asTransport = (c: LlmClient, role: string): ChatTransport => {
    if (typeof c.chat !== "function") {
      throw new Error(`[tensol] harness ${role} model is not chat-capable`);
    }
    return c as ChatTransport;
  };

  return {
    models: {
      recon,
      triage,
      auditor: asTransport(auditor, "auditor"),
      debater: asTransport(debater, "debater"),
      counterpoint: asTransport(counterpoint, "counterpoint"),
    },
    modelNames: {
      auditor: args.auditorModel,
      debater: args.debaterModel,
      counterpoint: resolvedCounterpoint,
      recon: args.reconModel,
    },
    budget: args.budget,
    counterpointDistinct,
  };
}
