/**
 * Engine orchestrator tests — end-to-end with fakes (no network/process).
 */
import { test, expect, describe } from "bun:test";
import { runReview } from "./engine.ts";
import { FakeLlmClient, FakeChatClient } from "./reviewer.ts";
import { FakeSastRunner } from "./sast/runner.ts";
import { FakeJoernClient } from "./reachability/joern.ts";
import { buildPrAgentTools, type PrToolGitHub } from "./agent/tools/pr-tools.ts";
import type { DiffFile, RawFinding } from "./types.ts";

const sqliFile: DiffFile = {
  path: "src/db.ts",
  status: "modified",
  patch: [
    "@@ -10,3 +10,4 @@ function q(req) {",
    " const id = req.query.id;",
    '+const sql = "SELECT * FROM users WHERE id = " + id;',
    "+return db.exec(sql);",
    " }",
  ].join("\n"),
};

/** Canned LLM completion flagging the changed code as SQLi. */
function sqliResponder(): string {
  return JSON.stringify({
    summary: "Found a SQL injection.",
    verdicts: [
      {
        candidate_id: "diff:src/db.ts:11:0",
        file_path: "src/db.ts",
        start_line: 11,
        end_line: 12,
        is_vulnerability: true,
        category: "SQL Injection",
        cwe: ["CWE-89"],
        rationale_md: "req.query.id flows unparameterized into db.exec.",
        reachable: true,
        confidence: "high",
        cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
        poc_md: "`?id=1 OR 1=1`",
        fix_prompt_md: "Use a parameterized query.",
        title: "SQL injection in db.ts",
      },
    ],
  });
}

