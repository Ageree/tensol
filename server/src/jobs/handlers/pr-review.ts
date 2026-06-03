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
import { buildPrAgentTools } from "../../review/agent/tools/pr-tools.ts";
import type { ChatTransport, LoopBudget } from "../../review/agent/loop.ts";
import {
  buildOverCapacityComment,
  fingerprintsFromComments,
  postReviewResult,
  type PriorThread,
} from "../../review/poster.ts";
import type { ReachabilityClient } from "../../review/reachability/joern.ts";
import type { LlmClient } from "../../review/reviewer.ts";
import type { ReviewService } from "../../review/service.ts";
import type { Confidence } from "../../review/types.ts";

export interface PrReviewHandlerDeps {
  readonly service: ReviewService;
  readonly github: GitHubClient;
  readonly llm: LlmClient;
  /** Optional token-budget override for the context bundle. */
  readonly tokenBudget?: number;
  /**
   * Confidence floor for the trust gate (STHRIP_REVIEW_CONFIDENCE_FLOOR). When
   * set, the engine runs an adversarial self-challenge pass over the verdicts
   * before scoring (below-floor / refuted findings are dropped). Omit to keep
   * the legacy LLM-only behaviour.
   */
  readonly confidenceFloor?: Confidence;
  /**
   * Optional reachability adapter (e.g. Joern). Injected into the engine; it is
   * only invoked when a `repoDir` is also available. Absent → the engine simply
   * skips reachability and labels findings lower-confidence (graceful degrade).
   */
  readonly reachability?: ReachabilityClient;
  /**
   * Filesystem path to a checked-out repo. PR review works off the diff alone,
   * so this is normally absent; when present it enables the reachability adapter.
   */
  readonly repoDir?: string;
  /**
   * Optional agentic (gpt-5.5) review. When present, each review builds a fresh
   * metered session (`makeSession`) — a chat transport whose token usage meters
   * into a per-review spend `budget` — and the engine runs the tool-using
   * {@link agentReview} fast path. The PR tools (read_file / get_pr_diff) are
   * bound here to this exact (repo, PR, headSha). Absent → legacy review.
   * The wiring layer only sets this when `TENSOL_AGENT_PR_ENABLED` is on and the
   * agent model client is chat-capable.
   */
  readonly agent?: {
    /** Build one review's metered transport + the budget it meters into. */
    makeSession: () => { transport: ChatTransport; budget: LoopBudget };
    maxRounds: number;
    maxToolCalls: number;
  };
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

/**
 * Collect the prior OPEN threads for a (repo, PR) so the poster can auto-resolve
 * the ones whose finding has been remediated this cycle (T042 / FR-015).
 *
 * Sourced from the most recent COMPLETED review of the same PR (excluding the
 * current review). Every distinct fingerprint of that review that still has an
 * open thread becomes a {@link PriorThread}. The thread's GitHub node id is used
 * to resolve it on GitHub; an absent node id (legacy / inline-only thread) is
 * skipped from the GitHub-resolve list but still resolved locally by fingerprint.
 */
async function collectPriorThreads(
  service: ReviewService,
  repoId: string,
  prNumber: number,
  currentReviewId: string,
): Promise<PriorThread[]> {
  const reviews = await service.listReviewsByRepo(repoId);
  const prior = reviews.find(
    (r) =>
      r.id !== currentReviewId &&
      r.prNumber === prNumber &&
      r.status === "completed",
  );
  if (!prior) return [];

  const findings = await service.getReviewFindings(prior.id);
  const seen = new Set<string>();
  const out: PriorThread[] = [];
  for (const f of findings) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    const open = await service.getOpenThread(repoId, f.fingerprint);
    if (open && open.githubThreadId) {
      out.push({ fingerprint: f.fingerprint, threadId: open.githubThreadId });
    }
  }
  return out;
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

