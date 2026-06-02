/**
 * Poster tests — turn a ReviewResult into GitHub effects via FakeGitHubClient.
 *
 * Extended for 004-sthrip-pr-review:
 *   T022/T024: summary carries severity + numeric confidence + reachability indicator;
 *              re-run edits the SAME summary comment (single comment id).
 *   T038: check-run conclusion = failure iff mergeBlockOnCritical AND verified critical;
 *         statusCheckEnabled=false → no check-run posted.
 *   T039: remediated finding → thread resolved; unchanged finding → single thread.
 */
import { test, expect, describe } from "bun:test";
import { FakeGitHubClient } from "./github/client.ts";
import {
  conclusionForScore,
  findingToComment,
  postReviewResult,
  buildOverCapacityComment,
  fingerprintsFromComments,
} from "./poster.ts";
import type { ReviewFinding, ReviewResult } from "./types.ts";

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    fingerprint: "abc123def4567890",
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
    title: "SQL injection in db.ts",
    rationaleMd: "Tainted input reaches db.exec.",
    pocMd: "`?id=1 OR 1=1`",
    fixPromptMd: "Use a parameterized query.",
    source: "llm",
    ...over,
  };
}

/** A finding with no line anchor (startLine/endLine omitted, not undefined). */
function findingNoLine(over: Partial<ReviewFinding> = {}): ReviewFinding {
  const { startLine: _s, endLine: _e, ...rest } = finding(over);
  return rest;
}

function result(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    kind: "pr",
    score0to5: 0,
    summaryMd: "## Sthrip Review — 0/5",
    findings: [finding()],
    ...over,
  };
}

const ctx = {
  owner: "acme",
  name: "web",
  pr: 7,
  headSha: "deadbeef",
  installationId: "inst-1",
};

describe("conclusionForScore", () => {
  test("maps score bands to check conclusions", () => {
    expect(conclusionForScore(5)).toBe("success");
    expect(conclusionForScore(4)).toBe("neutral");
    expect(conclusionForScore(3)).toBe("neutral");
    expect(conclusionForScore(2)).toBe("failure");
    expect(conclusionForScore(0)).toBe("failure");
  });
});

describe("findingToComment", () => {
  test("embeds a hidden stable fingerprint marker", () => {
    const c = findingToComment(finding());
    expect(c).not.toBeNull();
    expect(c!.path).toBe("src/db.ts");
    expect(c!.line).toBe(11);
    expect(c!.body).toContain("<!-- tensol:fp:abc123def4567890 -->");
    expect(c!.body).toContain("CRITICAL");
    expect(c!.body).toContain("Proof of concept");
    expect(c!.body).toContain("Suggested fix");
  });

  test("returns null when the finding has no line anchor", () => {
    const c = findingToComment(findingNoLine());
    expect(c).toBeNull();
  });

  // T024: numeric confidence column + reachability indicator in inline comment
  test("includes numeric confidence (cvssScore) in inline comment body", () => {
    const c = findingToComment(finding({ cvssScore: 9.8, confidence: "high" }));
    expect(c).not.toBeNull();
    expect(c!.body).toContain("9.8");
  });

  test("includes reachability indicator in inline comment body — reachable=true", () => {
    const c = findingToComment(finding({ reachable: true }));
    expect(c).not.toBeNull();
    // Must NOT say "not-proven-reachable" but indicate reachable
    expect(c!.body).toContain("reachable");
    expect(c!.body).not.toContain("not-proven-reachable");
  });

  test("includes reachability indicator in inline comment body — reachable=false", () => {
    const c = findingToComment(finding({ reachable: false }));
    expect(c).not.toBeNull();
    expect(c!.body).toContain("not-proven-reachable");
  });

  test("includes reachabilityEvidenceMd in comment when present", () => {
    const c = findingToComment(
      finding({ reachabilityEvidenceMd: "Taint path: A→B→C" })
    );
    expect(c).not.toBeNull();
    expect(c!.body).toContain("Taint path: A→B→C");
  });

  test("omits reachability evidence block when absent", () => {
    const c = findingToComment(finding());
    expect(c).not.toBeNull();
    // Should not contain a 'Reachability evidence' heading
    expect(c!.body).not.toContain("Reachability evidence");
  });
});

