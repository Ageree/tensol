import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { orderToWire } from "./lib/wire";
import { requireUser } from "./lib/auth";

const DNS_VERIFY_WINDOW_MS = 30 * 60 * 1000;

export const getOwnedOrderForDns = internalQuery({
  args: { id: v.id("scanOrders") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const order = await ctx.db.get(args.id);
    if (!order || order.userId !== user._id) {
      throw new ConvexError({ error: "not_found", message: "scan order not found" });
    }
    return orderToWire(order);
  },
});

export const recordDnsCheck = internalMutation({
  args: {
    id: v.id("scanOrders"),
    verified: v.boolean(),
    lastError: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const order = await ctx.db.get(args.id);
    if (!order || order.userId !== user._id) {
      throw new ConvexError({ error: "not_found", message: "scan order not found" });
    }
    const attempts = order.dns_check_attempts + 1;
    const now = Date.now();
    if (order.status === "dns_verified") {
      return {
        verified: true,
        attempts,
        remaining_window_seconds: 0,
        last_error: args.lastError,
      };
    }
    if (order.status !== "dns_pending") {
      throw new ConvexError({
        error: "conflict",
        message: `cannot check DNS verification in status=${order.status}`,
      });
    }
    const requestedAt = order.dns_verify_requested_at ?? order.updated_at;
    const remainingMs = requestedAt + DNS_VERIFY_WINDOW_MS - now;
    if (args.verified) {
      await ctx.db.patch(order._id, {
        status: "dns_verified",
        dns_verified_at: now,
        dns_check_attempts: attempts,
        updated_at: now,
      });
    } else if (remainingMs <= 0) {
      await ctx.db.patch(order._id, {
        status: "failed",
        failure_reason: "dns_verification_expired",
        dns_check_attempts: attempts,
        updated_at: now,
      });
    } else {
      await ctx.db.patch(order._id, {
        dns_check_attempts: attempts,
        updated_at: now,
      });
    }
    return {
      verified: args.verified,
      attempts,
      remaining_window_seconds: Math.max(0, Math.ceil(remainingMs / 1000)),
      last_error:
        remainingMs <= 0 && !args.verified
          ? "dns verification window expired"
          : args.lastError,
    };
  },
});
