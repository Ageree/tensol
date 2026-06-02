/**
 * Agent-facing API for CLI and MCP clients.
 *
 * Token management is cookie-authenticated (`/tokens`). Operational routes are
 * bearer-authenticated with hashed API tokens, so agents do not depend on
 * browser session cookies.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { eq } from "drizzle-orm";

import type { AuthVariables } from "../auth/middleware.ts";
import { createRequireAgentAuth, type AgentAuthVariables } from "../agent/auth.ts";
import {
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
} from "../agent/tokens.ts";
import type { DB } from "../db/client.ts";
import { jobs as jobsTable, reviews as reviewsTable } from "../db/schema.ts";
import { isExploitEnabled, isResearchEnabled } from "../lib/feature-flags.ts";
import { createRateLimit, defaultKeyFn } from "../lib/rate-limit.ts";
import { WhiteboxLaunchBodySchema } from "../review/schemas.ts";
import type { ReviewService } from "../review/service.ts";
import { findingRowToWire } from "./review.ts";

export interface CreateAgentRouterDeps {
  readonly db: DB;
  readonly service: ReviewService;
  readonly requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>;
  readonly now?: () => number;
}

const TokenCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

const NOT_FOUND = { error: "not_found", message: "resource not found" };
const AGENT_JSON_BODY_LIMIT_BYTES = 64 * 1024;
const AGENT_GENERAL_RATE_LIMIT = 120;
const AGENT_WHITEBOX_RATE_LIMIT = 10;

const agentJsonBodyLimit = bodyLimit({
  maxSize: AGENT_JSON_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json(
      { error: "payload_too_large", message: "request body exceeds the size limit" },
      413,
    ),
});

function tokenToWire(token: {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}) {
  return {
    id: token.id,
    name: token.name,
    token_prefix: token.tokenPrefix,
    created_at: token.createdAt,
    last_used_at: token.lastUsedAt,
    revoked_at: token.revokedAt,
  };
}

function splitRepo(slug: string): { owner: string; name: string } {
  const idx = slug.indexOf("/");
  return { owner: slug.slice(0, idx), name: slug.slice(idx + 1) };
}

function parseJobReviewId(payloadJson: string): string | null {
  try {
    const parsed = JSON.parse(payloadJson) as { reviewId?: unknown; review_id?: unknown };
    const id = parsed.reviewId ?? parsed.review_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

export function createAgentRouter(
  deps: CreateAgentRouterDeps,
): Hono<{ Variables: AgentAuthVariables }> {
  const app = new Hono<{ Variables: AgentAuthVariables }>();
  const requireAgentAuth = createRequireAgentAuth({
    db: deps.db,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  app.post("/tokens", agentJsonBodyLimit, deps.requireAuth, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json", message: "body must be JSON" }, 400);
    }
    const parsed = TokenCreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: "validation_failed",
          message: parsed.error.issues[0]?.message ?? "invalid body",
          issues: parsed.error.issues,
        },
        422,
      );
    }
    const user = c.get("user");
    const created = await createAgentToken({
      db: deps.db,
      userId: user.id,
      name: parsed.data.name,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    return c.json({ token: created.token, token_meta: tokenToWire(created.record) }, 201);
  });

  app.get("/tokens", deps.requireAuth, async (c) => {
    const user = c.get("user");
    const tokens = await listAgentTokens({ db: deps.db, userId: user.id });
    return c.json({ tokens: tokens.map(tokenToWire) }, 200);
  });

  app.delete("/tokens/:id", deps.requireAuth, async (c) => {
    const user = c.get("user");
    const revoked = await revokeAgentToken({
      db: deps.db,
      userId: user.id,
      tokenId: c.req.param("id"),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    return c.json({ revoked }, revoked ? 200 : 404);
  });

  app.use("*", requireAgentAuth);
  app.use(
    "*",
    createRateLimit({
      windowMs: 60_000,
      max: AGENT_GENERAL_RATE_LIMIT,
      keyFn: (c) => {
        const token = c.get("agentToken") as { id?: string } | undefined;
        const user = c.get("user") as { id?: string } | undefined;
        return token?.id ?? user?.id ?? defaultKeyFn(c);
      },
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    }),
  );

  app.get("/health", (c) => {
    const user = c.get("user");
    return c.json(
      {
        ok: true,
        service: "sthrip",
        user,
        features: {
          research_enabled: isResearchEnabled(),
          exploit_enabled: isExploitEnabled(),
        },
      },
      200,
    );
  });

  app.get("/reviews", async (c) => {
    const user = c.get("user");
    const reviews = await deps.service.listReviewsByUser(user.id);
    const counts = await deps.service.countFindingsByReviewIds(reviews.map((r) => r.id));
    const repos = await deps.service.listReposByUser(user.id);
    const repoSlug = new Map(repos.map((r) => [r.id, `${r.owner}/${r.name}`]));
    return c.json(
      {
        reviews: reviews.map((r) => ({
          review_id: r.id,
          kind: r.kind,
          mode: r.mode,
          status: r.status,
          score_0_5: r.score0to5,
          pr_number: r.prNumber,
          repo: r.repoId ? repoSlug.get(r.repoId) ?? null : null,
          created_at: r.createdAt,
          completed_at: r.completedAt,
          findings_count: counts[r.id] ?? 0,
        })),
      },
      200,
    );
  });

  app.get("/reviews/:id", async (c) => {
    const user = c.get("user");
    const review = await deps.service.getReview(c.req.param("id"));
    if (!review || review.userId !== user.id) return c.json(NOT_FOUND, 404);
    const findings = await deps.service.getReviewFindings(review.id);
    return c.json(
      {
        id: review.id,
        repo_id: review.repoId,
        kind: review.kind,
        mode: review.mode,
        pr_number: review.prNumber,
        head_sha: review.headSha,
        status: review.status,
        score_0_5: review.score0to5,
        summary_md: review.summaryMd,
        findings_count: review.findingsCount,
        error: review.error,
        created_at: review.createdAt,
        completed_at: review.completedAt,
        findings: findings.map(findingRowToWire),
      },
      200,
    );
  });

  app.get("/reviews/:id/findings", async (c) => {
    const user = c.get("user");
    const review = await deps.service.getReview(c.req.param("id"));
    if (!review || review.userId !== user.id) return c.json(NOT_FOUND, 404);
    const findings = await deps.service.getReviewFindings(review.id);
    return c.json(
      {
        review_id: review.id,
        findings: findings.map(findingRowToWire),
      },
      200,
    );
  });

  app.post(
    "/whitebox",
    createRateLimit({
      windowMs: 60_000,
      max: AGENT_WHITEBOX_RATE_LIMIT,
      keyFn: (c) => {
        const token = c.get("agentToken") as { id?: string } | undefined;
        const user = c.get("user") as { id?: string } | undefined;
        return `whitebox:${token?.id ?? user?.id ?? defaultKeyFn(c)}`;
      },
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    }),
    agentJsonBodyLimit,
    async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json", message: "body must be JSON" }, 400);
    }
    const parsed = WhiteboxLaunchBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: "validation_failed",
          message: parsed.error.issues[0]?.message ?? "invalid body",
          issues: parsed.error.issues,
        },
        422,
      );
    }
    const body = parsed.data;
    const user = c.get("user");
    let repoId: string;
    if (body.repo_id) {
      const repo = await deps.service.getRepo(body.repo_id);
      if (!repo || repo.userId !== user.id) return c.json(NOT_FOUND, 404);
      repoId = repo.id;
    } else if (body.repo) {
      const { owner, name } = splitRepo(body.repo);
      const repo = await deps.service.upsertRepo({ userId: user.id, owner, name });
      repoId = repo.id;
    } else {
      return c.json(
        { error: "validation_failed", message: "repo_id or repo is required" },
        422,
      );
    }

    if (body.mode === "deep" && !isResearchEnabled()) {
      return c.json(
        {
          error: "feature_disabled",
          message: "deep research is not enabled on this server",
        },
        422,
      );
    }

    const { review, jobId } = await deps.service.createQueuedReviewWithJob(
      {
        repoId,
        userId: user.id,
        kind: "whitebox",
        mode: body.mode ?? "fast",
        ...(body.ref !== undefined ? { commitRef: body.ref } : {}),
      },
      "whitebox_scan",
    );
      return c.json({ review_id: review.id, job_id: jobId, status: "queued" }, 202);
    },
  );

  app.get("/jobs/:id", async (c) => {
    const user = c.get("user");
    const job = deps.db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, c.req.param("id")))
      .get();
    if (!job) return c.json(NOT_FOUND, 404);
    const reviewId = parseJobReviewId(job.payloadJson);
    if (!reviewId) return c.json(NOT_FOUND, 404);
    const review = deps.db
      .select()
      .from(reviewsTable)
      .where(eq(reviewsTable.id, reviewId))
      .get();
    if (!review || review.userId !== user.id) return c.json(NOT_FOUND, 404);
    return c.json(
      {
        job_id: job.id,
        review_id: review.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        scheduled_at: job.scheduledAt,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
        last_error: job.lastError,
      },
      200,
    );
  });

  return app;
}
