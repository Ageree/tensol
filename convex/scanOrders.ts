import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { currentUserOrNull, requireUser } from "./lib/auth";
import {
  freeQuickAvailable,
  getEntitlementForUser,
  refundQuotaIfDebited,
} from "./lib/quota";
import { orderToWire } from "./lib/wire";

const DNS_VERIFY_WINDOW_MS = 30 * 60 * 1000;
const PUBLIC_HOSTNAME_REGEX =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

const attackSurfaceEntry = v.object({
  domain: v.string(),
  primary: v.boolean(),
  headers: v.array(v.object({ k: v.string(), v: v.string() })),
});

type AttackSurfaceEntry = {
  domain: string;
  primary: boolean;
  headers: Array<{ k: string; v: string }>;
};

function normalizePublicHostname(value: string, field: string) {
  const hostname = value.trim().toLowerCase();
  if (
    hostname.length < 1 ||
    hostname.length > 253 ||
    !PUBLIC_HOSTNAME_REGEX.test(hostname)
  ) {
    throw new ConvexError({
      error: "validation_error",
      message: `${field} must be a public lowercase DNS hostname`,
    });
  }
  return hostname;
}

function normalizeAttackSurface(entries: AttackSurfaceEntry[]) {
  return entries.map((entry, index) => ({
    ...entry,
    domain: normalizePublicHostname(
      entry.domain,
      `attack_surface[${index}].domain`,
    ),
  }));
}

function tokenFor(host: string) {
  const clean = host.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `sthrip-${clean}-${rand}`;
}

async function ownedOrder(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  id: Id<"scanOrders">,
) {
  const order = await ctx.db.get(id);
  if (!order || order.userId !== userId) {
    throw new ConvexError({
      error: "not_found",
      message: "scan order not found",
    });
  }
  return order;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const auth = await currentUserOrNull(ctx);
    if (!auth) return [];
    const rows = await ctx.db
      .query("scanOrders")
      .withIndex("by_userId_and_created_at", (q) =>
        q.eq("userId", auth.user._id),
      )
      .order("desc")
      .take(100);
    return rows.map(orderToWire);
  },
});

