/**
 * Tests for the LLM reviewer: prompt assembly + structured-output parsing.
 *
 * The reviewer is the truth-judging core. We exercise it with a FakeLlmClient
 * so the suite is fully deterministic (no network, no model). Covered:
 *  - buildReviewPrompt encodes the HARD RULES (rationale-before-severity, PR
 *    metadata redaction, strict-JSON shape, no numeric severity, rulesMd).
 *  - review() strips markdown fences, parses, filters is_vulnerability:false,
 *    maps snake_case -> camelCase, and never throws on garbage.
 */
import { test, expect, describe } from "bun:test";
import {
  FakeLlmClient,
  buildReviewPrompt,
  review,
  selfChallenge,
} from "./reviewer.ts";
import type { ContextBundle, Candidate, LlmVerdict } from "./types.ts";

const ctx: ContextBundle = {
  diffSummary: "Added a SQL query built from user input in handlers/login.ts.",
  files: [
    {
      path: "handlers/login.ts",
      content: "const q = `SELECT * FROM users WHERE name='${name}'`;",
      reason: "changed in PR",
    },
  ],
  relatedSymbols: ["db.query", "getUser"],
  tokenEstimate: 1234,
};

const candidates: Candidate[] = [
  {
    id: "c1",
    filePath: "handlers/login.ts",
    startLine: 10,
    endLine: 10,
    ruleId: "js.sql-injection",
    source: "sast",
    hint: "Possible SQL injection from string interpolation",
    snippet: "const q = `SELECT ... '${name}'`;",
    cwe: ["CWE-89"],
  },
];

function cannedVerdict(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: "c1",
    file_path: "handlers/login.ts",
    start_line: 10,
    end_line: 10,
    is_vulnerability: true,
    category: "SQL Injection",
    cwe: ["CWE-89"],
    rationale_md: "User-controlled `name` flows unsanitized into the query.",
    reachable: true,
    confidence: "high",
    cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "N" },
    poc_md: "Send `name=' OR '1'='1`.",
    fix_prompt_md: "Use a parameterized query.",
    title: "SQL injection in login handler",
    ...overrides,
  };
}

describe("buildReviewPrompt", () => {
  test("system prompt encodes the hard rules", () => {
    const { system } = buildReviewPrompt({ context: ctx, candidates });
    const s = system.toLowerCase();
    // (a) persona
    expect(s).toContain("application-security");
    // (b) rationale before severity
    expect(s).toContain("rationale_md");
    expect(s).toMatch(/rationale.*before/);
    // (c) redact / ignore PR metadata
    expect(s).toMatch(/disregard any pr title/);
    // (e) strict JSON shape — the key field names must appear
    expect(system).toContain("is_vulnerability");
    expect(system).toContain("verdicts");
    expect(system).toContain("cvss");
    // (f) never output a numeric severity or score
    expect(s).toMatch(/never output a numeric severity/);
  });

  test("rulesMd is injected when provided", () => {
    const rulesMd = "## Custom rule: never trust X-Forwarded-For";
    const { system } = buildReviewPrompt({ context: ctx, candidates, rulesMd });
    expect(system).toContain("X-Forwarded-For");
  });

  test("user prompt packs context bundle and candidate list", () => {
    const { user } = buildReviewPrompt({ context: ctx, candidates });
    expect(user).toContain("handlers/login.ts");
    expect(user).toContain(ctx.diffSummary);
    // candidate identity must be present so the model can answer per-candidate
    expect(user).toContain("c1");
    expect(user).toContain("Possible SQL injection");
  });
});

