/**
 * 003-whitebox — `whitebox_scan` job handler.
 *
 * Reviews a whole repository (not a PR diff):
 *   1. Load the queued `reviews` row + its repo.
 *   2. Fetch the repo's files via the injected `RepoFetcher` (whole-file
 *      DiffFiles with synthesized all-added patches — see `repo-fetch.ts`).
 *   3. Run the shared engine in `whitebox` mode, layering SAST findings
 *      (Opengrep / Trivy / Gitleaks) on top of whole-file candidates when a
 *      `SastRunner` is wired and the repo is on disk.
 *   4. Persist findings + finalize the review row.
 *
 * Unlike `pr_review` this does NOT post to GitHub — whitebox results live in
 * the Tensol dashboard / report. All effects are injected for testability.
 *
 * Repo auth: when `repo.installationId` + a token provider are configured the
 * server wires an authenticated clone URL; otherwise the repo must be public.
 * Missing fetch capability degrades to a thrown error captured as `failed`.
 */
import { runReview } from "../../review/engine.ts";
import type { RepoFetcher } from "../../review/repo-fetch.ts";
import type { LlmClient } from "../../review/reviewer.ts";
import type { SastRunner } from "../../review/sast/runner.ts";
import type { ReviewService } from "../../review/service.ts";

export interface WhiteboxScanHandlerDeps {
  readonly service: ReviewService;
  readonly fetcher: RepoFetcher;
  readonly llm: LlmClient;
  readonly sastRunner?: SastRunner;
  /** Build the clone URL for a repo (server injects token auth here). */
  readonly cloneUrlFor: (repo: {
    owner: string;
    name: string;
    scm: string;
    installationId: string | null;
  }) => Promise<string> | string;
  readonly tokenBudget?: number;
}

interface NormalizedPayload {
  readonly reviewId: string;
}

function normalizePayload(raw: unknown): NormalizedPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("whitebox_scan: payload is not an object");
  }
  const r = raw as Record<string, unknown>;
  const reviewId =
    (typeof r.reviewId === "string" && r.reviewId) ||
    (typeof r.review_id === "string" && r.review_id) ||
    "";
  if (!reviewId) {
    throw new Error(
      `whitebox_scan: payload missing reviewId (got ${JSON.stringify(raw)})`,
    );
  }
  return { reviewId };
}

/** Build a `whitebox_scan` handler closing over injected deps. */
export function createWhiteboxScanHandler(deps: WhiteboxScanHandlerDeps) {
  const { service, fetcher, llm } = deps;

  return async function handle(jobId: string, rawPayload: unknown): Promise<void> {
    void jobId;
    const { reviewId } = normalizePayload(rawPayload);

    const review = await service.getReview(reviewId);
    if (!review) throw new Error(`whitebox_scan: review not found (id=${reviewId})`);
    // Only a COMPLETED review short-circuits — a `failed` row must re-run on the
    // runner's retry (markReviewRunning overwrites it). See pr-review.ts for the
    // full rationale (treating `failed` as terminal silently defeats retries).
    if (review.status === "completed") return;

    try {
      const repo = review.repoId ? await service.getRepo(review.repoId) : null;
      if (!repo) throw new Error(`whitebox_scan: repo not found for review ${reviewId}`);

      await service.markReviewRunning(reviewId);

      const cloneUrl = await deps.cloneUrlFor({
        owner: repo.owner,
        name: repo.name,
        scm: repo.scm,
        installationId: repo.installationId ?? null,
      });

      const checkout = await fetcher.fetch({
        cloneUrl,
        ...(review.commitRef ? { ref: review.commitRef } : {}),
      });

      try {
        const result = await runReview(
          {
            kind: "whitebox",
            files: checkout.files,
            // repoDir present only for on-disk checkouts → enables SAST.
            ...(checkout.repoDir !== undefined ? { repoDir: checkout.repoDir } : {}),
            ...(repo.rulesMd ? { rulesMd: repo.rulesMd } : {}),
            ...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
          },
          {
            llm,
            ...(deps.sastRunner ? { sastRunner: deps.sastRunner } : {}),
          },
        );
        await service.finalizeReview(reviewId, result);
      } finally {
        await checkout.cleanup();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await service.failReview(reviewId, msg);
      throw err;
    }
  };
}
