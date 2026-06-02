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
import { createMeteredClient } from "../../exploit/metered-client.ts";
import type { Budget } from "../../exploit/budget.ts";

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
  /**
   * When true, run the engine in DEEP mode (the OpenHack-derived multi-agent
   * research pipeline) instead of the fast single-pass path. Off by default so
   * existing behavior is byte-for-byte unchanged. (F1: Deep Whitebox Research.)
   */
  readonly deepResearch?: boolean;
  /**
   * Builds a per-scan spend budget for DEEP research (F1). When provided AND
   * `deepResearch` is on, the handler meters the research LLM against it and the
   * engine consults `assertWithin()` per scenario, so a deep scan is cost-bounded
   * (an exhausted budget throws → the scan is marked failed rather than running
   * up an unbounded bill). No-op when deep mode is off. Server builds it from
   * TENSOL_RESEARCH_BUDGET_USD.
   */
  readonly makeResearchBudget?: () => Budget;
  /**
   * Optional auto-exploit hook (F2: Exploit Lab). When wired, it runs AFTER
   * findings are persisted (so they have ids) and BEFORE the checkout is torn
   * down (so it can read code excerpts), attempting to PROVE the high-confidence
   * findings under a per-review budget and writing verdicts back. Never throws
   * out — a failure here must not fail the scan. Off by default.
   */
  readonly exploit?: (args: {
    reviewId: string;
    authorization: {
      kind: "github-installation";
      installationId: string;
      owner: string;
      repo: string;
    };
    repoDir?: string;
  }) => Promise<unknown>;
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

      // DEEP mode (F1) cost bound: when a research budget factory is wired, meter
      // the research LLM against a fresh per-scan budget and hand the budget to
      // the engine so the pipeline aborts once the ceiling is hit. Fast mode and
      // unbudgeted deep mode use the raw client unchanged.
      const researchBudget =
        deps.deepResearch && deps.makeResearchBudget
          ? deps.makeResearchBudget()
          : undefined;
      const reviewLlm = researchBudget ? createMeteredClient(llm, researchBudget) : llm;

      try {
        const result = await runReview(
          {
            kind: "whitebox",
            files: checkout.files,
            // repoDir present only for on-disk checkouts → enables SAST.
            ...(checkout.repoDir !== undefined ? { repoDir: checkout.repoDir } : {}),
            ...(repo.rulesMd ? { rulesMd: repo.rulesMd } : {}),
            ...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
            ...(deps.deepResearch ? { mode: "deep" as const } : {}),
          },
          {
            llm: reviewLlm,
            ...(deps.sastRunner ? { sastRunner: deps.sastRunner } : {}),
            ...(researchBudget ? { researchBudget } : {}),
          },
        );
        await service.finalizeReview(reviewId, result);

        // F2: auto-exploit the persisted findings (findings now have ids; the
        // checkout is still on disk for code excerpts). Off unless wired; never
        // allowed to fail the scan — exploitation is best-effort enrichment.
        if (deps.exploit && repo.installationId) {
          try {
            await deps.exploit({
              reviewId,
              authorization: {
                kind: "github-installation",
                installationId: repo.installationId,
                owner: repo.owner,
                repo: repo.name,
              },
              ...(checkout.repoDir !== undefined ? { repoDir: checkout.repoDir } : {}),
            });
          } catch {
            // Best-effort: a Lab failure must never turn a completed scan failed.
          }
        }
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
