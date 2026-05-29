/**
 * 003-whitebox — GitHub App webhook receiver.
 *
 * Mounted at `/v1/review/github` → full path `POST /v1/review/github/webhook`.
 *
 * Pipeline (order matters — Constitution II: verify BEFORE any work):
 *   1. Read the RAW body (signature is computed over raw bytes).
 *   2. Verify `x-hub-signature-256` HMAC against GITHUB_APP_WEBHOOK_SECRET.
 *      No secret configured OR bad signature → 401 (drop).
 *   3. Idempotency: INSERT the `x-github-delivery` id into `webhook_dedup`;
 *      a UNIQUE collision → 200 duplicate (GitHub retries deliveries).
 *   4. Parse + validate the payload; classify the event.
 *   5. For a reviewable PR event on an ALREADY-CONNECTED repo: create a queued
 *      `reviews` row and enqueue a `pr_review` job. Unknown repo → 202 ignored
 *      (the repo is connected out-of-band via the authenticated API / install).
 *
 * The handler NEVER blocks on the actual review — that runs in the job runner.
 * GitHub requires a fast 2xx ack; we return as soon as the job is enqueued.
 */
import { Hono } from "hono";

import type { DB } from "../db/client.ts";
import { webhookDedup as webhookDedupTable } from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import { classifyWebhook } from "../review/github/webhook.ts";
import { verifyWebhookSignature } from "../review/github/sign.ts";
import { GithubWebhookSchema } from "../review/schemas.ts";
import type { ReviewService } from "../review/service.ts";

export interface CreateReviewWebhookRouterDeps {
  readonly db: DB;
  readonly service: ReviewService;
  /** GITHUB_APP_WEBHOOK_SECRET — when empty, every delivery is rejected. */
  readonly webhookSecret: string;
  readonly now?: () => number;
  readonly newId?: () => string;
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return (
    typeof e.message === "string" && e.message.includes("UNIQUE constraint failed")
  );
}

function splitFullName(fullName: string): { owner: string; name: string } | null {
  const idx = fullName.indexOf("/");
  if (idx <= 0 || idx >= fullName.length - 1) return null;
  return { owner: fullName.slice(0, idx), name: fullName.slice(idx + 1) };
}

export function createReviewWebhookRouter(
  deps: CreateReviewWebhookRouterDeps,
): Hono {
  const { db, service, webhookSecret } = deps;
  const clock = deps.now ?? defaultNow;
  const newId = deps.newId ?? (() => ulid(clock()));

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

    // 3. Idempotency (when a delivery id is present).
    if (deliveryId) {
      try {
        db.insert(webhookDedupTable)
          .values({
            id: newId(),
            webhookKind: "github_review",
            dedupKey: deliveryId,
            receivedAt: clock(),
            metadataJson: JSON.stringify({ event: eventName }),
          })
          .run();
      } catch (err) {
        if (isUniqueViolation(err)) {
          return c.json({ status: "duplicate" }, 200);
        }
        throw err;
      }
    }

    // 4. Parse + classify.
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

    // `@tensol review` issue-comment trigger: classifyWebhook recognizes the
    // intent (kind="review_requested") but the comment payload carries no head
    // SHA, so we cannot start a diff-scoped review without an extra GitHub API
    // fetch (getPullRequest -> head.sha). That fetch needs an installation
    // token + the GitHub client, which is NOT injected into this route. So the
    // on-demand comment trigger is explicitly NOT supported in the MVP — we ack
    // honestly rather than silently dropping it. (Follow-up: inject GitHubClient
    // here and resolve head.sha for review_requested.)
    if (event.kind === "review_requested" && !event.headSha) {
      return c.json(
        { status: "ignored", reason: "comment_trigger_not_supported_yet" },
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

    // 5. Only act on already-connected repos (repo carries the owning user).
    const repo = await service.getRepoByFullName("github", slug.owner, slug.name);
    if (!repo) {
      return c.json({ status: "ignored", reason: "repo_not_connected" }, 202);
    }

    // Refresh the installation id if the webhook carries a newer one.
    if (event.installationId && event.installationId !== repo.installationId) {
      await service.upsertRepo({
        userId: repo.userId,
        owner: slug.owner,
        name: slug.name,
        installationId: event.installationId,
      });
    }

    // Atomic: the queued review + its pending pr_review job commit together, so
    // a crash can never strand a `queued` review with no job to run it.
    const { review, jobId } = await service.createQueuedReviewWithJob(
      {
        repoId: repo.id,
        userId: repo.userId,
        kind: "pr",
        prNumber: event.prNumber,
        headSha: event.headSha,
        ...(event.baseSha !== undefined ? { baseSha: event.baseSha } : {}),
      },
      "pr_review",
    );

    return c.json(
      { status: "queued", review_id: review.id, job_id: jobId, kind: event.kind },
      202,
    );
  });

  return app;
}
