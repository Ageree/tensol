/**
 * QA PROBE — PR-review pipeline END-TO-END (in-process, real modules).
 *
 * This file is a disposable QA harness. It exercises the REAL engine modules
 * (candidates / repomap / reviewer / score / fingerprint / engine / poster /
 * pr-review handler / service) with fakes ONLY at the LLM + GitHub boundary,
 * and at the DB boundary (in-memory SQLite + real migrations).
 *
 * Goal: find logic/integration bugs the isolated unit tests miss. Each block
 * prints PASTED evidence (console.error → captured in test output) so a human
 * can see expected-vs-actual without re-running.
 *
 * DO NOT ship — `__probe_` prefix keeps it out of normal globs/CI intent.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDb, type DB } from "../db/client.ts";
import { createReviewService } from "./service.ts";
import { runReview } from "./engine.ts";
import {
  deriveCandidates,
  parseAddedHunks,
  splitUnifiedDiff,
} from "./candidates.ts";
import {
  cvssBaseScore,
  overallScore0to5,
  severityFromScore,
} from "./score.ts";
import { fingerprint } from "./fingerprint.ts";
import { postReviewResult, findingToComment } from "./poster.ts";
import { FakeGitHubClient } from "./github/client.ts";
import { FakeLlmClient } from "./reviewer.ts";
import { createPrReviewHandler } from "../jobs/handlers/pr-review.ts";
import type {
  DiffFile,
  ReviewFinding,
  ReviewResult,
  CvssVector,
} from "./types.ts";

// ─── in-mem DB plumbing (copied from review.test.ts / pr-review.test.ts) ─────
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "probe-key-pr-e2e-0123456789abcdef0123456789abcdef0123456789";

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

let clockNow = 1_900_000_000_000;
const clock = () => clockNow++;

function seedUser(db: DB, id: string): void {
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run(id, `${id}@probe.io`, clockNow);
}

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  seedUser(db, "u");
  return db;
}

function makeSvc(db: DB) {
  return createReviewService({ db, auditKey: KEY, now: clock });
}

const P = (label: string, v: unknown) =>
  console.error(`  [evidence] ${label}:`, JSON.stringify(v));

// ════════════════════════════════════════════════════════════════════════════
// PROBE 1 — multi-file unified diff → candidates at the RIGHT files/lines,
//           and added code lines beginning with +/-/++/-- survive parsing.
// ════════════════════════════════════════════════════════════════════════════
describe("PROBE 1 — multi-file diff parsing + candidate derivation", () => {
  // A realistic two-file git diff. File A has two separate added hunks; file B
  // one. We embed the exact tricky lines the task calls out:
  //   "+  a++; b--;"                 (added code that itself starts +/-/++/--)
  //   "+const x = entries.filter(..."(added JS)
  const rawDiff = [
    "diff --git a/src/math.ts b/src/math.ts",
    "index 1111111..2222222 100644",
    "--- a/src/math.ts",
    "+++ b/src/math.ts",
    "@@ -5,2 +5,5 @@ export function step() {",
    " let a = 0;",
    " let b = 10;",
    "+  a++; b--;",
    "+  ++a; --b;",
    "+  const x = entries.filter((e) => e.ok);",
    "@@ -40,1 +43,2 @@ function tail() {",
    " return 1;",
    "+  return danger(userInput);",
    "diff --git a/src/io.ts b/src/io.ts",
    "index 3333333..4444444 100644",
    "--- a/src/io.ts",
    "+++ b/src/io.ts",
    "@@ -1,1 +1,2 @@",
    " import fs from 'fs';",
    "+fs.readFileSync(req.query.path);",
  ].join("\n");

  test("splitUnifiedDiff → 2 files; parseAddedHunks keeps tricky added lines", () => {
    const files = splitUnifiedDiff(rawDiff);
    P("split file paths", files.map((f) => `${f.path}:${f.status}`));
    expect(files.length).toBe(2);
    const math = files.find((f) => f.path === "src/math.ts")!;
    const io = files.find((f) => f.path === "src/io.ts")!;
    expect(math).toBeDefined();
    expect(io).toBeDefined();

    const mathHunks = parseAddedHunks(math.patch);
    P("math.ts hunks", mathHunks);
    // Two hunks. Hunk header is "@@ -5,2 +5,5 @@" then 2 CONTEXT lines, so the
    // first ADDED line is at new-file line 7 (cursor advanced by the 2 context
    // lines). This is the correct unified-diff cursor math: newStart == 7.
    expect(mathHunks.length).toBe(2);

    const firstHunk = mathHunks[0]!;
    expect(firstHunk.newStart).toBe(7);
    // Second hunk: "@@ -40,1 +43,2 @@" then 1 context line → added at line 44.
    expect(mathHunks[1]!.newStart).toBe(44);
    // The "+  a++; b--;" added line MUST survive (content after the leading +).
    expect(firstHunk.snippet).toContain("a++; b--;");
    // "+  ++a; --b;" — added content begins with "++"/"--" but NOT "+++"/"---".
    expect(firstHunk.snippet).toContain("++a; --b;");
    // "+const x = entries.filter(...)" survives.
    expect(firstHunk.snippet).toContain("const x = entries.filter");

    const ioHunks = parseAddedHunks(io.patch);
    P("io.ts hunks", ioHunks);
    expect(ioHunks.length).toBe(1);
    expect(ioHunks[0]!.snippet).toContain("fs.readFileSync(req.query.path)");
  });

  // ── CONFIRMED FINDING (low severity, true-negative edge): an added code
  //    line whose CONTENT begins with "+++" is silently dropped. ───────────
  //
  // Real `git diff` of a file that introduces a line literally `+++ x` emits
  // the hunk-body line "++++ x" (1 diff-prefix '+' + the literal '+++ x').
  // `parseAddedHunks` guards `!line.startsWith("+++")` (candidates.ts:57) to
  // skip the `+++ b/path` FILE header — but `splitUnifiedDiff` already strips
  // file headers before the patch reaches here (verified: patch starts at
  // "@@"), so inside a hunk body a "++++" line can ONLY be added code. The
  // over-broad guard therefore drops the added line from the snippet AND
  // fragments the added-run. (An added line beginning with "---" — raw
  // "+---x" — is correctly KEPT, because the '-' guard only fires on lines
  // that START with '-'.)
  test("CONFIRMED: added code line starting with '+++' is dropped (real git output)", () => {
    // EXACTLY what `git diff` emits — verified via a scratch repo.
    const patch = [
      "@@ -1 +1,3 @@",
      " line1",
      "++++ not a header, real added code", // git output for added "+++ ..." line
      "+---also real added code",           // git output for added "---..." line
    ].join("\n");
    const hunks = parseAddedHunks(patch);
    P("hunks for real-git +++/--- added lines", hunks);
    const snippets = hunks.map((h) => h.snippet).join("\n");
    // BUG: the "+++ not a header, real added code" line is LOST.
    const plusPlusPlusKept = snippets.includes("+++ not a header");
    P("'+++ ...' added line preserved?", plusPlusPlusKept);
    expect(plusPlusPlusKept).toBe(false); // documents the defect
    // Correct behavior (after a fix) would be: plusPlusPlusKept === true.
    // The "---..." added line IS correctly kept (only '-'-leading lines guard).
    expect(snippets).toContain("---also real added code");
  });

  test("CONFIRMED: full pipeline (splitUnifiedDiff→parseAddedHunks) also drops the '+++' line", () => {
    const diff = [
      "diff --git a/f.md b/f.md",
      "index a29bdeb..754a80e 100644",
      "--- a/f.md",
      "+++ b/f.md",
      "@@ -1 +1,2 @@",
      " line1",
      "++++ real added markdown showing a diff header", // added "+++ ..." code
    ].join("\n");
    const files = splitUnifiedDiff(diff);
    // File headers are stripped — patch starts at @@, so the only "++++" left
    // is genuine added code, never a header. The guard mis-fires anyway.
    P("patch body starts with @@", files[0]?.patch?.startsWith("@@"));
    expect(files[0]?.patch?.startsWith("@@")).toBe(true);
    const candidates = deriveCandidates({ files });
    P("candidates for f.md", candidates.map((c) => `${c.id} snip=${JSON.stringify(c.snippet)}`));
    // The added line is dropped → ZERO diff candidates for this file.
    expect(candidates.length).toBe(0);
  });

  test("engine produces candidates for the RIGHT files/lines", async () => {
    const files = splitUnifiedDiff(rawDiff);
    const candidates = deriveCandidates({ files });
    P(
      "candidate ids",
      candidates.map((c) => `${c.id} @ ${c.filePath}:${c.startLine}-${c.endLine}`),
    );
    // math.ts: 2 hunks → 2 diff candidates; io.ts: 1 hunk → 1 candidate.
    const mathCands = candidates.filter((c) => c.filePath === "src/math.ts");
    const ioCands = candidates.filter((c) => c.filePath === "src/io.ts");
    expect(mathCands.length).toBe(2);
    expect(ioCands.length).toBe(1);
    // The first math candidate anchors at new-file line 7 (2 context lines
    // after the "+5" hunk start). Cursor math verified.
    expect(mathCands[0]!.startLine).toBe(7);
    // io candidate anchors at line 2 (the added readFileSync line, after 1
    // context import line at line 1).
    expect(ioCands[0]!.startLine).toBe(2);
    expect(ioCands[0]!.snippet).toContain("fs.readFileSync(req.query.path)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PROBE 2 — Scoring integrity: deterministic severity + 0-5 worst-gating;
//           model-supplied score field is IGNORED.
// ════════════════════════════════════════════════════════════════════════════
describe("PROBE 2 — deterministic scoring integrity", () => {
  const critVector: CvssVector = {
    AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H",
  };

  test("9.8 vector → critical → overall 0/5", () => {
    const score = cvssBaseScore(critVector);
    const sev = severityFromScore(score);
    P("crit vector base score", score);
    P("crit severity", sev);
    expect(score).toBe(9.8);
    expect(sev).toBe("critical");
    const overall = overallScore0to5([
      { severity: "critical", confidence: "high", reachable: true },
    ]);
    P("overall (one critical counted)", overall);
    expect(overall).toBe(0);
  });

  test("only LOW/none → 5/5 or 4/5 per gating thresholds", () => {
    // A genuinely low finding (AV:N but only Low confidentiality, no I/A).
    const lowVector: CvssVector = {
      AV: "N", AC: "H", PR: "H", UI: "R", S: "U", C: "L", I: "N", A: "N",
    };
    const lowScore = cvssBaseScore(lowVector);
    const lowSev = severityFromScore(lowScore);
    P("low vector base score", lowScore);
    P("low severity", lowSev);
    expect(lowSev).toBe("low");
    // worst-gating: any low → 4
    expect(overallScore0to5([{ severity: lowSev, confidence: "high", reachable: true }])).toBe(4);
    // informational only → 5
    const infoVector: CvssVector = {
      AV: "P", AC: "H", PR: "H", UI: "R", S: "U", C: "N", I: "N", A: "N",
    };
    expect(cvssBaseScore(infoVector)).toBe(0);
    expect(severityFromScore(0)).toBe("informational");
    expect(overallScore0to5([{ severity: "informational", confidence: "high", reachable: true }])).toBe(5);
    // empty → 5
    expect(overallScore0to5([])).toBe(5);
  });

  test("gating thresholds: high→2, medium→3", () => {
    expect(overallScore0to5([{ severity: "high", confidence: "high", reachable: true }])).toBe(2);
    expect(overallScore0to5([{ severity: "medium", confidence: "high", reachable: true }])).toBe(3);
    // worst-severity wins: medium + critical present → 0
    expect(
      overallScore0to5([
        { severity: "medium", confidence: "high", reachable: true },
        { severity: "critical", confidence: "high", reachable: true },
      ]),
    ).toBe(0);
  });

  test("a model-supplied 'score'/'severity' field is IGNORED by the engine", async () => {
    // The LLM emits a 9.8-vector AND tries to reward-hack by adding score: 5,
    // severity: "informational". The deterministic scorer must override.
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
    const rewardHackResponder = () =>
      JSON.stringify({
        summary: "trying to lie about severity",
        verdicts: [
          {
            candidate_id: "diff:src/db.ts:11:0",
            file_path: "src/db.ts",
            start_line: 11,
            is_vulnerability: true,
            category: "SQL Injection",
            cwe: ["CWE-89"],
            rationale_md: "tainted id into db.exec",
            reachable: true,
            confidence: "high",
            // 9.8 vector ↓
            cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
            title: "SQLi",
            // ── injected reward-hacking fields the model is NOT allowed to set ──
            score: 5,
            severity: "informational",
            cvss_score: 0.1,
            score0to5: 5,
          },
        ],
      });
    const r = await runReview(
      { kind: "pr", files: [sqliFile] },
      { llm: new FakeLlmClient(rewardHackResponder) },
    );
    P("reward-hack result severity/score", {
      severity: r.findings[0]?.severity,
      cvssScore: r.findings[0]?.cvssScore,
      overall: r.score0to5,
    });
    expect(r.findings.length).toBe(1);
    // Model's lie (severity informational / score 5) must be ignored.
    expect(r.findings[0]!.severity).toBe("critical");
    expect(r.findings[0]!.cvssScore).toBe(9.8);
    expect(r.score0to5).toBe(0);
    // The ReviewFinding type has no `score`/`score0to5` field; verify none leaked.
    const leaked = r.findings[0] as unknown as Record<string, unknown>;
    expect(leaked.score).toBeUndefined();
    expect(leaked.score0to5).toBeUndefined();
  });

  test("GATING EDGE: a critical finding with reachable=false or low confidence does NOT gate", async () => {
    // overallScore0to5 only counts {verified,high,medium} confidence AND
    // reachable !== false. A critical-vector finding the model says is NOT
    // reachable (reachable:false) must NOT drag the score to 0.
    expect(
      overallScore0to5([{ severity: "critical", confidence: "high", reachable: false }]),
    ).toBe(5);
    // confidence "low" → filtered out → 5.
    expect(
      overallScore0to5([{ severity: "critical", confidence: "low", reachable: true }]),
    ).toBe(5);
    // undefined confidence → treated as "medium" → counted.
    expect(
      overallScore0to5([{ severity: "critical", reachable: true }]),
    ).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PROBE 3 — Fingerprint stability (line-shift invariant; CWE/path sensitive).
// ════════════════════════════════════════════════════════════════════════════
describe("PROBE 3 — fingerprint stability", () => {
  const base = {
    cwe: ["CWE-89"],
    filePath: "src/db.ts",
    snippet: 'const sql = "SELECT * FROM users WHERE id = " + id;',
    category: "SQL Injection",
  };

  test("same finding, shifted lines (whitespace/indent) → SAME fingerprint", () => {
    const fpA = fingerprint(base);
    // Same semantic snippet but re-indented + extra blank lines (line shift).
    const fpB = fingerprint({
      ...base,
      snippet: '\n\n    const sql = "SELECT * FROM users WHERE id = "    +   id;\n',
    });
    P("fp original", fpA);
    P("fp re-indented/shifted", fpB);
    expect(fpA).toBe(fpB);
  });

  test("different CWE → different fingerprint", () => {
    const fpA = fingerprint(base);
    const fpB = fingerprint({ ...base, cwe: ["CWE-22"] });
    P("fp CWE-89 vs CWE-22", [fpA, fpB]);
    expect(fpA).not.toBe(fpB);
  });

  test("different path → different fingerprint", () => {
    const fpA = fingerprint(base);
    const fpB = fingerprint({ ...base, filePath: "src/other.ts" });
    P("fp path db.ts vs other.ts", [fpA, fpB]);
    expect(fpA).not.toBe(fpB);
  });

  test("CWE order-insensitive (same set, different order → SAME fp)", () => {
    const fpA = fingerprint({ ...base, cwe: ["CWE-89", "CWE-20"] });
    const fpB = fingerprint({ ...base, cwe: ["CWE-20", "CWE-89"] });
    expect(fpA).toBe(fpB);
  });

  test("category case/whitespace-insensitive", () => {
    const fpA = fingerprint({ ...base, category: "SQL Injection" });
    const fpB = fingerprint({ ...base, category: "  sql   injection  " });
    expect(fpA).toBe(fpB);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PROBE 4 — Poster: batching + check-run title + fp marker + idempotency.
// ════════════════════════════════════════════════════════════════════════════
describe("PROBE 4 — poster batching + idempotency", () => {
  function critFinding(over: Partial<ReviewFinding> = {}): ReviewFinding {
    return {
      fingerprint: "aabbccddeeff0011",
      filePath: "src/db.ts",
      startLine: 11,
      endLine: 12,
      side: "RIGHT",
      severity: "critical",
      cwe: ["CWE-89"],
      cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      cvssScore: 9.8,
      confidence: "high",
      reachable: true,
      category: "SQL Injection",
      title: "SQLi in db.ts",
      rationaleMd: "tainted",
      source: "llm",
      ...over,
    };
  }
  function res(findings: ReviewFinding[], score: number): ReviewResult {
    return { kind: "pr", score0to5: score, summaryMd: `## Sthrip ${score}/5`, findings };
  }
  const ctx = { owner: "acme", name: "web", pr: 7, headSha: "deadbeef", installationId: "inst-1" };

  test("batches inline comments in ONE review, check-run titled 'Sthrip N/5', marker embedded", async () => {
    const gh = new FakeGitHubClient();
    const findings = [
      critFinding({ fingerprint: "fp00000000000001", startLine: 11 }),
      critFinding({ fingerprint: "fp00000000000002", startLine: 30, title: "second" }),
    ];
    const out = await postReviewResult({ result: res(findings, 0), ctx, github: gh });
    P("postReview call count", gh.postReviewCalls.length);
    P("comments in single review", gh.postReviewCalls[0]?.comments.length);
    P("check-run title", gh.createCheckRunCalls[0]?.title);
    // ONE batched review (anti-spam) carrying BOTH comments.
    expect(gh.postReviewCalls.length).toBe(1);
    expect(gh.postReviewCalls[0]!.comments.length).toBe(2);
    expect(gh.createCheckRunCalls.length).toBe(1);
    expect(gh.createCheckRunCalls[0]!.title).toBe("Sthrip 0/5");
    // marker present in each comment.
    for (const c of gh.postReviewCalls[0]!.comments) {
      expect(c.body).toMatch(/<!-- tensol:fp:fp0000000000000[12] -->/);
    }
    expect(out.postedFingerprints.sort()).toEqual(["fp00000000000001", "fp00000000000002"]);
  });

  test("IDEMPOTENT: re-post with alreadyPosted set of prior fps → NO duplicate comments", async () => {
    const gh = new FakeGitHubClient();
    const findings = [critFinding({ fingerprint: "dup0000000000001" })];
    // First post.
    await postReviewResult({ result: res(findings, 0), ctx, github: gh });
    expect(gh.postReviewCalls.length).toBe(1);

    // Simulate a re-review where the prior fingerprint is already posted (this
    // set is what the handler builds from getOpenThread / existing comment
    // markers). Re-posting the SAME finding must NOT create a second comment.
    const out2 = await postReviewResult({
      result: res(findings, 0),
      ctx,
      github: gh,
      alreadyPosted: new Set(["dup0000000000001"]),
    });
    P("postReview call count after idempotent re-post", gh.postReviewCalls.length);
    P("posted fingerprints on re-post", out2.postedFingerprints);
    // No NEW review posted (nothing fresh), but the gate check-run still runs.
    expect(gh.postReviewCalls.length).toBe(1); // still 1 — no duplicate
    expect(gh.createCheckRunCalls.length).toBe(2); // gate posted both times
    expect(out2.postedFingerprints).toEqual([]);
  });

  test("OBSERVATION: poster idempotency is driven by alreadyPosted Set, NOT by reading existing comment bodies", () => {
    // The task brief framed idempotency as 'given the SAME existing comment
    // bodies (already containing the marker via listReviewComments)'. The
    // GitHubClient interface has NO listReviewComments method — verify that.
    const gh = new FakeGitHubClient();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(gh));
    P("FakeGitHubClient methods", methods);
    const hasListReviewComments = methods.includes("listReviewComments");
    P("has listReviewComments?", hasListReviewComments);
    expect(hasListReviewComments).toBe(false);
    // Therefore dedup CANNOT happen if the caller does not pre-populate
    // alreadyPosted. Demonstrate the failure mode: WITHOUT alreadyPosted, a
    // re-post of the identical finding DOES create a duplicate comment.
    const findings: ReviewFinding[] = [
      {
        fingerprint: "nodedup000000001",
        filePath: "src/db.ts",
        startLine: 11,
        endLine: 12,
        side: "RIGHT",
        severity: "critical",
        cwe: ["CWE-89"],
        cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        cvssScore: 9.8,
        confidence: "high",
        reachable: true,
        category: "SQL Injection",
        title: "SQLi",
        rationaleMd: "x",
        source: "llm",
      },
    ];
    const r: ReviewResult = { kind: "pr", score0to5: 0, summaryMd: "x", findings };
    const c = findingToComment(findings[0]!);
    P("comment body contains marker", c?.body.includes("<!-- tensol:fp:nodedup000000001 -->"));
    expect(c?.body).toContain("<!-- tensol:fp:nodedup000000001 -->");
    // (No assertion of a bug here — the real dedup is the handler's job via the
    // DB review_threads table, exercised in PROBE 5.)
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PROBE 5 — Full pr-review handler E2E against in-mem DB.
// ════════════════════════════════════════════════════════════════════════════
describe("PROBE 5 — full pr-review handler E2E", () => {
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
          title: "SQL injection in db.ts",
        },
      ],
    });
  }

  test("handler: review → completed, findings persisted, audit emitted, comments posted ONCE", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({
      userId: "u",
      owner: "acme",
      name: "web",
      installationId: "inst-1",
    });
    const review = await svc.createReview({
      repoId: repo.id,
      userId: "u",
      kind: "pr",
      prNumber: 7,
      headSha: "deadbeef",
    });
    const github = new FakeGitHubClient({ files: [sqliFile] });
    const handler = createPrReviewHandler({
      service: svc,
      github,
      llm: new FakeLlmClient(sqliResponder),
    });

    await handler("job-1", { reviewId: review.id });

    const finalized = await svc.getReview(review.id);
    P("review status / score / findingsCount", {
      status: finalized?.status,
      score: finalized?.score0to5,
      count: finalized?.findingsCount,
    });
    expect(finalized!.status).toBe("completed");
    expect(finalized!.score0to5).toBe(0);
    expect(finalized!.findingsCount).toBe(1);

    const findings = await svc.getReviewFindings(review.id);
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe("critical");

    // GitHub effects: one batched review + one check-run.
    expect(github.postReviewCalls.length).toBe(1);
    expect(github.createCheckRunCalls.length).toBe(1);
    expect(github.createCheckRunCalls[0]!.title).toBe("Sthrip 0/5");

    // Audit emitted: review_started + review_completed rows in audit_log.
    const auditRows = (db.$client as Database)
      .query("SELECT event, outcome FROM audit_log ORDER BY id")
      .all() as Array<{ event: string; outcome: string }>;
    P("audit events", auditRows.map((r) => r.event));
    const events = auditRows.map((r) => r.event);
    expect(events).toContain("review_started");
    expect(events).toContain("review_completed");

    // Thread mapping recorded for dedup.
    const open = await svc.getOpenThread(repo.id, findings[0]!.fingerprint);
    expect(open).not.toBeNull();
  });

  test("handler IDEMPOTENCY across re-review (synchronize): NO duplicate comments on 2nd run", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "web" });
    const review1 = await svc.createReview({
      repoId: repo.id, userId: "u", kind: "pr", prNumber: 7, headSha: "sha1",
    });
    const github = new FakeGitHubClient({ files: [sqliFile] });
    const handler = createPrReviewHandler({
      service: svc, github, llm: new FakeLlmClient(sqliResponder),
    });
    await handler("job-1", { reviewId: review1.id });
    P("postReview calls after 1st review", github.postReviewCalls.length);
    expect(github.postReviewCalls.length).toBe(1);

    // Second review of the SAME PR (head moved) → same finding fingerprint.
    const review2 = await svc.createReview({
      repoId: repo.id, userId: "u", kind: "pr", prNumber: 7, headSha: "sha2",
    });
    await handler("job-2", { reviewId: review2.id });
    P("postReview calls after 2nd review (re-review)", github.postReviewCalls.length);
    P("check-run calls after 2nd review", github.createCheckRunCalls.length);
    // The handler builds alreadyPosted from getOpenThread → no NEW comment.
    expect(github.postReviewCalls.length).toBe(1); // still 1
    expect(github.createCheckRunCalls.length).toBe(2); // gate runs each time

    // Both reviews finalized completed.
    expect((await svc.getReview(review2.id))!.status).toBe("completed");
  });

  test("handler: clean PR (LLM finds nothing) → 5/5, no review, passing check-run", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "web" });
    const review = await svc.createReview({
      repoId: repo.id, userId: "u", kind: "pr", prNumber: 9, headSha: "clean1",
    });
    const github = new FakeGitHubClient({ files: [sqliFile] });
    // LLM says is_vulnerability:false.
    const cleanResponder = () =>
      JSON.stringify({
        summary: "clean",
        verdicts: [
          {
            candidate_id: "diff:src/db.ts:11:0",
            file_path: "src/db.ts",
            is_vulnerability: false,
            category: "none",
            cwe: [],
            rationale_md: "parameterized",
            reachable: false,
            confidence: "high",
            cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "N", I: "N", A: "N" },
            title: "n/a",
          },
        ],
      });
    const handler = createPrReviewHandler({
      service: svc, github, llm: new FakeLlmClient(cleanResponder),
    });
    await handler("job-1", { reviewId: review.id });
    const finalized = await svc.getReview(review.id);
    P("clean review status/score", { status: finalized?.status, score: finalized?.score0to5 });
    expect(finalized!.status).toBe("completed");
    expect(finalized!.score0to5).toBe(5);
    expect(github.postReviewCalls.length).toBe(0); // nothing to comment
    expect(github.createCheckRunCalls.length).toBe(1);
    expect(github.createCheckRunCalls[0]!.conclusion).toBe("success");
  });
});
