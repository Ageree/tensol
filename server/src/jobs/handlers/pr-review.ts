/**
 * 003-whitebox — `pr_review` job handler.
 *
 * Reviews one GitHub pull request end-to-end:
 *   1. Load the queued `reviews` row + its repo (enqueued by the webhook).
 *   2. Fetch the PR's changed files via the GitHub client.
 *   3. Run the shared review engine (diff-scoped).
 *   4. Post a batched review + merge-gating check-run, skipping findings that
 *      already have an open thread (idempotent re-review on `synchronize`).
 *   5. Persist findings + thread fingerprints + finalize the review row.
 *
 * Every external effect is injected (service / github / llm), so the whole
 * handler is unit-testable with fakes and has no network dependency in tests.
 * On failure the review row is marked `failed` (with the error) and the error
 * is re-thrown so the runner's retry / permanent-failure machinery engages.
 *
 * Idempotency: a review already in `completed`/`failed` short-circuits — the
 * runner may re-dispatch a row after a crash between handler success and the
 * status write.
 */
import type { GitHubClient } from "../../review/github/client.ts";
import { runReview } from "../../review/engine.ts";
import { fingerprintsFromComments, postReviewResult } from "../../review/poster.ts";
import type { LlmClient } from "../../review/reviewer.ts";
import type { ReviewService } from "../../review/service.ts";

export interface PrReviewHandlerDeps {
  readonly service: ReviewService;
  readonly github: GitHubClient;
  readonly llm: LlmClient;
  /** Optional token-budget override for the context bundle. */
  readonly tokenBudget?: number;
}

interface NormalizedPayload {
  readonly reviewId: string;
}

function normalizePayload(raw: unknown): NormalizedPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("pr_review: payload is not an object");
  }
  const r = raw as Record<string, unknown>;
  const reviewId =
    (typeof r.reviewId === "string" && r.reviewId) ||
    (typeof r.review_id === "string" && r.review_id) ||
    "";
  if (!reviewId) {
    throw new Error(`pr_review: payload missing reviewId (got ${JSON.stringify(raw)})`);
  }
  return { reviewId };
}

/** Build a `pr_review` handler closing over injected deps. */
export function createPrReviewHandler(deps: PrReviewHandlerDeps) {
  const { service, github, llm } = deps;

  return async function handle(jobId: string, rawPayload: unknown): Promise<void> {
    void jobId;
    const { reviewId } = normalizePayload(rawPayload);

    const review = await service.getReview(reviewId);
    if (!review) throw new Error(`pr_review: review not found (id=${reviewId})`);
    // Idempotency: only a COMPLETED review short-circuits. A `failed` row must
    // NOT short-circuit — the runner re-dispatches a job on transient failure
    // (attempts < maxAttempts), and `markReviewRunning` below overwrites the
    // prior `failed` state, so the retry actually re-runs the review. (Treating
    // `failed` as terminal here would turn every runner retry into a silent
    // no-op after the first transient error.)
    if (review.status === "completed") return;

    try {
      const repo = review.repoId ? await service.getRepo(review.repoId) : null;
      if (!repo) throw new Error(`pr_review: repo not found for review ${reviewId}`);
      if (review.prNumber == null || !review.headSha) {
        throw new Error(`pr_review: review ${reviewId} missing prNumber/headSha`);
      }
      const installationId = repo.installationId ?? undefined;

      await service.markReviewRunning(reviewId);

      const files = await github.getPullRequestFiles({
        owner: repo.owner,
        name: repo.name,
        pr: review.prNumber,
        ...(installationId !== undefined ? { installationId } : {}),
      });

      const result = await runReview(
        {
          kind: "pr",
          files,
          ...(repo.rulesMd ? { rulesMd: repo.rulesMd } : {}),
          ...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
        },
        { llm },
      );

      // Skip findings that already have an open thread (prior review of this PR).
      const alreadyPosted = new Set<string>();
      for (const f of result.findings) {
        const open = await service.getOpenThread(repo.id, f.fingerprint);
        if (open) alreadyPosted.add(f.fingerprint);
      }

      // GitHub is the source of truth for what was actually posted: a retry
      // after a successful post but BEFORE the local thread row committed would
      // otherwise re-post identical inline comments. Reconcile fingerprints
      // already present in the PR's existing comment bodies into the skip set.
      const existing = await github.listReviewComments({
        owner: repo.owner,
        name: repo.name,
        pr: review.prNumber,
        ...(installationId !== undefined ? { installationId } : {}),
      });
      for (const fp of fingerprintsFromComments(existing)) alreadyPosted.add(fp);

      const out = await postReviewResult({
        result,
        ctx: {
          owner: repo.owner,
          name: repo.name,
          pr: review.prNumber,
          headSha: review.headSha,
          ...(installationId !== undefined ? { installationId } : {}),
        },
        github,
        alreadyPosted,
      });

      // Map newly-posted fingerprints to threads so the next re-review dedups.
      for (const fp of out.postedFingerprints) {
        await service.upsertThread({
          reviewId,
          repoId: repo.id,
          fingerprint: fp,
          ...(out.reviewId !== undefined ? { githubThreadId: out.reviewId } : {}),
        });
      }

      await service.finalizeReview(reviewId, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await service.failReview(reviewId, msg);
      throw err;
    }
  };
}
