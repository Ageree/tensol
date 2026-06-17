import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  type MutationCtx,
  action,
  internalMutation,
  query,
} from "./_generated/server";
import { requireUser } from "./lib/auth";
import {
  BILLING_PRODUCTS,
  productByKey,
} from "./lib/billingCatalog";
import { getEntitlementForUser } from "./lib/quota";

const checkoutStatus = v.union(
  v.literal("new"),
  v.literal("waiting"),
  v.literal("pending"),
  v.literal("provider_created"),
  v.literal("paying"),
  v.literal("paid"),
  v.literal("manual_accept"),
  v.literal("underpaid"),
  v.literal("expired"),
  v.literal("refunding"),
  v.literal("refunded"),
  v.literal("failed"),
);

const productKey = v.union(
  v.literal("pr_review"),
  v.literal("starter"),
  v.literal("team"),
  v.literal("pro"),
);

function publicProduct(product: (typeof BILLING_PRODUCTS)[number]) {
  return {
    key: product.key,
    name: product.name,
    monthly_usd_cents: product.monthly_usd_cents,
    scan_credits: product.scan_credits,
    review_credits: product.review_credits,
    asset_limit: product.asset_limit,
    concurrent_tests: product.concurrent_tests,
    description: product.description,
    checkout_description: product.checkout_description,
    features: product.features,
  };
}

function normalizeReturnPath(value: string | undefined): string {
  if (!value) return "/billing?checkout=return";
  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/billing?checkout=return";
  }
  return value.slice(0, 240);
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function envBool(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(env(name));
}

function requireBillingEnv(name: string): string {
  const value = env(name);
  if (value === "") {
    throw new ConvexError({
      error: "billing_not_configured",
      message: `${name} is not configured`,
    });
  }
  return value;
}

function oxapayData(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object") return {};
  const root = payload as Record<string, unknown>;
  const data = root.data;
  return data !== null && typeof data === "object"
    ? (data as Record<string, unknown>)
    : root;
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null;
}

function numberField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function upsertEntitlementCredits(
  ctx: MutationCtx,
  userId: Id<"users">,
  scanCredits: number,
  reviewCredits: number,
  now: number,
) {
  const existing = await getEntitlementForUser(ctx, userId);
  if (existing) {
    await ctx.db.patch(existing._id, {
      scan_credits: existing.scan_credits + scanCredits,
      review_credits: (existing.review_credits ?? 0) + reviewCredits,
      updated_at: now,
    });
    return;
  }
  await ctx.db.insert("entitlements", {
    userId,
    scan_credits: scanCredits,
    review_credits: reviewCredits,
    manual_grant: false,
    created_at: now,
    updated_at: now,
  });
}

function isSettledStatus(status: string): boolean {
  return status === "paid" || status === "manual_accept";
}

export const listProducts = query({
  args: {},
  handler: async () => BILLING_PRODUCTS.map(publicProduct),
});

export const myBillingStatus = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireUser(ctx);
    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .first();
    const sessions = await ctx.db
      .query("billingCheckoutSessions")
      .withIndex("by_userId_and_created_at", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(10);
    return {
      scan_credits: entitlement?.scan_credits ?? 0,
      review_credits: entitlement?.review_credits ?? 0,
      checkout_sessions: sessions.map((session) => ({
        id: session._id,
        product_key: session.product_key,
        product_name: session.product_name,
        status: session.status,
        amount_usd_cents: session.amount_usd_cents,
        review_credits: session.review_credits ?? 0,
        provider_payment_url: session.provider_payment_url ?? null,
        provider_track_id: session.provider_track_id ?? null,
        created_at: session.created_at,
        updated_at: session.updated_at,
        paid_at: session.paid_at ?? null,
        expires_at: session.expires_at ?? null,
      })),
    };
  },
});

