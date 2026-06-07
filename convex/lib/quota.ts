import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const FREE_QUICK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function freeQuickAvailable(user: Doc<"users">, now = Date.now()) {
  const consumedAt = user.free_quick_consumed_at;
  return consumedAt === undefined || consumedAt + FREE_QUICK_WINDOW_MS <= now;
}

export async function getEntitlementForUser(
  ctx: MutationCtx,
  userId: Doc<"users">["_id"],
) {
  return await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
}

export async function refundQuotaIfDebited(
  ctx: MutationCtx,
  order: Doc<"scanOrders">,
  now = Date.now(),
) {
  if (!order.quota_debit_kind || order.quota_refunded_at !== undefined) {
    return;
  }

  if (order.quota_debit_kind === "manual_credit") {
    const entitlement = await getEntitlementForUser(ctx, order.userId);
    if (entitlement) {
      await ctx.db.patch(entitlement._id, {
        scan_credits: entitlement.scan_credits + 1,
        updated_at: now,
      });
    }
  } else {
    const user = await ctx.db.get(order.userId);
    if (
      user &&
      order.quota_debited_at !== undefined &&
      user.free_quick_consumed_at === order.quota_debited_at
    ) {
      await ctx.db.patch(user._id, {
        free_quick_consumed_at: undefined,
        free_quick_consumed_count: Math.max(
          0,
          user.free_quick_consumed_count - 1,
        ),
        updated_at: now,
      });
    }
  }

  await ctx.db.patch(order._id, {
    quota_refunded_at: now,
    updated_at: now,
  });
}
