/**
 * Poster tests — turn a ReviewResult into GitHub effects via FakeGitHubClient.
 */
import { test, expect, describe } from "bun:test";
import { FakeGitHubClient } from "./github/client.ts";
import {
  conclusionForScore,
  findingToComment,
  postReviewResult,
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
});
