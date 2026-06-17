import { test, expect } from "bun:test";
import { buildHarnessModels } from "./models.ts";
import { createBudget } from "../../exploit/budget.ts";
import type { LlmClient } from "../reviewer.ts";

const fakeFactory = (a: { model: string }): LlmClient => ({
  complete: async () => "{}",
  chat: async () => ({ content: `{"model":"${a.model}"}`, toolCalls: [] }),
});

const base = () => ({
  apiKey: "k",
  baseUrl: "u",
  auditorModel: "z-ai/glm-5.2",
  debaterModel: "z-ai/glm-5.2",
  reconModel: "z-ai/glm-5.2",
  budget: createBudget({ ceilingUsd: 2, usdPerMTokOut: 30, usdPerMTokIn: 5 }),
  makeClient: fakeFactory,
});

test("counterpoint distinct when set", () => {
  const s = buildHarnessModels({ ...base(), counterpointModel: "google/gemini-x" });
  expect(s.counterpointDistinct).toBe(true);
  expect(s.modelNames.counterpoint).toBe("google/gemini-x");
});

test("counterpoint falls back to auditor model when empty", () => {
  const s = buildHarnessModels({ ...base(), counterpointModel: "" });
  expect(s.counterpointDistinct).toBe(false);
  expect(s.modelNames.counterpoint).toBe("z-ai/glm-5.2");
});

test("role transports are chat-capable and share one budget", () => {
  const s = buildHarnessModels({ ...base(), counterpointModel: "x/y" });
  expect(typeof s.models.auditor.chat).toBe("function");
  expect(typeof s.models.debater.chat).toBe("function");
  expect(typeof s.models.counterpoint.chat).toBe("function");
  expect(typeof s.models.recon.complete).toBe("function");
  expect(s.budget).toBeDefined();
  expect(s.modelNames.auditor).toBe("z-ai/glm-5.2");
});
