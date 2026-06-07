import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

export type AuthUser = {
  identity: NonNullable<Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>>;
  user: Doc<"users">;
};

export async function requireIdentity(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      error: "unauthorized",
      message: "authentication required",
    });
  }
  return identity;
}

export async function requireUser(ctx: QueryCtx | MutationCtx): Promise<AuthUser> {
  const identity = await requireIdentity(ctx);
  const existing = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();

  if (existing) return { identity, user: existing };

  if (!("insert" in ctx.db)) {
    throw new ConvexError({
      error: "user_not_initialized",
      message: "user profile has not been initialized yet",
    });
  }

  const now = Date.now();
  const id = await ctx.db.insert("users", {
    tokenIdentifier: identity.tokenIdentifier,
    subject: identity.subject,
    issuer: identity.issuer,
    email: identity.email ?? "",
    name: identity.name,
    created_at: now,
    updated_at: now,
    free_quick_consumed_count: 0,
  });
  const created = await ctx.db.get(id);
  if (!created) throw new Error("created user vanished");
  await ctx.db.insert("entitlements", {
    userId: id,
    scan_credits: 1,
    manual_grant: true,
    created_at: now,
    updated_at: now,
  });
  return { identity, user: created };
}

export async function currentUserOrNull(
  ctx: QueryCtx,
): Promise<AuthUser | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
  return user ? { identity, user } : null;
}