describe("runReview engine", () => {
  test("flags a SQLi in changed code, scores it deterministically", async () => {
    const result = await runReview(
      { kind: "pr", files: [sqliFile] },
      { llm: new FakeLlmClient(sqliResponder) },
    );
    expect(result.findings.length).toBe(1);
    const f = result.findings[0]!;
    expect(f.category).toBe("SQL Injection");
    expect(f.severity).toBe("critical"); // CVSS 9.8 -> critical
    expect(f.cvssScore).toBe(9.8);
    expect(f.cvssVector).toBe("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H");
    expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // critical present -> merge readiness 0/5
    expect(result.score0to5).toBe(0);
    expect(result.summaryMd).toContain("0/5");
  });

  test("empty diff -> 5/5, no findings", async () => {
    const result = await runReview(
      { kind: "pr", files: [] },
      { llm: new FakeLlmClient(() => "{}") },
    );
    expect(result.findings.length).toBe(0);
    expect(result.score0to5).toBe(5);
  });

  test("drops verdicts the model marks not-a-vulnerability", async () => {
    const clean = JSON.stringify({
      summary: "looks fine",
      verdicts: [
        {
          file_path: "src/db.ts",
          is_vulnerability: false,
          category: "none",
          cwe: [],
          rationale_md: "parameterized already",
          reachable: false,
          confidence: "high",
          cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "N", I: "N", A: "N" },
          title: "n/a",
        },
      ],
    });
    const result = await runReview(
      { kind: "pr", files: [sqliFile] },
      { llm: new FakeLlmClient(() => clean) },
    );
    expect(result.findings.length).toBe(0);
    expect(result.score0to5).toBe(5);
  });

  test("merges SastRunner findings as candidates", async () => {
    const raw: RawFinding[] = [
      {
        ruleId: "gitleaks.aws-key",
        source: "secrets",
        filePath: "config.ts",
        startLine: 3,
        message: "AWS key committed",
        cwe: ["CWE-798"],
        snippet: "const k = 'AKIA...'",
      },
    ];
    const runner = new FakeSastRunner("gitleaks", raw);
    // LLM confirms the secret candidate.
    const responder = () =>
      JSON.stringify({
        summary: "secret",
        verdicts: [
          {
            candidate_id: raw[0] ? `sast:secrets:config.ts:3:0` : "x",
            file_path: "config.ts",
            start_line: 3,
            is_vulnerability: true,
            category: "Hardcoded Secret",
            cwe: ["CWE-798"],
            rationale_md: "AWS key hardcoded.",
            reachable: true,
            confidence: "verified",
            cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "N", A: "N" },
            title: "Hardcoded AWS key",
          },
        ],
      });
    const result = await runReview(
      { kind: "whitebox", files: [], repoDir: "/tmp/repo" },
      { llm: new FakeLlmClient(responder), sastRunner: runner },
    );
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.category).toBe("Hardcoded Secret");
    expect(result.kind).toBe("whitebox");
  });

  test("garbage LLM output yields no findings (never throws)", async () => {
    const result = await runReview(
      { kind: "pr", files: [sqliFile] },
      { llm: new FakeLlmClient(() => "not json at all") },
    );
    expect(result.findings.length).toBe(0);
    expect(result.score0to5).toBe(5);
  });

  // --- dedupeByFingerprint integration (regression for the fingerprint-
  //     collision true-positive-loss fix). ---

  /** Build a responder returning N verdicts on the same file. */
  function multiVerdict(
    verdicts: Array<{ category: string; cwe: string[]; start_line?: number }>,
  ): () => string {
    return () =>
      JSON.stringify({
        summary: "multi",
        verdicts: verdicts.map((v, i) => ({
          candidate_id: `c${i}`,
          file_path: "src/db.ts",
          ...(v.start_line !== undefined ? { start_line: v.start_line } : {}),
          is_vulnerability: true,
          category: v.category,
          cwe: v.cwe,
          rationale_md: "reachable",
          reachable: true,
          confidence: "high",
          cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
          title: `${v.category} #${i}`,
        })),
      });
  }

  test("collapses identical findings (same class, same/no line) to one", async () => {
    const r = await runReview(
      { kind: "pr", files: [sqliFile] },
      {
        llm: new FakeLlmClient(
          multiVerdict([
            { category: "SQL Injection", cwe: ["CWE-89"] },
            { category: "SQL Injection", cwe: ["CWE-89"] },
          ]),
        ),
      },
    );
    expect(r.findings.length).toBe(1);
  });

  test("keeps two DISTINCT same-class findings at different lines (no false dedup)", async () => {
    const r = await runReview(
      { kind: "pr", files: [sqliFile] },
      {
        llm: new FakeLlmClient(
          multiVerdict([
            { category: "SQL Injection", cwe: ["CWE-89"], start_line: 11 },
            { category: "SQL Injection", cwe: ["CWE-89"], start_line: 42 },
          ]),
        ),
      },
    );
    // Same line-invariant fingerprint, different lines -> both survive.
    expect(r.findings.length).toBe(2);
  });

  test("keeps findings of different classes in the same file", async () => {
    const r = await runReview(
      { kind: "pr", files: [sqliFile] },
      {
        llm: new FakeLlmClient(
          multiVerdict([
            { category: "SQL Injection", cwe: ["CWE-89"], start_line: 11 },
            { category: "Path Traversal", cwe: ["CWE-22"], start_line: 11 },
          ]),
        ),
      },
    );
    expect(r.findings.length).toBe(2);
  });
});

