import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

export const connect = query({
  args: {},
  handler: async () => ({
    install_url:
      process.env.GITHUB_APP_INSTALL_URL ??
      "https://github.com/apps/sthrip/installations/new",
    state: "convex-managed",
  }),
});

export const installations = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireUser(ctx);
    const rows = await ctx.db
      .query("githubInstallations")
      .withIndex("by_userId_and_created_at", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
    return {
      connected: rows.some((r) => r.status === "active"),
      installations: rows.map((r) => ({
        id: r.installation_id,
        account_login: r.account_login,
        account_type: r.account_type,
        repository_selection: r.repository_selection,
        status: r.status,
      })),
    };
  },
});

export const installationRepos = query({
  args: { installationId: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const inst = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installationId))
      .first();
    if (inst && inst.userId !== user._id) {
      throw new ConvexError({ error: "not_found", message: "installation not found" });
    }
    return [];
  },
});

export const updateRepoSettings = mutation({
  args: {
    repoId: v.id("reviewRepos"),
    enabled: v.optional(v.boolean()),
    covered_branches: v.optional(v.array(v.string())),
    status_check_enabled: v.optional(v.boolean()),
    merge_block_on_critical: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const repo = await ctx.db.get(args.repoId);
    if (!repo || repo.userId !== user._id) {
      throw new ConvexError({ error: "not_found", message: "repo not found" });
    }
    const status = args.enabled === false ? "paused" : "active";
    await ctx.db.patch(repo._id, { status, updated_at: Date.now() });
    return {
      repo_id: repo._id,
      owner: repo.owner,
      name: repo.name,
      default_branch: repo.default_branch,
      enabled: status === "active",
      covered_branches: args.covered_branches ?? [repo.default_branch],
      status_check_enabled: args.status_check_enabled ?? true,
      merge_block_on_critical: args.merge_block_on_critical ?? true,
      last_review: null,
    };
  },
});

export const disconnect = mutation({
  args: { installation_id: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const inst = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();
    if (inst && inst.userId === user._id) {
      await ctx.db.patch(inst._id, { status: "deleted", updated_at: Date.now() });
    }
    return null;
  },
});
