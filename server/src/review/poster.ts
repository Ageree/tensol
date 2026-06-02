/**
 * 003-whitebox / 004-sthrip-pr-review — GitHub poster.
 *
 * Turns a `ReviewResult` into a single batched PR review (inline comments) + a
 * check-run that gates merge. Honors the dossier's "stable posting" rules:
 *   - one batched review (avoids notification spam + secondary rate limits);
 *   - a hidden stable fingerprint marker in each comment body so re-reviews can
 *     map comments back to findings and avoid duplicates;
 *   - `alreadyPosted` fingerprints are skipped (idempotent re-review);
 *   - the check-run conclusion is derived from the deterministic 0-5 score,
 *     with optional merge-blocking override when a verified critical exists;
 *   - `priorThreads` are resolved when their fingerprint is absent from the
 *     current result (finding was remediated — T039/T042).
 *
 * 004 additions (T024/T038/T039/T041/T025):
 *   - inline comment + summary render numeric confidence (cvssScore) +
 *     reachability indicator per finding;
 *   - ONLY findings with verificationStatus === 'verified' (or absent/legacy)
 *     are posted; unverified/refuted are filtered before posting;
 *   - PostContext gains statusCheckEnabled + mergeBlockOnCritical booleans;
 *   - when statusCheckEnabled===false, no check-run is posted;
 *   - check-run conclusion = 'failure' iff mergeBlockOnCritical AND a verified
 *     critical finding exists; otherwise falls back to conclusionForScore;
 *   - priorThreads are resolved via github.resolveReviewThread when absent;
 *   - buildOverCapacityComment exported for the job handler (T025).
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
  /**
   * When false, no check-run is posted for this repository (FR-014 / T041).
   * Defaults to true (check-run is always posted) when absent/undefined.
   */
  readonly statusCheckEnabled?: boolean;
  /**
   * When true AND a verified-critical finding is in the result, force the
   * check-run conclusion to 'failure' regardless of the numeric score (T041).
   * Defaults to false when absent/undefined.
   */
  readonly mergeBlockOnCritical?: boolean;
}

/** Prior thread descriptor — for remediation detection (T039). */
export interface PriorThread {
  /** The stable fingerprint that identifies the finding this thread is about. */
  readonly fingerprint: string;
  /** GitHub GraphQL thread node id — passed to resolveReviewThread. */
  readonly threadId: string;
}

const SEV_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  informational: "⚪",
};

/**
 * Hidden fingerprint marker embedded in every posted comment body — the
 * internal HTML wire marker (NOT a user-facing brand string), kept verbatim.
 * `g` so a single body containing several markers yields all of them.
 */
const FINGERPRINT_MARKER_RE = /<!--\s*tensol:fp:([^\s]+)\s*-->/g;

/**
 * Extract every `tensol:fp:<id>` fingerprint marker from a set of existing PR
 * comment bodies. Used to reconcile against GitHub state (the source of truth)
 * so a retry after a successful post — but before the local thread committed —
 * does not re-post the same inline comments.
 */
export function fingerprintsFromComments(
  comments: ReadonlyArray<{ body: string }>,
): Set<string> {
  const out = new Set<string>();
  for (const c of comments) {
    for (const m of c.body.matchAll(FINGERPRINT_MARKER_RE)) {
      if (m[1]) out.add(m[1]);
    }
  }
  return out;
}

/**
 * Returns whether a finding should be posted.
 *
 * Rule (T024/FR-018):
 *   - If `verificationStatus` is explicitly set: only 'verified' passes.
 *   - If `verificationStatus` is absent (legacy): post it (backward compat).
 */
function isPostable(f: ReviewFinding): boolean {
  if (f.verificationStatus === undefined) return true; // legacy — post
  return f.verificationStatus === "verified";
}

/**
 * Returns true iff there is at least one finding with severity 'critical'
 * AND verificationStatus === 'verified'. Used for the merge-block gate (T041).
 */
function hasVerifiedCritical(findings: ReviewFinding[]): boolean {
  return findings.some(
    (f) => f.severity === "critical" && f.verificationStatus === "verified",
  );
}

