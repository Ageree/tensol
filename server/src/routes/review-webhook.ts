/**
 * 003-whitebox + 004-sthrip-pr-review — GitHub App webhook receiver.
 *
 * Mounted at `/v1/review/github` → full path `POST /v1/review/github/webhook`.
 *
 * Pipeline (order matters — Constitution II: verify BEFORE any work):
 *   1. Read the RAW body (signature is computed over raw bytes).
 *   2. Verify `x-hub-signature-256` HMAC against GITHUB_APP_WEBHOOK_SECRET.
 *      No secret configured OR bad signature → 401 (drop).
 *   3. Parse + validate the payload; classify the event.
 *   4a. Installation lifecycle events (installation_created/deleted/suspend/
 *       unsuspend, installation_repos_added/removed): persist + dedup in ONE
 *       transaction; 200 duplicate on replay; 202/204 on success. No review
 *       is enqueued — these events update the installations + review_repos tables.
 *       Tenant is resolved via getInstallationByGithubId (SIGNED installationId
 *       → userId). Unknown installation → 202 ignored (graceful, not 4xx).
 *   4b. Reviewable PR event on an ALREADY-CONNECTED repo: create a queued
 *       `reviews` row and enqueue a `pr_review` job. Unknown repo → 202 ignored.
 *
 * The handler NEVER blocks on the actual review — that runs in the job runner.
 * GitHub requires a fast 2xx ack; we return as soon as the work is persisted.
 */
import { Hono } from "hono";

import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import { webhookDedup as webhookDedupTable } from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import { classifyWebhook } from "../review/github/webhook.ts";
import { verifyWebhookSignature } from "../review/github/sign.ts";
import { GithubWebhookSchema } from "../review/schemas.ts";
import type { GitHubClient } from "../review/github/client.ts";
import type { ReviewService } from "../review/service.ts";

export interface CreateReviewWebhookRouterDeps {
  readonly db: DB;
  readonly service: ReviewService;
  /** GITHUB_APP_WEBHOOK_SECRET — when empty, every delivery is rejected. */
  readonly webhookSecret: string;
  readonly now?: () => number;
  readonly newId?: () => string;
  /**
   * Optional GitHub client — required for the `@sthrip review` comment trigger
   * (T040): used to fetch the PR head SHA + base ref when the issue_comment
   * payload does not carry them. When absent the comment trigger path is still
   * acknowledged (202) but no review is enqueued.
   */
  readonly github?: GitHubClient;
}

/**
 * Parse a JSON-encoded covered_branches_json array from a repo row.
 * Returns an empty array on parse failure (safe default = all branches covered).
 */
function parseCoveredBranches(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((b): b is string => typeof b === "string");
    }
    return [];
  } catch {
    return [];
  }
}

function splitFullName(fullName: string): { owner: string; name: string } | null {
  const idx = fullName.indexOf("/");
  if (idx <= 0 || idx >= fullName.length - 1) return null;
  return { owner: fullName.slice(0, idx), name: fullName.slice(idx + 1) };
}

