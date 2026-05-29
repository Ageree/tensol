/**
 * Engine orchestrator tests — end-to-end with fakes (no network/process).
 */
import { test, expect, describe } from "bun:test";
import { runReview } from "./engine.ts";
import { FakeLlmClient } from "./reviewer.ts";
import { FakeSastRunner } from "./sast/runner.ts";
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