// Deep mode (F1) must thread an injected research budget into the pipeline so a
// deep run is COST-BOUNDED — previously the deep path ran the multi-agent
// pipeline with no budget at all (unbounded spend).
test("deep mode forwards researchBudget into the pipeline (assertWithin consulted)", async () => {
  function deepScript(user: string): string {
    if (/routing units|scoped scenarios/i.test(user)) {
      return JSON.stringify({
        scenarios: [
          { id: "S001", expert: "injection", routing_unit_ids: ["U001"], target_paths: ["src/db.ts"], proof_question: "q?", evidence_required: [] },
        ],
      });
    }
    if (/candidates to triage/i.test(user)) return JSON.stringify({ decisions: [] });
    return JSON.stringify({
      scenario_id: "S001", expert: "injection", status: "rejected",
      summary: "n/a", evidence: [], proof_obligations: [], cwe: [],
      cvss: { AV: "N", AC: "H", PR: "H", UI: "R", S: "U", C: "N", I: "N", A: "N" },
    });
  }
  let asserts = 0;
  const researchBudget = { assertWithin() { asserts += 1; } };
  await runReview(
    { kind: "whitebox", files: [sqliFile], mode: "deep" },
    { llm: new FakeLlmClient(deepScript), researchBudget },
  );
  expect(asserts).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Trust upgrades (T046 / T022 engine part): self-challenge, reachability,
// verification gate, suppressions. The model NEVER sets the score; scoring
// stays deterministic and runs over the VERIFIED set.
// ---------------------------------------------------------------------------

/**
 * A reviewer LlmClient that answers the FIRST pass (review) with the given
 * verdicts JSON, and any subsequent CHALLENGE pass (self-challenge) with a
 * fixed refutation verdict. The challenge prompt is detected by its sentinel
 * "Can you REFUTE this finding?" line.
 */
function reviewThenChallenge(verdictsJson: string, refuted: boolean): FakeLlmClient {
  return new FakeLlmClient((user: string) => {
    if (user.includes("Can you REFUTE this finding?")) {
      return JSON.stringify({ refuted, reason: "challenge pass" });
    }
    return verdictsJson;
  });
}

/** A canned LLM verdict with a tunable confidence + category. */
function verdictJson(args: {
  confidence: "verified" | "high" | "medium" | "low";
  category?: string;
  cwe?: string[];
  startLine?: number;
}): string {
  return JSON.stringify({
    summary: "one finding",
    verdicts: [
      {
        candidate_id: "diff:src/db.ts:11:0",
        file_path: "src/db.ts",
        start_line: args.startLine ?? 11,
        end_line: 12,
        is_vulnerability: true,
        category: args.category ?? "SQL Injection",
        cwe: args.cwe ?? ["CWE-89"],
        rationale_md: "req.query.id flows unparameterized into db.exec.",
        reachable: true,
        confidence: args.confidence,
        cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
        title: "SQL injection in db.ts",
      },
    ],
  });
}

describe("runReview trust upgrades", () => {
  test("every finding carries a verificationStatus when verify runs", async () => {
    const result = await runReview(
      { kind: "pr", files: [sqliFile] },
      { llm: new FakeLlmClient(sqliResponder) },
    );
    expect(result.findings.length).toBe(1);
    // confidence 'high' with no SAST + no reachability → verified by the gate.
    expect(result.findings[0]!.verificationStatus).toBe("verified");
  });

  test("self-challenge drops a refuted finding before scoring (gated by floor)", async () => {
    const result = await runReview(
      { kind: "pr", files: [sqliFile], confidenceFloor: "low" },
      { llm: reviewThenChallenge(verdictJson({ confidence: "high" }), true) },
    );
    expect(result.findings.length).toBe(0);
    expect(result.score0to5).toBe(5);
  });

  test("self-challenge keeps a NON-refuted finding", async () => {
    const result = await runReview(
      { kind: "pr", files: [sqliFile], confidenceFloor: "low" },
      { llm: reviewThenChallenge(verdictJson({ confidence: "high" }), false) },
    );
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.category).toBe("SQL Injection");
  });

  test("confidenceFloor drops below-floor verdicts before scoring", async () => {
    const result = await runReview(
      { kind: "pr", files: [sqliFile], confidenceFloor: "high" },
      // 'low' confidence verdict is below the 'high' floor → dropped in self-challenge.
      { llm: reviewThenChallenge(verdictJson({ confidence: "low" }), false) },
    );
    expect(result.findings.length).toBe(0);
  });

  test("self-challenge does NOT run when no confidenceFloor is given", async () => {
    // A FakeLlm that would REFUTE everything if challenged; absent a floor the
    // engine must not invoke the challenge pass, so the finding survives.
    const llm = new FakeLlmClient((user: string) => {
      if (user.includes("Can you REFUTE this finding?")) {
        return JSON.stringify({ refuted: true });
      }
      return verdictJson({ confidence: "high" });
    });
    const result = await runReview({ kind: "pr", files: [sqliFile] }, { llm });
    expect(result.findings.length).toBe(1);
  });

  test("reachability evidence is attached + drives verified for a medium finding", async () => {
    // A 'medium' finding (not auto-verified by confidence) becomes verified
    // when the reachability adapter proves a taint path. The engine must first
    // score+fingerprint, then key the reachable map by fingerprint.
    const probe = await runReview(
      { kind: "pr", files: [sqliFile], confidenceFloor: "low" },
      { llm: new FakeLlmClient(() => verdictJson({ confidence: "medium" })) },
    );
    const fp = probe.findings[0]!.fingerprint;

    const reachable = new FakeJoernClient({
      [fp]: { reachable: true, evidenceMd: "source→sink taint path" },
    });
    const result = await runReview(
      { kind: "pr", files: [sqliFile], repoDir: "/tmp/repo", confidenceFloor: "low" },
      { llm: new FakeLlmClient(() => verdictJson({ confidence: "medium" })), reachability: reachable },
    );
    const f = result.findings[0]!;
    expect(f.reachabilityEvidenceMd).toBe("source→sink taint path");
    expect(f.verificationStatus).toBe("verified");
  });

  test("a medium finding with no corroboration is UNVERIFIED but still present in the result", async () => {
    const result = await runReview(
      { kind: "pr", files: [sqliFile], confidenceFloor: "low" },
      { llm: new FakeLlmClient(() => verdictJson({ confidence: "medium" })) },
    );
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.verificationStatus).toBe("unverified");
    // unverified is NOT counted toward the verified score → clean merge readiness.
    expect(result.score0to5).toBe(5);
  });

  test("SAST corroboration marks a medium finding verified", async () => {
    const raw: RawFinding[] = [
      {
        ruleId: "opengrep.sqli",
        source: "sast",
        filePath: "src/db.ts",
        startLine: 11,
        message: "tainted SQL",
        cwe: ["CWE-89"],
      },
    ];
    const result = await runReview(
      { kind: "pr", files: [sqliFile], rawFindings: raw, confidenceFloor: "low" },
      { llm: new FakeLlmClient(() => verdictJson({ confidence: "medium" })) },
    );
    expect(result.findings[0]!.verificationStatus).toBe("verified");
    // verified critical → 0/5
    expect(result.score0to5).toBe(0);
  });

  test("score reflects the VERIFIED set only (unverified critical → 5/5)", async () => {
    // A critical-CVSS finding at only 'medium' confidence with no corroboration
    // stays unverified, so it must NOT gate the merge-readiness score.
    const result = await runReview(
      { kind: "pr", files: [sqliFile], confidenceFloor: "low" },
      { llm: new FakeLlmClient(() => verdictJson({ confidence: "medium" })) },
    );
    expect(result.findings[0]!.severity).toBe("critical");
    expect(result.findings[0]!.verificationStatus).toBe("unverified");
    expect(result.score0to5).toBe(5);
  });

  test("suppressed categories are filtered from the findings", async () => {
    const styleVerdict = JSON.stringify({
      summary: "style nit",
      verdicts: [
        {
          candidate_id: "diff:src/db.ts:11:0",
          file_path: "src/db.ts",
          start_line: 11,
          is_vulnerability: true,
          category: "style",
          cwe: [],
          rationale_md: "naming nit",
          reachable: false,
          confidence: "high",
          cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "N", I: "N", A: "N" },
          title: "style nit",
        },
      ],
    });
    const result = await runReview(
      {
        kind: "pr",
        files: [sqliFile],
        suppressedCategories: new Set(["style"]),
      },
      { llm: new FakeLlmClient(() => styleVerdict) },
    );
    expect(result.findings.length).toBe(0);
  });

  test("suppression NEVER drops a security finding even if passed in the set", async () => {
    // Defense-in-depth: the engine must not suppress security/correctness.
    const result = await runReview(
      {
        kind: "pr",
        files: [sqliFile],
        suppressedCategories: new Set(["security", "correctness", "style"]),
      },
      { llm: new FakeLlmClient(() => verdictJson({ confidence: "high", category: "security" })) },
    );
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.category).toBe("security");
  });

  test(".sthrip ignored-paths rules filter findings by path", async () => {
    const vendorFile: DiffFile = {
      path: "vendor/lib.ts",
      status: "modified",
      patch: "@@ -1,1 +1,2 @@\n+const x = eval(input);",
    };
    const responder = () =>
      JSON.stringify({
        summary: "vendor",
        verdicts: [
          {
            candidate_id: "diff:vendor/lib.ts:1:0",
            file_path: "vendor/lib.ts",
            start_line: 1,
            is_vulnerability: true,
            category: "Code Injection",
            cwe: ["CWE-94"],
            rationale_md: "eval of input",
            reachable: true,
            confidence: "high",
            cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
            title: "eval injection",
          },
        ],
      });
    const result = await runReview(
      {
        kind: "pr",
        files: [vendorFile],
        rulesMd: "## ignored-paths\n- vendor/\n",
      },
      { llm: new FakeLlmClient(responder) },
    );
    expect(result.findings.length).toBe(0);
  });

  test("existing callers (no new fields) keep the prior behavior", async () => {
    // The original SQLi test must hold unchanged: still critical, still 0/5.
    const result = await runReview(
      { kind: "pr", files: [sqliFile] },
      { llm: new FakeLlmClient(sqliResponder) },
    );
    expect(result.findings.length).toBe(1);
    expect(result.score0to5).toBe(0);
  });
});

