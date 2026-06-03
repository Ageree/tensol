/**
 * Tests for {@link runAgentLoop} — the domain-agnostic agentic orchestrator.
 *
 * The loop is the heart of the gpt-5.5 tool-using capability shared across PR
 * Review / Whitebox / Blackbox. These tests pin its guarantees:
 *   - it runs tools the model requests and feeds results back, until a final
 *     answer or a hard cap;
 *   - it NEVER throws on a tool failure (unknown tool, bad JSON args, a throwing
 *     tool) — every failure is returned to the model as an error tool-result;
 *   - it NEVER self-declares success — it only relays the model's final text;
 *   - every safety cap (maxRounds, maxToolCalls, budget) stops the loop
 *     deterministically;
 *   - it never mutates the caller's initial message array (immutability).
 */
import { expect, test } from "bun:test";
import { runAgentLoop, type AgentTool } from "./loop.ts";
import { FakeChatClient } from "../reviewer.ts";
import type { ChatMessage, ChatResult, ToolCall } from "../llm/chat-types.ts";

/** Build a tool-call object tersely. */
const tc = (id: string, name: string, argsJson: string): ToolCall => ({
  id,
  name,
  argumentsJson: argsJson,
});

/** A ChatResult that asks for tool calls. */
const wantTools = (calls: ToolCall[], content: string | null = null): ChatResult => ({
  content,
  toolCalls: calls,
});

/** A ChatResult that is a final answer. */
const answer = (content: string): ChatResult => ({ content, toolCalls: [] });

/** A trivially-passing tool that echoes its args. */
const echoTool: AgentTool = {
  spec: {
    name: "echo",
    description: "Echo the input",
    parameters: { type: "object", properties: { text: { type: "string" } } },
  },
  async run(args) {
    return `echoed:${JSON.stringify(args)}`;
  },
};

test("returns the model's answer immediately when no tools are requested", async () => {
  const transport = new FakeChatClient(() => answer("final verdict"));
  const res = await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "review" }],
    tools: [echoTool],
    maxRounds: 5,
  });
  expect(res.stopReason).toBe("final");
  expect(res.finalContent).toBe("final verdict");
  expect(res.rounds).toBe(1);
  expect(res.toolCallsExecuted).toBe(0);
});

test("runs a requested tool, feeds the result back, then returns the answer", async () => {
  let sawToolResult: string | undefined;
  const transport = new FakeChatClient((args, i) => {
    if (i === 0) return wantTools([tc("c1", "echo", '{"text":"hi"}')]);
    // Second round: the tool result must be present in the history fed back.
    const toolMsg = args.messages.find((m) => m.role === "tool");
    sawToolResult = toolMsg && "content" in toolMsg ? toolMsg.content : undefined;
    return answer("done after tool");
  });

  const res = await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "review" }],
    tools: [echoTool],
    maxRounds: 5,
  });

  expect(res.stopReason).toBe("final");
  expect(res.finalContent).toBe("done after tool");
  expect(res.rounds).toBe(2);
  expect(res.toolCallsExecuted).toBe(1);
  expect(sawToolResult).toBe('echoed:{"text":"hi"}');
  // Transcript carries the assistant tool-call turn then the tool result.
  const assistant = res.messages.find((m) => m.role === "assistant");
  expect(assistant && "toolCalls" in assistant ? assistant.toolCalls?.length : 0).toBe(1);
});

test("an unknown tool yields an error tool-result and the loop continues (never throws)", async () => {
  let errFedBack: string | undefined;
  const transport = new FakeChatClient((args, i) => {
    if (i === 0) return wantTools([tc("c1", "does_not_exist", "{}")]);
    const toolMsg = args.messages.find((m) => m.role === "tool");
    errFedBack = toolMsg && "content" in toolMsg ? toolMsg.content : undefined;
    return answer("recovered");
  });

  const res = await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "go" }],
    tools: [echoTool],
    maxRounds: 5,
  });

  expect(res.stopReason).toBe("final");
  expect(res.finalContent).toBe("recovered");
  expect(errFedBack).toMatch(/unknown tool/i);
});

test("a throwing tool is captured as an error tool-result, not propagated", async () => {
  const boomTool: AgentTool = {
    spec: { name: "boom", description: "throws", parameters: { type: "object" } },
    async run() {
      throw new Error("kaboom");
    },
  };
  let errFedBack: string | undefined;
  const transport = new FakeChatClient((args, i) => {
    if (i === 0) return wantTools([tc("c1", "boom", "{}")]);
    const toolMsg = args.messages.find((m) => m.role === "tool");
    errFedBack = toolMsg && "content" in toolMsg ? toolMsg.content : undefined;
    return answer("after boom");
  });

  const res = await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "go" }],
    tools: [boomTool],
    maxRounds: 5,
  });
  expect(res.finalContent).toBe("after boom");
  expect(errFedBack).toMatch(/kaboom/);
});