/** True when a SQLite error is a UNIQUE-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return (
    typeof e.message === "string" && e.message.includes("UNIQUE constraint failed")
  );
}

export function createReviewWebhookRouter(
  deps: CreateReviewWebhookRouterDeps,
): Hono {
  const { db, service, webhookSecret } = deps;
  const clock = deps.now ?? defaultNow;
  const newId = deps.newId ?? (() => ulid(clock()));
  const github = deps.github;

  const app = new Hono();

  app.post("/webhook", async (c) => {
    // 1. Raw body for signature verification.
    const rawBody = await c.req.text();

    // 2. Verify signature.
    const sig = c.req.header("x-hub-signature-256");
    if (!verifyWebhookSignature(webhookSecret, rawBody, sig)) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    const eventName = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "";

    // 3. Parse + classify.
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = GithubWebhookSchema.safeParse(json);
    if (!parsed.success) {
      // Malformed but signed payload — ack so GitHub stops retrying.
      return c.json({ status: "ignored", reason: "unparseable_payload" }, 202);
    }
    const event = classifyWebhook(eventName, parsed.data);

    // -------------------------------------------------------------------------
    // 4a. Installation lifecycle events — persist then ack. No review enqueued.
    // -------------------------------------------------------------------------
    if (
      event.kind === "installation_created" ||
      event.kind === "installation_deleted" ||
      event.kind === "installation_suspend" ||
      event.kind === "installation_unsuspend" ||
      event.kind === "installation_repos_added" ||
      event.kind === "installation_repos_removed"
    ) {
      // All installation events carry an installationId.
      const installationId = event.installationId;
      if (!installationId) {
        return c.json({ status: "ignored", reason: "missing_installation_id" }, 202);
      }

      // Resolve owner via the SIGNED installationId — slug alone never authorizes.
      const instRow = await service.getInstallationByGithubId("github", installationId);

      // For installation_created the row might not exist yet (the connect OAuth
      // flow should have pre-created it, but the webhook can race it). If the
      // row is absent, we acknowledge gracefully — the connect route is the
      // authoritative creator, not the webhook.
      if (!instRow && event.kind !== "installation_created") {
        return c.json({ status: "ignored", reason: "installation_not_found" }, 202);
      }
      if (!instRow) {
        // installation_created for an unknown installation — gracefully ignored
        // (the OAuth connect flow creates the row; the webhook is a secondary signal).
        return c.json({ status: "ignored", reason: "installation_not_registered" }, 202);
      }

      const userId = instRow.userId;

      // Dedup: insert the delivery row atomically. On UNIQUE collision return 200.
      if (deliveryId) {
        const dedupRow = {
          id: newId(),
          webhookKind: "github_installation",
          dedupKey: deliveryId,
          receivedAt: clock(),
          metadataJson: JSON.stringify({ event: eventName, kind: event.kind }),
        };
        try {
          await withTx(db, (tx) => {
            tx.insert(webhookDedupTable).values(dedupRow).run();
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            return c.json({ status: "duplicate" }, 200);
          }
          throw err;
        }
      }

      // Dispatch to the appropriate service method.
      if (event.kind === "installation_deleted") {
        await service.markInstallationDeleted(installationId);
        return c.json({ status: "ok", kind: event.kind }, 202);
      }

      if (event.kind === "installation_suspend") {
        await service.setInstallationStatus(installationId, "suspended");
        return c.json({ status: "ok", kind: event.kind }, 202);
      }

      if (event.kind === "installation_unsuspend") {
        await service.setInstallationStatus(installationId, "active");
        return c.json({ status: "ok", kind: event.kind }, 202);
      }

      if (event.kind === "installation_created") {
        // Reconcile repos from the payload if provided. The installation row
        // already exists (created by the OAuth connect flow). Update its fields
        // and reconcile the initial repo list.
        const repos = (event.repositories ?? [])
          .map((slug) => splitFullName(slug))
          .filter((s): s is { owner: string; name: string } => s !== null)
          .map((s) => ({ owner: s.owner, name: s.name }));

        if (repos.length > 0) {
          await service.reconcileInstallationRepos({
            installationRowId: instRow.id,
            installationId,
            userId,
            selection: (event.repositorySelection ?? "all") as "all" | "selected",
            repos,
          });
        }
        return c.json({ status: "ok", kind: event.kind }, 202);
      }

      if (event.kind === "installation_repos_added") {
        const slugs = event.repositories ?? [];
        await service.setReposEnabledBySlugs({
          installationId,
          userId,
          slugs,
          enabled: true,
        });
        return c.json({ status: "ok", kind: event.kind }, 202);
      }

      if (event.kind === "installation_repos_removed") {
        const slugs = event.repositories ?? [];
        await service.setReposEnabledBySlugs({
          installationId,
          userId,
          slugs,
          enabled: false,
        });
        return c.json({ status: "ok", kind: event.kind }, 202);
      }

      // Unreachable: all installation_* kinds handled above.
      return c.json({ status: "ignored", reason: "unhandled_installation_kind" }, 202);
    }

    // -------------------------------------------------------------------------
    // 4b. PR-review path.
    // -------------------------------------------------------------------------

    // T040: `@sthrip review` / `@tensol review` issue-comment trigger.
    // classifyWebhook marks kind="review_requested" but the comment payload
    // carries no head SHA. We resolve the PR details via the GitHub API.
    if (event.kind === "review_requested") {
      if (!event.repoFullName || event.prNumber === undefined || !event.installationId) {
        return c.json({ status: "ignored", reason: "repo_not_connected" }, 202);
      }

      const slug = splitFullName(event.repoFullName);
      if (!slug) return c.json({ status: "ignored", reason: "bad_repo_name" }, 202);

      const repo = await service.getRepoByInstallation(
        "github",
        event.installationId,
        slug.owner,
        slug.name,
      );
      if (!repo) {
        return c.json({ status: "ignored", reason: "repo_not_connected" }, 202);
      }
      if (repo.enabled !== 1) {
        return c.json({ status: "ignored", reason: "repo_disabled" }, 202);
      }

      // Concurrency guard: do not enqueue if a review is already running for
      // this (repoId, prNumber) pair.
      const alreadyRunning = await service.hasRunningReview(repo.id, event.prNumber);
      if (alreadyRunning) {
        return c.json({ status: "ignored", reason: "already_running" }, 202);
      }

      // Fetch the PR head + base info from the GitHub API.
      if (!github) {
        return c.json({ status: "ignored", reason: "github_client_not_configured" }, 202);
      }

      let prInfo: { headSha: string; baseSha: string; baseRef: string };
      try {
        prInfo = await github.getPullRequest({
          owner: slug.owner,
          name: slug.name,
          pr: event.prNumber,
          installationId: event.installationId,
        });
      } catch {
        return c.json({ status: "ignored", reason: "github_fetch_failed" }, 202);
      }

      const { review, jobId, duplicate } = await service.createQueuedReviewWithJob(
        {
          repoId: repo.id,
          userId: repo.userId,
          kind: "pr",
          prNumber: event.prNumber,
          headSha: prInfo.headSha,
          baseSha: prInfo.baseSha,
        },
        "pr_review",
        deliveryId
          ? {
              id: newId(),
              webhookKind: "github_review",
              dedupKey: deliveryId,
              receivedAt: clock(),
              metadataJson: JSON.stringify({ event: eventName }),
            }
          : undefined,
      );

      if (duplicate) {
        return c.json({ status: "duplicate" }, 200);
      }

      return c.json(
        { status: "queued", review_id: review.id, job_id: jobId, kind: event.kind },
        202,
      );
    }

    if (
      event.kind === "ignored" ||
      !event.repoFullName ||
      event.prNumber === undefined ||
      !event.headSha
    ) {
      return c.json({ status: "ignored", reason: event.reason ?? event.kind }, 202);
    }

    const slug = splitFullName(event.repoFullName);
    if (!slug) return c.json({ status: "ignored", reason: "bad_repo_name" }, 202);

    // Resolve the owning repo by the SIGNED installation id — never by
    // (owner,name) alone (cross-tenant takeover class). Unknown installation or
    // unconnected slug → 202 ignored.
    if (!event.installationId) {
      return c.json({ status: "ignored", reason: "repo_not_connected" }, 202);
    }
    const repo = await service.getRepoByInstallation(
      "github",
      event.installationId,
      slug.owner,
      slug.name,
    );
    if (!repo) {
      return c.json({ status: "ignored", reason: "repo_not_connected" }, 202);
    }
    if (repo.enabled !== 1) {
      return c.json({ status: "ignored", reason: "repo_disabled" }, 202);
    }

    // T023: Covered-branch gating.
    // When coveredBranches is non-empty, only enqueue if the PR base ref is in
    // the list. An empty list means "all branches are covered".
    const coveredBranches = parseCoveredBranches(repo.coveredBranchesJson);
    if (coveredBranches.length > 0 && event.baseRef !== undefined) {
      if (!coveredBranches.includes(event.baseRef)) {
        return c.json({ status: "ignored", reason: "not_covered" }, 202);
      }
    }

    // Atomic: dedup row + queued review + pending pr_review job in ONE tx.
    // UNIQUE collision on dedup → 200 duplicate; crash before COMMIT → retry
    // re-processes.
    const { review, jobId, duplicate } = await service.createQueuedReviewWithJob(
      {
        repoId: repo.id,
        userId: repo.userId,
        kind: "pr",
        prNumber: event.prNumber,
        headSha: event.headSha,
        ...(event.baseSha !== undefined ? { baseSha: event.baseSha } : {}),
      },
      "pr_review",
      deliveryId
        ? {
            id: newId(),
            webhookKind: "github_review",
            dedupKey: deliveryId,
            receivedAt: clock(),
            metadataJson: JSON.stringify({ event: eventName }),
          }
        : undefined,
    );

    if (duplicate) {
      return c.json({ status: "duplicate" }, 200);
    }

    return c.json(
      { status: "queued", review_id: review.id, job_id: jobId, kind: event.kind },
      202,
    );
  });

  return app;
}