export const create = mutation({
  args: {
    tier: v.literal("quick"),
    primary_domain: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const now = Date.now();
    const primaryDomain = normalizePublicHostname(
      args.primary_domain,
      "primary_domain",
    );
    const id = await ctx.db.insert("scanOrders", {
      userId: user._id,
      status: "draft",
      tier: args.tier,
      primary_domain: primaryDomain,
      attack_surface: [],
      safety_rps: 50,
      dns_verify_token: tokenFor(primaryDomain),
      dns_check_attempts: 0,
      vps_provider: "gcp",
      payment_kind: "free_quick",
      created_at: now,
      updated_at: now,
    });
    await ctx.db.insert("auditEvents", {
      userId: user._id,
      scan_order_id: id,
      event: "scan_order_created",
      outcome: "success",
      metadata: { primary_domain: primaryDomain, tier: args.tier },
      created_at: now,
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error("created order vanished");
    return orderToWire(row);
  },
});

export const get = query({
  args: { id: v.id("scanOrders") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    return orderToWire(await ownedOrder(ctx, user._id, args.id));
  },
});

export const updateAttackSurface = mutation({
  args: {
    id: v.id("scanOrders"),
    attack_surface: v.array(attackSurfaceEntry),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const order = await ownedOrder(ctx, user._id, args.id);
    if (order.status !== "draft") {
      throw new ConvexError({
        error: "conflict",
        message: `cannot update attack_surface in status=${order.status}`,
      });
    }
    const now = Date.now();
    const attackSurface = normalizeAttackSurface(args.attack_surface);
    await ctx.db.patch(order._id, {
      attack_surface: attackSurface,
      updated_at: now,
    });
    const row = await ctx.db.get(order._id);
    if (!row) throw new Error("order vanished");
    return orderToWire(row);
  },
});

export const updateSafety = mutation({
  args: {
    id: v.id("scanOrders"),
    safety_rps: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const order = await ownedOrder(ctx, user._id, args.id);
    if (order.status !== "draft") {
      throw new ConvexError({
        error: "conflict",
        message: `cannot update safety in status=${order.status}`,
      });
    }
    const now = Date.now();
    await ctx.db.patch(order._id, {
      safety_rps: args.safety_rps,
      updated_at: now,
    });
    const row = await ctx.db.get(order._id);
    if (!row) throw new Error("order vanished");
    return orderToWire(row);
  },
});

export const requestDnsVerify = mutation({
  args: { id: v.id("scanOrders") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const order = await ownedOrder(ctx, user._id, args.id);
    if (order.status !== "draft" && order.status !== "dns_pending") {
      throw new ConvexError({
        error: "conflict",
        message: `cannot request DNS verification in status=${order.status}`,
      });
    }
    const now = Date.now();
    const requestedAt = order.dns_verify_requested_at ?? now;
    if (
      order.status === "dns_pending" &&
      requestedAt + DNS_VERIFY_WINDOW_MS <= now
    ) {
      await ctx.db.patch(order._id, {
        status: "failed",
        failure_reason: "dns_verification_expired",
        updated_at: now,
      });
      throw new ConvexError({
        error: "conflict",
        message: "DNS verification window expired; create a new scan order",
      });
    }
    await ctx.db.patch(order._id, {
      status: "dns_pending",
      dns_verify_requested_at: requestedAt,
      updated_at: now,
    });
    return {
      token: order.dns_verify_token,
      instructions: {
        record_type: "TXT" as const,
        record_name: `_sthrip.${order.primary_domain}`,
        record_value: order.dns_verify_token,
        ttl_hint: 300,
      },
    };
  },
});

export const checkDnsVerify = action({
  args: { id: v.id("scanOrders") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    verified: boolean;
    attempts: number;
    remaining_window_seconds: number;
    last_error?: string | null;
  }> => {
    const order: ReturnType<typeof orderToWire> = await ctx.runQuery(
      internal.scanOrdersInternal.getOwnedOrderForDns,
      { id: args.id },
    );
    const url = new URL("https://dns.google/resolve");
    url.searchParams.set("name", `_sthrip.${order.primary_domain}`);
    url.searchParams.set("type", "TXT");
    let verified = false;
    let lastError: string | null = null;
    try {
      const res = await fetch(url.toString());
      const body = (await res.json()) as { Answer?: Array<{ data?: string }> };
      const values = (body.Answer ?? []).map((a) =>
        (a.data ?? "").replace(/^"|"$/g, ""),
      );
      verified = values.some((value) =>
        value.includes(order.dns_verify_token ?? ""),
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : "dns_lookup_failed";
    }
    return await ctx.runMutation(internal.scanOrdersInternal.recordDnsCheck, {
      id: args.id,
      verified,
      lastError,
    });
  },
});

export const launch = mutation({
  args: { id: v.id("scanOrders") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const order = await ownedOrder(ctx, user._id, args.id);
    if (order.status !== "dns_verified") {
      throw new ConvexError({
        error: "conflict",
        message: `cannot launch in status=${order.status}`,
      });
    }
    const now = Date.now();
    const entitlement = await getEntitlementForUser(ctx, user._id);
    const hasFreeQuick = freeQuickAvailable(user, now);
    const hasManualCredit = (entitlement?.scan_credits ?? 0) > 0;
    if (!hasFreeQuick && !hasManualCredit) {
      throw new ConvexError({
        error: "free_quota_exhausted",
        message: "no scan credits available",
        retry_after_seconds:
          user.free_quick_consumed_at === undefined
            ? null
            : Math.max(
                1,
                Math.ceil(
                  (user.free_quick_consumed_at + 7 * 24 * 60 * 60 * 1000 - now) /
                    1000,
                ),
              ),
      });
    }
    const quotaDebitKind = hasFreeQuick ? "free_quick" : "manual_credit";
    const scanId = await ctx.db.insert("scans", {
      userId: user._id,
      scan_order_id: order._id,
      profile: order.tier === "quick" ? "recon" : "standard",
      status: "queued",
      started_at: now,
    });
    await ctx.db.patch(order._id, {
      status: "vm_provisioning",
      scan_id: scanId,
      quota_debit_kind: quotaDebitKind,
      quota_debited_at: now,
      updated_at: now,
    });
    if (quotaDebitKind === "free_quick") {
      await ctx.db.patch(user._id, {
        free_quick_consumed_at: now,
        free_quick_consumed_count: user.free_quick_consumed_count + 1,
        updated_at: now,
      });
    } else if (entitlement) {
      await ctx.db.patch(entitlement._id, {
        scan_credits: entitlement.scan_credits - 1,
        updated_at: now,
      });
    }
    await ctx.db.insert("scanEvents", {
      scan_id: scanId,
      event_type: "vm_provisioning",
      payload: { provider: "gcp" },
      created_at: now,
    });
    await ctx.scheduler.runAfter(0, internal.gcloud.provisionScanVm, { scanId });
    return { scan_id: scanId };
  },
});

export const cancel = mutation({
  args: { id: v.id("scanOrders") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const order = await ownedOrder(ctx, user._id, args.id);
    if (["completed", "failed", "cancelled"].includes(order.status)) {
      throw new ConvexError({
        error: "conflict",
        message: `cannot cancel terminal order status=${order.status}`,
      });
    }
    const now = Date.now();
    await refundQuotaIfDebited(ctx, order, now);
    await ctx.db.patch(order._id, {
      status: "cancelled",
      cancelled_at: now,
      updated_at: now,
    });
    if (order.scan_id) {
      await ctx.db.patch(order.scan_id, {
        status: "cancelled",
        completed_at: now,
      });
      await ctx.scheduler.runAfter(0, internal.gcloud.teardownScanVm, {
        scanId: order.scan_id,
      });
    }
    const row = await ctx.db.get(order._id);
    if (!row) throw new Error("order vanished");
    return orderToWire(row);
  },
});
