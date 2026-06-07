import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

function tokenMeta(row: {
  _id: string;
  name: string;
  token_prefix: string;
  created_at: number;
  last_used_at?: number;
  revoked_at?: number;
}) {
  return {
    id: row._id,
    name: row.name,
    token_prefix: row.token_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    revoked_at: row.revoked_at ?? null,
  };
}

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const token = `sthrip_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    const now = Date.now();
    const id = await ctx.db.insert("agentTokens", {
      userId: user._id,
      name: args.name,
      token_prefix: token.slice(0, 16),
      token_hash_hint: token.slice(-12),
      created_at: now,
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error("created token vanished");
    return { token, token_meta: tokenMeta(row) };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireUser(ctx);
    const rows = await ctx.db
      .query("agentTokens")
      .withIndex("by_userId_and_created_at", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
    return { tokens: rows.map(tokenMeta) };
  },
});

export const revoke = mutation({
  args: { id: v.id("agentTokens") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== user._id) {
      throw new ConvexError({ error: "not_found", message: "token not found" });
    }
    await ctx.db.patch(row._id, { revoked_at: Date.now() });
    return { revoked: true };
  },
});