describe("review", () => {
  test("parses a clean JSON response and maps to camelCase LlmVerdict", async () => {
    const llm = new FakeLlmClient(() =>
      JSON.stringify({ summary: "one issue", verdicts: [cannedVerdict()] }),
    );
    const out = await review({ context: ctx, candidates, llm });
    expect(out).toHaveLength(1);
    const v = out[0]!;
    expect(v.candidateId).toBe("c1");
    expect(v.filePath).toBe("handlers/login.ts");
    expect(v.startLine).toBe(10);
    expect(v.isVulnerability).toBe(true);
    expect(v.category).toBe("SQL Injection");
    expect(v.cwe).toEqual(["CWE-89"]);
    expect(v.rationaleMd).toContain("flows unsanitized");
    expect(v.reachable).toBe(true);
    expect(v.confidence).toBe("high");
    expect(v.cvss.AV).toBe("N");
    expect(v.pocMd).toContain("OR '1'='1");
    expect(v.fixPromptMd).toContain("parameterized");
    expect(v.title).toContain("SQL injection");
  });

  test("strips ```json fenced code blocks before parsing", async () => {
    const fenced =
      "```json\n" +
      JSON.stringify({ summary: "x", verdicts: [cannedVerdict()] }) +
      "\n```";
    const llm = new FakeLlmClient(() => fenced);
    const out = await review({ context: ctx, candidates, llm });
    expect(out).toHaveLength(1);
    expect(out[0]!.candidateId).toBe("c1");
  });

  test("strips bare ``` fences (no language tag)", async () => {
    const fenced =
      "```\n" +
      JSON.stringify({ summary: "x", verdicts: [cannedVerdict()] }) +
      "\n```";
    const llm = new FakeLlmClient(() => fenced);
    const out = await review({ context: ctx, candidates, llm });
    expect(out).toHaveLength(1);
  });

  test("filters out verdicts where is_vulnerability is false", async () => {
    const llm = new FakeLlmClient(() =>
      JSON.stringify({
        summary: "two candidates, one real",
        verdicts: [
          cannedVerdict(),
          cannedVerdict({
            candidate_id: "c2",
            is_vulnerability: false,
            title: "Not exploitable",
          }),
        ],
      }),
    );
    const out = await review({ context: ctx, candidates, llm });
    expect(out).toHaveLength(1);
    expect(out[0]!.candidateId).toBe("c1");
  });

  test("returns [] on non-JSON garbage (never throws)", async () => {
    const llm = new FakeLlmClient(() => "I'm sorry, I cannot help with that.");
    const out = await review({ context: ctx, candidates, llm });
    expect(out).toEqual([]);
  });

  test("returns [] on JSON that fails schema validation", async () => {
    // missing required rationale_md / cvss
    const llm = new FakeLlmClient(() =>
      JSON.stringify({
        summary: "bad",
        verdicts: [{ file_path: "x.ts", is_vulnerability: true }],
      }),
    );
    const out = await review({ context: ctx, candidates, llm });
    expect(out).toEqual([]);
  });

  test("returns [] on empty verdicts array", async () => {
    const llm = new FakeLlmClient(() =>
      JSON.stringify({ summary: "clean", verdicts: [] }),
    );
    const out = await review({ context: ctx, candidates, llm });
    expect(out).toEqual([]);
  });

  test("FakeLlmClient passes the user prompt to the responder", async () => {
    let seen = "";
    const llm = new FakeLlmClient((user) => {
      seen = user;
      return JSON.stringify({ summary: "", verdicts: [] });
    });
    await review({ context: ctx, candidates, llm });
    expect(seen).toContain("handlers/login.ts");
  });
});

// ---------------------------------------------------------------------------
// selfChallenge — T029 / T033
// ---------------------------------------------------------------------------

/** Build a minimal LlmVerdict for test use. */
function makeVerdict(overrides: Partial<LlmVerdict> = {}): LlmVerdict {
  return {
    filePath: "handlers/login.ts",
    isVulnerability: true,
    category: "SQL Injection",
    cwe: ["CWE-89"],
    rationaleMd: "User input flows into query.",
    reachable: true,
    confidence: "high",
    cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "N" },
    title: "SQL injection in login",
    ...overrides,
  };
}

/** Canned challenge response: NOT refuted. */
function challengeKept(): string {
  return JSON.stringify({ refuted: false, reason: "Exploit path is valid." });
}

/** Canned challenge response: refuted. */
function challengeRefuted(): string {
  return JSON.stringify({ refuted: true, reason: "The sink is in dead code." });
}

