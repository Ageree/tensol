/**
 * 003-whitebox — GitHub poster.
 *
 * Turns a `ReviewResult` into a single batched PR review (inline comments) + a
 * check-run that gates merge. Honors the dossier's "stable posting" rules:
 *   - one batched review (avoids notification spam + secondary rate limits);
 *   - a hidden stable fingerprint marker in each comment body so re-reviews can
 *     map comments back to findings and avoid duplicates;
 *   - `alreadyPosted` fingerprints are skipped (idempotent re-review);
 *   - the check-run conclusion is derived from the deterministic 0-5 score.
 *
 * Effects are confined to the injected `GitHubClient`, so this is unit-testable
 * with `FakeGitHubClient`.
 */
import type { GitHubClient, ReviewComment } from "./github/client.ts";
import type { ReviewFinding, ReviewResult } from "./types.ts";

export interface PostContext {
  readonly owner: string;
  readonly name: string;
  readonly pr: number;
  readonly headSha: string;
  readonly installationId?: string;
}

const SEV_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  informational: "⚪",
};

/** Build the inline comment body for a finding (with hidden stable marker). */
export function findingToComment(f: ReviewFinding): ReviewComment | null {
  // GitHub inline comments require a line anchor; un-anchored findings are
  // surfaced via the review summary instead.
  if (f.startLine === undefined || f.startLine === null) return null;
  const emoji = SEV_EMOJI[f.severity] ?? "•";
  const cweStr = f.cwe.length > 0 ? ` · ${f.cwe.join(", ")}` : "";
  const reach = f.reachable ? "reachable" : "not-proven-reachable";
  const parts: string[] = [
    `**${emoji} ${f.severity.toUpperCase()}: ${f.title}** — CVSS ${f.cvssScore} (${f.confidence}, ${reach}${cweStr})`,
    "",
    f.rationaleMd,
  ];
  if (f.pocMd) {
    parts.push(
      "",
      "<details><summary>Proof of concept</summary>",
      "",
      f.pocMd,
      "</details>",
    );
  }
  if (f.fixPromptMd) {
    parts.push(
      "",
      "<details><summary>Suggested fix (paste into your coding agent)</summary>",
      "",
      f.fixPromptMd,
      "</details>",
    );
  }
  // Hidden stable marker — lets a re-review recognize an already-posted finding.
  parts.push("", `<!-- tensol:fp:${f.fingerprint} -->`);
  return {
    path: f.filePath,
    line: f.startLine,
    side: f.side,
    body: parts.join("\n"),
  };
}

/** Map the 0-5 merge-readiness score to a check-run conclusion. */
export function conclusionForScore(
  score: number,
): "success" | "neutral" | "failure" | "action_required" {
  if (score >= 5) return "success";
  if (score >= 3) return "neutral";
  return "failure";
}

export interface PostReviewOutcome {
  reviewId?: string;
  checkRunId: string;
  postedFingerprints: string[];
}

/**
 * Post a review result to GitHub: a batched inline review (only for findings
 * not already posted + anchorable to a line) plus a merge-gating check-run.
 */
export async function postReviewResult(args: {
  result: ReviewResult;
  ctx: PostContext;
  github: GitHubClient;
  /** Fingerprints already posted in a prior review of this PR. */
  alreadyPosted?: Set<string>;
}): Promise<PostReviewOutcome> {
  const { result, ctx, github } = args;
  const already = args.alreadyPosted ?? new Set<string>();
  const inst = ctx.installationId;

  const fresh = result.findings.filter((f) => !already.has(f.fingerprint));
  const comments: ReviewComment[] = [];
  const postedFingerprints: string[] = [];
  for (const f of fresh) {
    const c = findingToComment(f);
    if (c) {
      comments.push(c);
      postedFingerprints.push(f.fingerprint);
    }
  }

  let reviewId: string | undefined;
  if (comments.length > 0) {
    const res = await github.postReview({
      owner: ctx.owner,
      name: ctx.name,
      pr: ctx.pr,
      body: result.summaryMd,
      // COMMENT (not REQUEST_CHANGES) is always permitted for an App even on a
      // PR it authored; the check-run carries the pass/fail gate.
      event: "COMMENT",
      comments,
      ...(inst !== undefined ? { installationId: inst } : {}),
    });
    reviewId = res.reviewId;
  }

  const check = await github.createCheckRun({
    owner: ctx.owner,
    name: ctx.name,
    headSha: ctx.headSha,
    conclusion: conclusionForScore(result.score0to5),
    title: `Sthrip ${result.score0to5}/5`,
    summary: result.summaryMd,
    ...(inst !== undefined ? { installationId: inst } : {}),
  });

  return {
    ...(reviewId !== undefined ? { reviewId } : {}),
    checkRunId: check.checkRunId,
    postedFingerprints,
  };
}
