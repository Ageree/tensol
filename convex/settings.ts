import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { requireIdentity, requireUser } from "./lib/auth";

const DEFAULT_SLA_THRESHOLDS = {
  critical_days: 7,
  critical_target: 95,
  high_days: 30,
  high_target: 95,
  medium_days: 90,
  medium_target: 90,
  low_days: 120,
  low_target: 90,
};

const SLA_VALIDATOR = v.object({
  critical_days: v.number(),
  critical_target: v.number(),
  high_days: v.number(),
  high_target: v.number(),
  medium_days: v.number(),
  medium_target: v.number(),
  low_days: v.number(),
  low_target: v.number(),
});

function slugFrom(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return normalized.length >= 3 ? normalized : "sthrip";
}

function assertSlug(slug: string): string {
  const clean = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{3,50}$/.test(clean)) {
    throw new ConvexError({
      error: "invalid_slug",
      message: "URL slug must be 3-50 lowercase letters, numbers, or hyphens",
    });
  }
  return clean;
}

function assertPercent(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConvexError({
      error: "invalid_threshold",
      message: `${name} must be between 0 and 100`,
    });
  }
  return Math.round(value);
}

function assertDays(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1 || value > 3650) {
    throw new ConvexError({
      error: "invalid_threshold",
      message: `${name} must be between 1 and 3650 days`,
    });
  }
  return Math.round(value);
}

function normalizeSlaThresholds(values: typeof DEFAULT_SLA_THRESHOLDS) {
  return {
    critical_days: assertDays(values.critical_days, "critical days"),
    critical_target: assertPercent(values.critical_target, "critical target"),
    high_days: assertDays(values.high_days, "high days"),
    high_target: assertPercent(values.high_target, "high target"),
    medium_days: assertDays(values.medium_days, "medium days"),
    medium_target: assertPercent(values.medium_target, "medium target"),
    low_days: assertDays(values.low_days, "low days"),
    low_target: assertPercent(values.low_target, "low target"),
  };
}

async function uniqueSlugForUser(
  ctx: MutationCtx,
  slug: string,
  userId: Id<"users">,
) {
  const existing = await ctx.db
    .query("userSettings")
    .withIndex("by_url_slug", (q) => q.eq("url_slug", slug))
    .unique();
  if (existing && existing.userId !== userId) {
    throw new ConvexError({
      error: "slug_taken",
      message: "URL slug is already in use",
    });
  }
}

async function getSettingsRow(ctx: MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("userSettings")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

async function upsertSettings(
  ctx: MutationCtx,
  userId: Id<"users">,
  fields: {
    organization_name: string;
    url_slug: string;
    sla_thresholds: typeof DEFAULT_SLA_THRESHOLDS;
    security_score_min: number;
  },
) {
  const now = Date.now();
  const existing = await getSettingsRow(ctx, userId);
  if (existing) {
    await ctx.db.patch(existing._id, { ...fields, updated_at: now });
    return existing._id;
  }
  return await ctx.db.insert("userSettings", {
    userId,
    ...fields,
    created_at: now,
    updated_at: now,
  });
}

export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    const row = user
      ? await ctx.db
          .query("userSettings")
          .withIndex("by_userId", (q) => q.eq("userId", user._id))
          .unique()
      : null;
    const fallbackName =
      row?.organization_name ??
      identity.name ??
      identity.nickname ??
      identity.email?.split("@")[0] ??
      "sthrip";
    return {
      organization_name: fallbackName,
      url_slug: row?.url_slug ?? slugFrom(fallbackName),
      sla_thresholds: row?.sla_thresholds ?? DEFAULT_SLA_THRESHOLDS,
      security_score_min: row?.security_score_min ?? 70,
      updated_at: row?.updated_at ?? null,
    };
  },
});

export const updateGeneral = mutation({
  args: {
    organization_name: v.string(),
    url_slug: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const organizationName = args.organization_name.trim();
    if (organizationName.length < 1 || organizationName.length > 80) {
      throw new ConvexError({
        error: "invalid_organization_name",
        message: "Organization name is required and must be 80 characters or less",
      });
    }
    const urlSlug = assertSlug(args.url_slug);
    await uniqueSlugForUser(ctx, urlSlug, user._id);
    const existing = await getSettingsRow(ctx, user._id);
    await upsertSettings(ctx, user._id, {
      organization_name: organizationName,
      url_slug: urlSlug,
      sla_thresholds: existing?.sla_thresholds ?? DEFAULT_SLA_THRESHOLDS,
      security_score_min: existing?.security_score_min ?? 70,
    });
    return { ok: true };
  },
});

export const updateSlaThresholds = mutation({
  args: { sla_thresholds: SLA_VALIDATOR },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const existing = await getSettingsRow(ctx, user._id);
    const organizationName = existing?.organization_name ?? user.email.split("@")[0] ?? "sthrip";
    await upsertSettings(ctx, user._id, {
      organization_name: organizationName,
      url_slug: existing?.url_slug ?? slugFrom(organizationName),
      sla_thresholds: normalizeSlaThresholds(args.sla_thresholds),
      security_score_min: existing?.security_score_min ?? 70,
    });
    return { ok: true };
  },
});

export const updateSecurityScore = mutation({
  args: { security_score_min: v.number() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const score = assertPercent(args.security_score_min, "security score");
    const existing = await getSettingsRow(ctx, user._id);
    const organizationName = existing?.organization_name ?? user.email.split("@")[0] ?? "sthrip";
    await upsertSettings(ctx, user._id, {
      organization_name: organizationName,
      url_slug: existing?.url_slug ?? slugFrom(organizationName),
      sla_thresholds: existing?.sla_thresholds ?? DEFAULT_SLA_THRESHOLDS,
      security_score_min: score,
    });
    return { ok: true };
  },
});