describe("postReviewResult", () => {
  test("posts one batched review + a check-run", async () => {
    const gh = new FakeGitHubClient();
    const out = await postReviewResult({ result: result(), ctx, github: gh });

    expect(gh.postReviewCalls.length).toBe(1);
    const review = gh.postReviewCalls[0]!;
    expect(review.event).toBe("COMMENT");
    expect(review.comments.length).toBe(1);
    expect(review.installationId).toBe("inst-1");

    expect(gh.createCheckRunCalls.length).toBe(1);
    const check = gh.createCheckRunCalls[0]!;
    expect(check.title).toBe("Sthrip 0/5");
    expect(check.conclusion).toBe("failure");
    expect(check.headSha).toBe("deadbeef");

    expect(out.reviewId).toBe("fake-review-1");
    expect(out.checkRunId).toBe("fake-check-1");
    expect(out.postedFingerprints).toEqual(["abc123def4567890"]);
  });

  test("skips findings already posted in a prior review", async () => {
    const gh = new FakeGitHubClient();
    const out = await postReviewResult({
      result: result(),
      ctx,
      github: gh,
      alreadyPosted: new Set(["abc123def4567890"]),
    });
    // Nothing new to comment on -> no review posted, but the gate still runs.
    expect(gh.postReviewCalls.length).toBe(0);
    expect(gh.createCheckRunCalls.length).toBe(1);
    expect(out.reviewId).toBeUndefined();
    expect(out.postedFingerprints).toEqual([]);
  });

  test("clean result (5/5, no findings) posts only a passing check-run", async () => {
    const gh = new FakeGitHubClient();
    const out = await postReviewResult({
      result: result({ score0to5: 5, findings: [], summaryMd: "ok" }),
      ctx,
      github: gh,
    });
    expect(gh.postReviewCalls.length).toBe(0);
    expect(gh.createCheckRunCalls[0]!.conclusion).toBe("success");
    expect(out.postedFingerprints).toEqual([]);
  });

  test("un-anchored findings are excluded from inline comments", async () => {
    const gh = new FakeGitHubClient();
    const r = result({
      findings: [finding(), findingNoLine({ fingerprint: "noanchor00000000" })],
    });
    const out = await postReviewResult({ result: r, ctx, github: gh });
    expect(gh.postReviewCalls[0]!.comments.length).toBe(1);
    expect(out.postedFingerprints).toEqual(["abc123def4567890"]);
  });

  // T024: poster MUST ONLY post findings with verificationStatus === 'verified'
  // (findings without the field are treated as post-able for legacy compat)
  test("filters out non-verified findings when verificationStatus is present", async () => {
    const gh = new FakeGitHubClient();
    const verifiedFinding = finding({
      fingerprint: "verified00000001",
      verificationStatus: "verified",
    });
    const unverifiedFinding = finding({
      fingerprint: "unverified000002",
      filePath: "src/other.ts",
      startLine: 20,
      verificationStatus: "unverified",
    });
    const refutedFinding = finding({
      fingerprint: "refuted000000003",
      filePath: "src/other.ts",
      startLine: 30,
      verificationStatus: "refuted",
    });
    const r = result({
      findings: [verifiedFinding, unverifiedFinding, refutedFinding],
    });
    const out = await postReviewResult({ result: r, ctx, github: gh });
    // Only verified finding should be posted
    expect(out.postedFingerprints).toEqual(["verified00000001"]);
    expect(gh.postReviewCalls[0]!.comments.length).toBe(1);
    expect(gh.postReviewCalls[0]!.comments[0]!.path).toBe("src/db.ts");
  });

  test("posts findings that have no verificationStatus (legacy — backward compat)", async () => {
    const gh = new FakeGitHubClient();
    // finding() has no verificationStatus by default — should be posted
    const r = result({ findings: [finding()] });
    const out = await postReviewResult({ result: r, ctx, github: gh });
    expect(out.postedFingerprints).toEqual(["abc123def4567890"]);
  });

  // T038: statusCheckEnabled=false → no check-run
  test("does not post a check-run when statusCheckEnabled is false", async () => {
    const gh = new FakeGitHubClient();
    const ctxNoCheck = { ...ctx, statusCheckEnabled: false };
    const out = await postReviewResult({
      result: result(),
      ctx: ctxNoCheck,
      github: gh,
    });
    expect(gh.createCheckRunCalls.length).toBe(0);
    expect(out.checkRunId).toBe("");
  });

  // T038: check-run conclusion = 'failure' iff mergeBlockOnCritical AND verified critical
  test("check-run conclusion is failure when mergeBlockOnCritical=true and verified critical exists", async () => {
    const gh = new FakeGitHubClient();
    const criticalVerified = finding({
      severity: "critical",
      verificationStatus: "verified",
    });
    const ctxMergeBlock = { ...ctx, mergeBlockOnCritical: true };
    await postReviewResult({
      result: result({ score0to5: 3, findings: [criticalVerified] }),
      ctx: ctxMergeBlock,
      github: gh,
    });
    expect(gh.createCheckRunCalls[0]!.conclusion).toBe("failure");
  });

  test("check-run conclusion follows score when mergeBlockOnCritical=true but NO verified critical", async () => {
    const gh = new FakeGitHubClient();
    // high severity but not critical
    const highFinding = finding({
      severity: "high",
      verificationStatus: "verified",
    });
    const ctxMergeBlock = { ...ctx, mergeBlockOnCritical: true };
    await postReviewResult({
      result: result({ score0to5: 3, findings: [highFinding] }),
      ctx: ctxMergeBlock,
      github: gh,
    });
    // score=3 → neutral, not overridden because no verified critical
    expect(gh.createCheckRunCalls[0]!.conclusion).toBe("neutral");
  });

  test("check-run conclusion follows score when mergeBlockOnCritical=false even with critical", async () => {
    const gh = new FakeGitHubClient();
    const criticalVerified = finding({
      severity: "critical",
      verificationStatus: "verified",
    });
    // mergeBlockOnCritical defaults to false (undefined → false)
    await postReviewResult({
      result: result({ score0to5: 3, findings: [criticalVerified] }),
      ctx,
      github: gh,
    });
    // score=3 → neutral, mergeBlock not set
    expect(gh.createCheckRunCalls[0]!.conclusion).toBe("neutral");
  });

  test("critical finding without verificationStatus='verified' does NOT trigger merge block", async () => {
    const gh = new FakeGitHubClient();
    // critical but no verificationStatus (legacy) — should NOT trigger mergeBlock
    const criticalUnset = finding({ severity: "critical" });
    const ctxMergeBlock = { ...ctx, mergeBlockOnCritical: true };
    await postReviewResult({
      result: result({ score0to5: 3, findings: [criticalUnset] }),
      ctx: ctxMergeBlock,
      github: gh,
    });
    // score=3 → neutral, merge block not triggered for unset verificationStatus
    expect(gh.createCheckRunCalls[0]!.conclusion).toBe("neutral");
  });

  // T039: remediated finding → thread resolved; unchanged finding → single thread (idempotent)
  test("resolves threads whose fingerprint is absent from current findings (remediated)", async () => {
    const gh = new FakeGitHubClient();
    const priorThreads = [
      { fingerprint: "old-finding-gone00", threadId: "thread-gql-1" },
      { fingerprint: "abc123def4567890", threadId: "thread-gql-2" },
    ];
    // Current result has only abc123def4567890 — old-finding-gone00 was remediated
    await postReviewResult({
      result: result({ findings: [finding()] }),
      ctx,
      github: gh,
      priorThreads,
    });
    // Only the remediated thread should be resolved
    expect(gh.resolveThreadCalls.length).toBe(1);
    expect(gh.resolveThreadCalls[0]!.threadId).toBe("thread-gql-1");
  });

  test("does not resolve threads when fingerprint still present (unchanged finding)", async () => {
    const gh = new FakeGitHubClient();
    const priorThreads = [
      { fingerprint: "abc123def4567890", threadId: "thread-gql-2" },
    ];
    await postReviewResult({
      result: result({ findings: [finding()] }),
      ctx,
      github: gh,
      priorThreads,
    });
    expect(gh.resolveThreadCalls.length).toBe(0);
  });

  test("resolves all prior threads when no findings remain (all remediated)", async () => {
    const gh = new FakeGitHubClient();
    const priorThreads = [
      { fingerprint: "fp-one", threadId: "t-1" },
      { fingerprint: "fp-two", threadId: "t-2" },
    ];
    await postReviewResult({
      result: result({ findings: [], score0to5: 5, summaryMd: "clean" }),
      ctx,
      github: gh,
      priorThreads,
    });
    expect(gh.resolveThreadCalls.length).toBe(2);
  });

  test("installationId is forwarded to resolveReviewThread", async () => {
    const gh = new FakeGitHubClient();
    const priorThreads = [{ fingerprint: "old-gone00000000", threadId: "t-99" }];
    await postReviewResult({
      result: result({ findings: [] }),
      ctx: { ...ctx, installationId: "inst-xyz" },
      github: gh,
      priorThreads,
    });
    expect(gh.resolveThreadCalls[0]!.installationId).toBe("inst-xyz");
  });

  // T022: summary carries severity + numeric confidence + reachability indicator
  test("summary markdown body passed to postReview and createCheckRun contains score", async () => {
    const gh = new FakeGitHubClient();
    await postReviewResult({
      result: result({ score0to5: 3, summaryMd: "## Sthrip Review — 3/5\nsome text" }),
      ctx,
      github: gh,
    });
    expect(gh.postReviewCalls[0]!.body).toContain("3/5");
    expect(gh.createCheckRunCalls[0]!.summary).toContain("3/5");
  });
});

// T025: over-capacity comment builder
describe("buildOverCapacityComment", () => {
  test("returns a non-empty markdown string explaining the delay", () => {
    const body = buildOverCapacityComment();
    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
    // Must be a useful explanatory message, not a silent skip
    expect(body.toLowerCase()).toContain("sthrip");
  });

  test("body is valid markdown (starts with a heading)", () => {
    const body = buildOverCapacityComment();
    expect(body.trimStart()).toMatch(/^#+\s/);
  });
});