export const createCheckout = action({
  args: {
    product_key: productKey,
    return_path: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    session_id: Id<"billingCheckoutSessions">;
    payment_url: string;
    track_id: string;
    expires_at: number | null;
  }> => {
    const product = productByKey(args.product_key);
    if (!product) {
      throw new ConvexError({
        error: "invalid_product",
        message: "Unknown billing product",
      });
    }

    const prepared: {
      session_id: Id<"billingCheckoutSessions">;
      product_name: string;
      amount_usd_cents: number;
      scan_credits: number;
      review_credits: number;
      checkout_description: string;
      order_id: string;
      return_path: string;
    } = await ctx.runMutation(internal.billing.prepareCheckoutSession, {
      product_key: product.key,
      return_path: normalizeReturnPath(args.return_path),
    });

    const merchantKey = requireBillingEnv("OXAPAY_MERCHANT_API_KEY");
    const callbackUrl = requireBillingEnv("OXAPAY_CALLBACK_URL");
    const returnBaseUrl = requireBillingEnv("STHRIP_BILLING_RETURN_URL");
    const returnUrl = new URL(prepared.return_path, new URL(returnBaseUrl));
    returnUrl.searchParams.set("checkout", "return");
    returnUrl.searchParams.set("session", prepared.session_id);

    const response = await fetch("https://api.oxapay.com/v1/payment/invoice", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        merchant_api_key: merchantKey,
      },
      body: JSON.stringify({
        amount: prepared.amount_usd_cents / 100,
        currency: "USD",
        lifetime: 120,
        fee_paid_by_payer: 1,
        under_paid_coverage: 0,
        mixed_payment: true,
        callback_url: callbackUrl,
        return_url: returnUrl.toString(),
        order_id: prepared.order_id,
        thanks_message: "Payment received. Sthrip entitlements will appear shortly.",
        description: `${prepared.product_name} - ${prepared.checkout_description}`,
        sandbox: envBool("OXAPAY_SANDBOX"),
      }),
    });

    const payload = (await response.json().catch(() => null)) as unknown;
    const data = oxapayData(payload);
    const trackId = stringField(data, "track_id");
    const paymentUrl = stringField(data, "payment_url");
    const expiresAtSeconds = numberField(data, "expired_at");

    if (!response.ok || !trackId || !paymentUrl) {
      await ctx.runMutation(internal.billing.markCheckoutFailed, {
        session_id: prepared.session_id,
        error_message:
          payload === null
            ? `OxaPay HTTP ${response.status}`
            : JSON.stringify(payload).slice(0, 900),
      });
      throw new ConvexError({
        error: "oxapay_invoice_failed",
        message: "OxaPay invoice creation failed",
      });
    }

    await ctx.runMutation(internal.billing.recordCheckoutProvider, {
      session_id: prepared.session_id,
      provider_track_id: trackId,
      provider_payment_url: paymentUrl,
      expires_at:
        expiresAtSeconds === null ? undefined : Math.round(expiresAtSeconds * 1000),
      raw_provider_response: payload,
    });

    return {
      session_id: prepared.session_id,
      payment_url: paymentUrl,
      track_id: trackId,
      expires_at:
        expiresAtSeconds === null ? null : Math.round(expiresAtSeconds * 1000),
    };
  },
});

export const prepareCheckoutSession = internalMutation({
  args: {
    product_key: productKey,
    return_path: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const product = productByKey(args.product_key);
    if (!product) {
      throw new ConvexError({
        error: "invalid_product",
        message: "Unknown billing product",
      });
    }
    const now = Date.now();
    const sessionId = await ctx.db.insert("billingCheckoutSessions", {
      userId: user._id,
      provider: "oxapay",
      product_key: product.key,
      product_name: product.name,
      status: "pending",
      amount_usd_cents: product.monthly_usd_cents,
      currency: "USD",
      scan_credits: product.scan_credits,
      review_credits: product.review_credits,
      return_path: args.return_path,
      created_at: now,
      updated_at: now,
    });
    return {
      session_id: sessionId,
      product_name: product.name,
      amount_usd_cents: product.monthly_usd_cents,
      scan_credits: product.scan_credits,
      review_credits: product.review_credits,
      checkout_description: product.checkout_description,
      order_id: sessionId,
      return_path: args.return_path,
    };
  },
});

export const recordCheckoutProvider = internalMutation({
  args: {
    session_id: v.id("billingCheckoutSessions"),
    provider_track_id: v.string(),
    provider_payment_url: v.string(),
    expires_at: v.optional(v.number()),
    raw_provider_response: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.session_id, {
      status: "provider_created",
      provider_track_id: args.provider_track_id,
      provider_payment_url: args.provider_payment_url,
      raw_provider_response: args.raw_provider_response,
      expires_at: args.expires_at,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

export const markCheckoutFailed = internalMutation({
  args: {
    session_id: v.id("billingCheckoutSessions"),
    error_message: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.session_id, {
      status: "failed",
      last_error: args.error_message,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

export const fulfillOxaPayWebhook = internalMutation({
  args: {
    provider_track_id: v.string(),
    status: checkoutStatus,
    raw_payload: v.any(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("billingCheckoutSessions")
      .withIndex("by_provider_track_id", (q) =>
        q.eq("provider_track_id", args.provider_track_id),
      )
      .unique();
    if (!session) {
      throw new ConvexError({
        error: "checkout_not_found",
        message: "OxaPay checkout session not found",
      });
    }

    const now = Date.now();
    const isSettled = isSettledStatus(args.status);
    const alreadySettled =
      isSettledStatus(session.status) && session.paid_at !== undefined;
    if (isSettled && !alreadySettled) {
      await upsertEntitlementCredits(
        ctx,
        session.userId,
        session.scan_credits,
        session.review_credits ?? 0,
        now,
      );
    }

    await ctx.db.patch(session._id, {
      status: args.status,
      raw_webhook_payload: args.raw_payload,
      paid_at: isSettled ? session.paid_at ?? now : session.paid_at,
      updated_at: now,
    });

    await ctx.db.insert("auditEvents", {
      userId: session.userId,
      event: "billing_oxapay_webhook",
      outcome: isSettled ? "success" : "received",
      metadata: {
        provider_track_id: args.provider_track_id,
        status: args.status,
        product_key: session.product_key,
        scan_credits: session.scan_credits,
        review_credits: session.review_credits ?? 0,
        credited: isSettled && !alreadySettled,
      },
      created_at: now,
    });

    return {
      ok: true,
      credited: isSettled && !alreadySettled,
      status: args.status,
    };
  },
});