describe("selfChallenge", () => {
  test("keeps a high-confidence verdict that is not refuted", async () => {
    const v = makeVerdict({ confidence: "high" });
    const llm = new FakeLlmClient(() => challengeKept());
    const result = await selfChallenge({ verdicts: [v], llm, confidenceFloor: "medium" });
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("SQL injection in login");
  });

  test("drops a verdict whose confidence is below the floor", async () => {
    const v = makeVerdict({ confidence: "low" });
    const llm = new FakeLlmClient(() => challengeKept());
    // floor=medium → low is below floor
    const result = await selfChallenge({ verdicts: [v], llm, confidenceFloor: "medium" });
    expect(result).toHaveLength(0);
  });

  test("drops a verdict that the LLM refutes (even if confidence is high)", async () => {
    const v = makeVerdict({ confidence: "high" });
    const llm = new FakeLlmClient(() => challengeRefuted());
    const result = await selfChallenge({ verdicts: [v], llm, confidenceFloor: "medium" });
    expect(result).toHaveLength(0);
  });

  test("drops a verdict that is both low-confidence AND refuted", async () => {
    const v = makeVerdict({ confidence: "low" });
    const llm = new FakeLlmClient(() => challengeRefuted());
    const result = await selfChallenge({ verdicts: [v], llm, confidenceFloor: "high" });
    expect(result).toHaveLength(0);
  });

  test("keeps verified-confidence verdict at the floor exactly", async () => {
    const v = makeVerdict({ confidence: "verified" });
    const llm = new FakeLlmClient(() => challengeKept());
    // floor=verified → verified meets the floor
    const result = await selfChallenge({ verdicts: [v], llm, confidenceFloor: "verified" });
    expect(result).toHaveLength(1);
  });

  test("mixed batch: keeps passing verdicts, drops refuted and below-floor", async () => {
    const high = makeVerdict({ confidence: "high", title: "kept-high" });
    const low = makeVerdict({ confidence: "low", title: "dropped-low" });
    const refuted = makeVerdict({ confidence: "high", title: "dropped-refuted" });

    const callOrder: string[] = [];
    const llm = new FakeLlmClient((user) => {
      // Identify which verdict is being challenged by title substring in prompt
      if (user.includes("dropped-refuted")) {
        callOrder.push("refuted");
        return challengeRefuted();
      }
      callOrder.push("kept");
      return challengeKept();
    });

    const result = await selfChallenge({
      verdicts: [high, low, refuted],
      llm,
      confidenceFloor: "medium",
    });
    // Only "kept-high" survives: "dropped-low" is below floor, "dropped-refuted" is refuted
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("kept-high");
  });

  test("challenge prompt includes the verdict title and rationale (model can reason about it)", async () => {
    const v = makeVerdict({ title: "MySpecialVuln", rationaleMd: "unique-rationale-xyz" });
    let capturedPrompt = "";
    const llm = new FakeLlmClient((user) => {
      capturedPrompt = user;
      return challengeKept();
    });
    await selfChallenge({ verdicts: [v], llm, confidenceFloor: "low" });
    expect(capturedPrompt).toContain("MySpecialVuln");
    expect(capturedPrompt).toContain("unique-rationale-xyz");
  });

  test("challenge prompt system instruction explicitly says NEVER emit a numeric score", async () => {
    const v = makeVerdict();
    let capturedSystem = "";
    // We need to intercept the system prompt; extend FakeLlmClient usage through
    // a custom implementation of LlmClient interface
    const llm = {
      async complete(args: { system: string; user: string }): Promise<string> {
        capturedSystem = args.system;
        return challengeKept();
      },
    };
    await selfChallenge({ verdicts: [v], llm, confidenceFloor: "low" });
    expect(capturedSystem.toLowerCase()).toMatch(/never.*numeric|numeric.*score|never.*score/);
  });

  test("challenge response with score field is accepted but score field is not propagated to verdict", async () => {
    // The model should NEVER emit a numeric score; if it does, we must NOT
    // propagate it into the returned LlmVerdict (which has no score field).
    const v = makeVerdict({ confidence: "high" });
    // Model incorrectly includes a score — it should be silently ignored
    const llm = new FakeLlmClient(() =>
      JSON.stringify({ refuted: false, score: 3, reason: "valid" }),
    );
    const result = await selfChallenge({ verdicts: [v], llm, confidenceFloor: "low" });
    expect(result).toHaveLength(1);
    // The returned LlmVerdict must NOT have a score property
    expect("score" in result[0]!).toBe(false);
    expect("cvssScore" in result[0]!).toBe(false);
  });

  test("returns empty array when verdicts list is empty", async () => {
    const llm = new FakeLlmClient(() => challengeKept());
    const result = await selfChallenge({ verdicts: [], llm, confidenceFloor: "low" });
    expect(result).toEqual([]);
  });

  test("handles garbage LLM challenge response gracefully (treats as not-refuted)", async () => {
    // If the challenge response is unparseable, we keep the verdict (conservative: don't drop on parse error)
    const v = makeVerdict({ confidence: "high" });
    const llm = new FakeLlmClient(() => "totally not JSON garbage %%##");
    const result = await selfChallenge({ verdicts: [v], llm, confidenceFloor: "low" });
    expect(result).toHaveLength(1);
  });

  test("floor=low passes all confidence levels that are not refuted", async () => {
    const low = makeVerdict({ confidence: "low" });
    const med = makeVerdict({ confidence: "medium" });
    const high = makeVerdict({ confidence: "high" });
    const verified = makeVerdict({ confidence: "verified" });
    const llm = new FakeLlmClient(() => challengeKept());
    const result = await selfChallenge({
      verdicts: [low, med, high, verified],
      llm,
      confidenceFloor: "low",
    });
    expect(result).toHaveLength(4);
  });
});
