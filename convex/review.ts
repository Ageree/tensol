import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type QueryCtx, mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

function reviewListItem(row: {
  _id: string;
  kind: "pr" | "whitebox";
  mode: "fast" | "deep";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  score_0_5?: number;
  summary_md?: string;
  execution_status?: "skipped" | "running" | "passed" | "failed" | "error";
  execution_summary_md?: string;
  pr_number?: number;
  repo?: string;
  created_at: number;
  completed_at?: number;
  findings: unknown[];
}) {
  return {
    review_id: row._id,
    kind: row.kind,
    mode: row.mode,
    status: row.status,
    score_0_5: row.score_0_5 ?? null,
    pr_number: row.pr_number ?? null,
    repo: row.repo ?? null,
    created_at: row.created_at,
    completed_at: row.completed_at ?? null,
    findings_count: row.findings.length,
    execution_status: row.execution_status ?? null,
  };
}

async function reviewDetail(
  ctx: QueryCtx,
  row: Doc<"reviews">,
) {
  const artifacts = await ctx.db
    .query("reviewExecutionArtifacts")
    .withIndex("by_reviewId_and_created_at", (q) => q.eq("reviewId", row._id))
    .order("desc")
    .take(50);
  return {
    ...reviewListItem(row),
    review_id: row._id,
    summary_md: row.summary_md ?? null,
    execution_summary_md: row.execution_summary_md ?? null,
    execution_artifacts: artifacts.map((a) => ({
      id: a._id,
      kind: a.kind,
      label: a.label,
      summary_md: a.summary_md,
      storage_key: a.storage_key ?? null,
      inline_body: a.inline_body ?? null,
      mime_type: a.mime_type ?? null,
      sha256: a.sha256 ?? null,
      byte_size: a.byte_size ?? null,
      created_at: a.created_at,
    })),
    findings: row.findings,
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireUser(ctx);
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_userId_and_created_at", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
    return rows.map(reviewListItem);
  },
});

export const get = query({
  args: { id: v.id("reviews") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== user._id) {
      throw new ConvexError({ error: "not_found", message: "review not found" });
    }
    return await reviewDetail(ctx, row);
  },
});

export const create = mutation({
  args: {
    repo: v.string(),
    pr: v.optional(v.number()),
    head_sha: v.optional(v.string()),
    base_sha: v.optional(v.string()),
    diff: v.optional(v.string()),
    files: v.optional(v.array(v.any())),
    sync: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const now = Date.now();
    const id = await ctx.db.insert("reviews", {
      userId: user._id,
      kind: "pr",
      mode: "fast",
      status: "queued",
      summary_md: "Review queued for analysis.",
      pr_number: args.pr,
      repo: args.repo,
      findings: [],
      created_at: now,
    });
    await ctx.db.insert("jobs", {
      type: "review.pr",
      status: "pending",
      payload: {
        review_id: id,
        repo: args.repo,
        pr: args.pr ?? null,
        head_sha: args.head_sha ?? null,
        base_sha: args.base_sha ?? null,
        sync: args.sync ?? false,
      },
      attempts: 0,
      scheduled_at: now,
      created_at: now,
      updated_at: now,
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error("created review vanished");
    return await reviewDetail(ctx, row);
  },
});

export const listRepos = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireUser(ctx);
    const rows = await ctx.db
      .query("reviewRepos")
      .withIndex("by_userId_and_created_at", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(100);
    return rows.map((r) => ({
      id: r._id,
      scm: r.scm,
      owner: r.owner,
      name: r.name,
      default_branch: r.default_branch,
      status: r.status,
      installation_id: r.installation_id ?? null,
      created_at: r.created_at,
    }));
  },
});

export const launchWhitebox = mutation({
  args: {
    repo_id: v.optional(v.string()),
    repo: v.optional(v.string()),
    ref: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("fast"), v.literal("deep"))),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const now = Date.now();
    const id = await ctx.db.insert("reviews", {
      userId: user._id,
      kind: "whitebox",
      mode: args.mode ?? "fast",
      status: "queued",
      summary_md: "Whitebox review queued for analysis.",
      repo: args.repo ?? args.repo_id ?? "connected-repository",
      findings: [],
      created_at: now,
    });
    await ctx.db.insert("jobs", {
      type: "review.whitebox",
      status: "pending",
      payload: {
        review_id: id,
        repo_id: args.repo_id ?? null,
        repo: args.repo ?? null,
        ref: args.ref ?? null,
        mode: args.mode ?? "fast",
      },
      attempts: 0,
      scheduled_at: now,
      created_at: now,
      updated_at: now,
    });
    return { review_id: id };
  },
});