/** Build the inline comment body for a finding (with hidden stable marker). */
export function findingToComment(f: ReviewFinding): ReviewComment | null {
  // GitHub inline comments require a line anchor; un-anchored findings are
  // surfaced via the review summary instead.
  if (f.startLine === undefined || f.startLine === null) return null;
  const emoji = SEV_EMOJI[f.severity] ?? "•";
  const cweStr = f.cwe.length > 0 ? ` · ${f.cwe.join(", ")}` : "";
  // T024: reachability indicator
  const reach = f.reachable ? "reachable" : "not-proven-reachable";
  // T024: numeric confidence using cvssScore (always a number on a scored finding)
  const parts: string[] = [
    `**${emoji} ${f.severity.toUpperCase()}: ${f.title}** — CVSS ${f.cvssScore} (${f.confidence}, ${reach}${cweStr})`,
    "",
    f.rationaleMd,
  ];
  // T024: reachability evidence block when present
  if (f.reachabilityEvidenceMd) {
    parts.push(
      "",
      "<details><summary>Reachability evidence</summary>",
      "",
      f.reachabilityEvidenceMd,
      "</details>",
    );
  }
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

/**
 * Build the transparent over-capacity PR comment body (T025 / FR-017).
 *
 * Called by the job handler when the queue limit is exceeded. Returns a
 * Markdown string explaining the delay and inviting a manual re-trigger.
 * Exported so the job handler can import and post it without depending on
 * the rest of the poster.
 */
export function buildOverCapacityComment(): string {
  return [
    "## Sthrip — Review Queued",
    "",
    "Sthrip is currently experiencing high demand and could not start your review immediately.",
    "",
    "Your pull request has been queued and will be reviewed as soon as capacity is available.",
    "To trigger a review manually at any time, comment `@sthrip review` on this pull request.",
    "",
    "> This message was posted automatically. No action is required on your part.",
  ].join("\n");
}

export interface PostReviewOutcome {
  reviewId?: string;
  checkRunId: string;
  postedFingerprints: string[];
}

/**
 * Post a review result to GitHub: a batched inline review (only for findings
 * not already posted + anchorable to a line) plus a merge-gating check-run.
 *
 * New in 004:
 *   - Filters to only postable (verified or legacy) findings before building comments.
 *   - Resolves prior threads whose fingerprint is absent from the current result.
 *   - Respects statusCheckEnabled/mergeBlockOnCritical from PostContext.
 */
export async function postReviewResult(args: {
  result: ReviewResult;
  ctx: PostContext;
  github: GitHubClient;
  /** Fingerprints already posted in a prior review of this PR. */
  alreadyPosted?: Set<string>;
  /**
   * Prior open threads for this PR — used to auto-resolve remediated findings.
   * Threads whose fingerprint is absent from result.findings are resolved (T039).
   */
  priorThreads?: PriorThread[];
}): Promise<PostReviewOutcome> {
  const { result, ctx, github } = args;
  const already = args.alreadyPosted ?? new Set<string>();
  const inst = ctx.installationId;

  // T024: filter to postable (verified or legacy) findings only.
  const postableFindings = result.findings.filter(isPostable);

  const fresh = postableFindings.filter((f) => !already.has(f.fingerprint));
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

  // T039/T042: auto-resolve threads whose fingerprint is absent from the
  // current result (remediated findings). Uses the full result.findings (not
  // just postableFindings) so a refuted/unverified finding that was previously
  // posted can still be resolved.
  if (args.priorThreads && args.priorThreads.length > 0) {
    const currentFingerprints = new Set(result.findings.map((f) => f.fingerprint));
    const remediatedThreads = args.priorThreads.filter(
      (t) => !currentFingerprints.has(t.fingerprint),
    );
    for (const t of remediatedThreads) {
      await github.resolveReviewThread({
        threadId: t.threadId,
        ...(inst !== undefined ? { installationId: inst } : {}),
      });
    }
  }

  // T041: skip check-run entirely when statusCheckEnabled is explicitly false.
  const statusCheckEnabled = ctx.statusCheckEnabled !== false;
  if (!statusCheckEnabled) {
    return {
      ...(reviewId !== undefined ? { reviewId } : {}),
      checkRunId: "",
      postedFingerprints,
    };
  }

  // T041: conclusion override — failure iff mergeBlockOnCritical AND a verified
  // critical finding is present; otherwise fall back to conclusionForScore.
  let conclusion: "success" | "neutral" | "failure" | "action_required";
  if (ctx.mergeBlockOnCritical && hasVerifiedCritical(result.findings)) {
    conclusion = "failure";
  } else {
    conclusion = conclusionForScore(result.score0to5);
  }

  const check = await github.createCheckRun({
    owner: ctx.owner,
    name: ctx.name,
    headSha: ctx.headSha,
    conclusion,
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
