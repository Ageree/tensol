/**
 * 003-whitebox — GitHub webhook classifier.
 *
 * Pure routing layer: given a validated `GithubWebhook` payload and the
 * `X-GitHub-Event` name, decide what (if anything) the review engine should
 * do. The engine only ever acts on a small set of events:
 *
 *   - a PR is opened / reopened / marked ready-for-review  → full review
 *   - new commits are pushed to an open PR (synchronize)   → re-review
 *   - a human comments `@tensol review` / `/tensol review` → on-demand review
 *
 * Everything else is `ignored` (with a `reason` where it aids debugging).
 *
 * Two safety invariants are encoded here:
 *   1. Draft PRs are skipped — unless the very action is `ready_for_review`
 *      (a draft transitioning to ready), which is exactly when we want in.
 *   2. Bot-authored comments never trigger a review (loop guard): otherwise
 *      our own posted comments could re-trigger the engine indefinitely.
 *
 * No side effects, no network, no clock reads — trivially testable.
 */
import type { GithubWebhook } from "../schemas.ts";

/** The decision emitted for one incoming webhook delivery. */
export type WebhookEvent = {
  kind: "pr_opened" | "pr_synchronize" | "review_requested" | "ignored";
  repoFullName?: string;
  prNumber?: number;
  headSha?: string;
  baseSha?: string;
  installationId?: string;
  reason?: string;
};

/** PR actions that mean "run a fresh full review". */
const OPEN_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);

/**
 * Matches a human-issued review command anywhere in a comment body:
 *   `@tensol review`  or  `/tensol review`  (any surrounding whitespace,
 *   case-insensitive).
 */
const REVIEW_COMMAND = /(?:@|\/)tensol\s+review\b/i;

/** Build an `ignored` decision with an optional human-readable reason. */
function ignored(reason?: string): WebhookEvent {
  return reason === undefined ? { kind: "ignored" } : { kind: "ignored", reason };
}

/** Classify a `pull_request` event. */
function classifyPullRequest(payload: GithubWebhook): WebhookEvent {
  const action = payload.action;
  const pr = payload.pull_request;
  if (!action || !pr) return ignored("pull_request: missing action/pull_request");

  const isOpenAction = OPEN_ACTIONS.has(action);
  const isSync = action === "synchronize";
  if (!isOpenAction && !isSync) return ignored(`pull_request: unhandled action ${action}`);

  // Draft skip — but `ready_for_review` is the moment a draft leaves draft, so
  // allow it through even though `draft` may still read true on the payload.
  if (pr.draft && action !== "ready_for_review") {
    return ignored("pull_request: draft PR skipped");
  }

  const base: WebhookEvent = {
    kind: isSync ? "pr_synchronize" : "pr_opened",
    prNumber: pr.number,
    headSha: pr.head.sha,
  };
  const repoFullName = payload.repository?.full_name;
  const baseSha = pr.base?.sha;
  const installationId =
    payload.installation === undefined ? undefined : String(payload.installation.id);

  return {
    ...base,
    ...(repoFullName === undefined ? {} : { repoFullName }),
    ...(baseSha === undefined ? {} : { baseSha }),
    ...(installationId === undefined ? {} : { installationId }),
  };
}

/** Classify an `issue_comment` event (on-demand `@tensol review` trigger). */
function classifyIssueComment(payload: GithubWebhook): WebhookEvent {
  if (payload.action !== "created") {
    return ignored("issue_comment: action is not created");
  }
  const issue = payload.issue;
  const comment = payload.comment;
  if (!issue || !comment) return ignored("issue_comment: missing issue/comment");

  // Comments on plain issues (no `pull_request` link) are out of scope.
  if (!issue.pull_request) return ignored("issue_comment: not on a pull request");

  // Loop guard: never react to bot-authored comments (incl. our own).
  if (comment.user?.type === "Bot") return ignored("issue_comment: authored by a bot");

  if (!REVIEW_COMMAND.test(comment.body)) {
    return ignored("issue_comment: no review command");
  }

  const repoFullName = payload.repository?.full_name;
  const installationId =
    payload.installation === undefined ? undefined : String(payload.installation.id);

  return {
    kind: "review_requested",
    prNumber: issue.number,
    ...(repoFullName === undefined ? {} : { repoFullName }),
    ...(installationId === undefined ? {} : { installationId }),
  };
}

/**
 * Map an incoming GitHub webhook delivery to a review-engine decision.
 *
 * @param eventName The `X-GitHub-Event` header value (e.g. "pull_request").
 * @param payload   The already-validated webhook body.
 */
export function classifyWebhook(eventName: string, payload: GithubWebhook): WebhookEvent {
  switch (eventName) {
    case "pull_request":
      return classifyPullRequest(payload);
    case "issue_comment":
      return classifyIssueComment(payload);
    default:
      return ignored(`unhandled event ${eventName}`);
  }
}