test("invalid JSON arguments yield an error tool-result (defensive parsing)", async () => {
  let errFedBack: string | undefined;
  const transport = new FakeChatClient((args, i) => {
    if (i === 0) return wantTools([tc("c1", "echo", "{not json")]);
    const toolMsg = args.messages.find((m) => m.role === "tool");
    errFedBack = toolMsg && "content" in toolMsg ? toolMsg.content : undefined;
    return answer("ok");
  });

  const res = await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "go" }],
    tools: [echoTool],
    maxRounds: 5,
  });
  expect(res.finalContent).toBe("ok");
  expect(errFedBack).toMatch(/not valid JSON/i);
});

test("empty-string arguments are treated as an empty object", async () => {
  let argsSeen: unknown;
  const captureTool: AgentTool = {
    spec: { name: "cap", description: "capture", parameters: { type: "object" } },
    async run(a) {
      argsSeen = a;
      return "ok";
    },
  };
  const transport = new FakeChatClient((_args, i) =>
    i === 0 ? wantTools([tc("c1", "cap", "")]) : answer("done"),
  );
  await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "go" }],
    tools: [captureTool],
    maxRounds: 5,
  });
  expect(argsSeen).toEqual({});
});

test("stops at maxRounds when the model never stops calling tools", async () => {
  // Always asks for a tool — never answers.
  const transport = new FakeChatClient(() => wantTools([tc("c1", "echo", "{}")]));
  const res = await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "go" }],
    tools: [echoTool],
    maxRounds: 3,
  });
  expect(res.stopReason).toBe("max_rounds");
  expect(res.finalContent).toBeNull();
  expect(res.rounds).toBe(3);
});

test("stops at maxToolCalls when one turn requests too many tools", async () => {
  // First turn requests 5 tool calls; cap is 3.
  const transport = new FakeChatClient((_a, i) =>
    i === 0
      ? wantTools([
          tc("a", "echo", "{}"),
          tc("b", "echo", "{}"),
          tc("c", "echo", "{}"),
          tc("d", "echo", "{}"),
          tc("e", "echo", "{}"),
        ])
      : answer("done"),
  );
  const res = await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "go" }],
    tools: [echoTool],
    maxRounds: 5,
    maxToolCalls: 3,
  });
  expect(res.stopReason).toBe("max_tool_calls");
  expect(res.toolCallsExecuted).toBe(3);
});

test("stops with stopReason 'budget' when the budget trips before a round", async () => {
  let calls = 0;
  const budget = {
    assertWithin() {
      // Allow the first round, then trip.
      if (calls >= 1) throw new Error("budget exceeded");
    },
  };
  const transport = new FakeChatClient(() => {
    calls += 1;
    return wantTools([tc("c1", "echo", "{}")]);
  });
  const res = await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "go" }],
    tools: [echoTool],
    maxRounds: 10,
    budget,
  });
  expect(res.stopReason).toBe("budget");
  expect(res.rounds).toBe(1);
});

test("executes multiple tool calls from one turn in order", async () => {
  const order: string[] = [];
  const orderTool: AgentTool = {
    spec: { name: "ord", description: "record order", parameters: { type: "object" } },
    async run(a) {
      order.push(String((a as { n: number }).n));
      return "ok";
    },
  };
  const transport = new FakeChatClient((_a, i) =>
    i === 0
      ? wantTools([tc("a", "ord", '{"n":1}'), tc("b", "ord", '{"n":2}')])
      : answer("done"),
  );
  const res = await runAgentLoop({
    transport,
    messages: [{ role: "user", content: "go" }],
    tools: [orderTool],
    maxRounds: 5,
  });
  expect(order).toEqual(["1", "2"]);
  expect(res.toolCallsExecuted).toBe(2);
});

test("never mutates the caller's initial messages array", async () => {
  const initial: ChatMessage[] = [{ role: "user", content: "go" }];
  const transport = new FakeChatClient((_a, i) =>
    i === 0 ? wantTools([tc("c1", "echo", "{}")]) : answer("done"),
  );
  await runAgentLoop({ transport, messages: initial, tools: [echoTool], maxRounds: 5 });
  expect(initial).toEqual([{ role: "user", content: "go" }]);
  expect(initial.length).toBe(1);
});

test("rejects a maxRounds below 1", async () => {
  const transport = new FakeChatClient(() => answer("x"));
  await expect(
    runAgentLoop({ transport, messages: [], tools: [], maxRounds: 0 }),
  ).rejects.toThrow(/maxRounds/i);
});
