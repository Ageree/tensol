import { query } from "./_generated/server";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();

    const now = Date.now();
    const consumedAt = user?.free_quick_consumed_at ?? null;
    const resetAt = consumedAt === null ? null : consumedAt + 7 * 24 * 60 * 60 * 1000;
    return {
      id: user?._id ?? identity.tokenIdentifier,
      email: user?.email || identity.email || "",
      convex_user_initialized: user != null,
      free_quick_available: resetAt === null || resetAt <= now,
      free_quick_resets_at: resetAt,
    };
  },
});