      // Over-capacity / concurrency guard (T025 / FR-017): if another review is
      // already RUNNING for this (repo, PR), do not start a second concurrent
      // engine pass. Post a transparent explanatory comment instead of silently
      // skipping, and finalize this review as completed with no findings.
      const concurrent = await service.hasRunningReview(repo.id, review.prNumber);
      if (concurrent) {
        await github.postReview({
          owner: repo.owner,
          name: repo.name,
          pr: review.prNumber,
          body: buildOverCapacityComment(),
          event: "COMMENT",
          comments: [],
          ...(installationId !== undefined ? { installationId } : {}),
        });
        await service.finalizeReview(reviewId, {
          kind: "pr",
          score0to5: 5,
          summaryMd: buildOverCapacityComment(),
          findings: [],
        });
        return;
      }

      await service.markReviewRunning(reviewId);

      // Prior open threads for this PR (for remediation auto-resolve, T042).
      // Derived from the latest COMPLETED review of the same (repo, PR): each of
      // its findings that still has an open thread is a candidate to resolve if
      // the current cycle no longer reports that fingerprint.
      const priorThreads = await collectPriorThreads(service, repo.id, review.prNumber, reviewId);

      const files = await github.getPullRequestFiles({
        owner: repo.owner,
        name: repo.name,
        pr: review.prNumber,
        ...(installationId !== undefined ? { installationId } : {}),
      });

      // Per-repo learned suppressions (style/nit classes only — the engine's
      // NEVER_SUPPRESS guard re-strips security/correctness as defense in depth).
      const suppressions = await service.listSuppressions(repo.id);
      const suppressedCategories = new Set(suppressions.map((s) => s.category));

      // Agentic fast path (gpt-5.5): build a fresh per-review metered session +
      // tools bound to THIS PR head. Only when the agent dep is wired (flag on)
      // and we have a head SHA to read files at.
      const agentDeps =
        deps.agent && review.headSha
          ? (() => {
              const { transport, budget } = deps.agent!.makeSession();
              return {
                transport,
                budget,
                tools: buildPrAgentTools(github, {
                  owner: repo.owner,
                  name: repo.name,
                  pr: review.prNumber!,
                  ref: review.headSha,
                  ...(installationId !== undefined ? { installationId } : {}),
                }),
                maxRounds: deps.agent!.maxRounds,
                maxToolCalls: deps.agent!.maxToolCalls,
              };
            })()
          : undefined;

      const result = await runReview(
        {
          kind: "pr",
          files,
          ...(repo.rulesMd ? { rulesMd: repo.rulesMd } : {}),
          ...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
          ...(deps.confidenceFloor !== undefined
            ? { confidenceFloor: deps.confidenceFloor }
            : {}),
          ...(suppressedCategories.size > 0 ? { suppressedCategories } : {}),
          ...(deps.repoDir !== undefined ? { repoDir: deps.repoDir } : {}),
        },
        {
          llm,
          ...(deps.reachability ? { reachability: deps.reachability } : {}),
          ...(agentDeps ? { agent: agentDeps } : {}),
        },
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
          statusCheckEnabled: repo.statusCheckEnabled !== 0,
          mergeBlockOnCritical: repo.mergeBlockOnCritical !== 0,
          ...(installationId !== undefined ? { installationId } : {}),
        },
        github,
        alreadyPosted,
        ...(priorThreads.length > 0 ? { priorThreads } : {}),
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

      // Mark the local thread state for remediated findings (the poster resolved
      // them on GitHub; the service also flips review_findings.lifecycle_state).
      const currentFingerprints = new Set(result.findings.map((f) => f.fingerprint));
      for (const t of priorThreads) {
        if (!currentFingerprints.has(t.fingerprint)) {
          await service.resolveThreadByFingerprint({
            repoId: repo.id,
            fingerprint: t.fingerprint,
          });
        }
      }

      await service.finalizeReview(reviewId, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await service.failReview(reviewId, msg);
      throw err;
    }
  };
}