describe("runReview agentic fast path (deps.agent)", () => {
  const fakeGh: PrToolGitHub = {
    async getFileContents() {
      return "function q(req){ const id=req.query.id; return db.exec('SELECT '+id) }";
    },
    async getPullRequestFiles() {
      return [sqliFile];
    },
  };

  test("runs the agent loop then scores its verdict deterministically", async () => {
    let toolUsed = false;
    const gh: PrToolGitHub = {
      async getFileContents(a) {
        toolUsed = true;
        return fakeGh.getFileContents(a);
      },
      getPullRequestFiles: fakeGh.getPullRequestFiles,
    };
    // The model reads the file, then emits the same SQLi verdict JSON.
    const transport = new FakeChatClient((_args, i) =>
      i === 0
        ? {
            content: null,
            toolCalls: [{ id: "t1", name: "read_file", argumentsJson: '{"path":"src/db.ts"}' }],
          }
        : { content: sqliResponder(), toolCalls: [] },
    );

    const result = await runReview(
      { kind: "pr", files: [sqliFile] },
      {
        llm: new FakeLlmClient(() => "{}"), // must NOT be used on the agent path
        agent: {
          transport,
          tools: buildPrAgentTools(gh, { owner: "o", name: "r", pr: 1, ref: "head" }),
          maxRounds: 5,
        },
      },
    );

    expect(toolUsed).toBe(true);
    expect(result.findings.length).toBe(1);
    const f = result.findings[0]!;
    expect(f.category).toBe("SQL Injection");
    expect(f.cvssScore).toBe(9.8); // deterministic scorer still owns the number
    expect(result.score0to5).toBe(0);
  });

  test("a budget-stopped agent loop yields no findings (no self-declared bug)", async () => {
    const budget = {
      assertWithin() {
        throw new Error("over budget");
      },
    };
    const transport = new FakeChatClient(() => ({ content: sqliResponder(), toolCalls: [] }));
    const result = await runReview(
      { kind: "pr", files: [sqliFile] },
      {
        llm: new FakeLlmClient(() => "{}"),
        agent: {
          transport,
          tools: buildPrAgentTools(fakeGh, { owner: "o", name: "r", pr: 1, ref: "head" }),
          maxRounds: 5,
          budget,
        },
      },
    );
    expect(result.findings.length).toBe(0);
    expect(result.score0to5).toBe(5);
  });

  test("deep mode uses deps.harness when present + repoDir, and scores its verdicts", async () => {
    const harness = {
      run: async () => [
        {
          filePath: "a.ts",
          startLine: 1,
          isVulnerability: true,
          category: "SQLi",
          cwe: ["CWE-89"],
          rationaleMd: "tainted\n\n## Multi-model debate\n- survived",
          reachable: true,
          confidence: "high" as const,
          cvss: { AV: "N" as const, AC: "L" as const, PR: "N" as const, UI: "N" as const, S: "U" as const, C: "H" as const, I: "H" as const, A: "H" as const },
          title: "SQLi",
        },
      ],
    };
    const result = await runReview(
      { kind: "whitebox", files: [sqliFile], repoDir: "/repo", mode: "deep" },
      { llm: new FakeLlmClient(() => "{}"), harness },
    );
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.category).toBe("SQLi");
    expect(result.score0to5).toBeLessThan(5); // a high-sev finding lowers the score
  });

  test("deep mode without harness falls back to runResearch (no throw)", async () => {
    const result = await runReview(
      { kind: "whitebox", files: [sqliFile], mode: "deep" },
      { llm: new FakeLlmClient(() => JSON.stringify({ summary: "", verdicts: [] })) },
    );
    expect(result).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);
  });

  test("deep mode with harness but no repoDir falls back to runResearch", async () => {
    let harnessCalled = false;
    const harness = { run: async () => { harnessCalled = true; return []; } };
    const result = await runReview(
      { kind: "whitebox", files: [sqliFile], mode: "deep" }, // no repoDir
      { llm: new FakeLlmClient(() => JSON.stringify({ summary: "", verdicts: [] })), harness },
    );
    expect(harnessCalled).toBe(false); // repoDir absent → harness not used
    expect(result).toBeDefined();
  });
});
