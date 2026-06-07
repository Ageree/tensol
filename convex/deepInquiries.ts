import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireUser } from "./lib/auth";

function redactSecrets(text: string) {
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[redacted-private-key]",
    )
    .replace(
      /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
      "[redacted-private-key]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[redacted-jwt]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, "Basic [redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]")
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_=-]{12,}\b/g, "[redacted-api-key]")
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[^"'\s,;]+/gi,
      "$1=[redacted]",
    )
    .trim()
    .slice(0, 12_000);
}

export const create = mutation({
  args: {
    company: v.string(),
    contact_name: v.string(),
    position: v.optional(v.union(v.string(), v.null())),
    email: v.optional(v.union(v.string(), v.null())),
    phone: v.string(),
    domains_text: v.string(),
    desired_date: v.optional(v.union(v.number(), v.null())),
    budget_band: v.optional(v.union(v.string(), v.null())),
    scope_text: v.string(),
    consent_accepted: v.literal(true),
  },
  handler: async (ctx, args) => {
    let userId = undefined;
    try {
      userId = (await requireUser(ctx)).user._id;
    } catch {
      userId = undefined;
    }
    const now = Date.now();
    const id = await ctx.db.insert("deepInquiries", {
      userId,
      company: args.company,
      contact_name: args.contact_name,
      position: args.position ?? undefined,
      email: args.email ?? undefined,
      phone: args.phone,
      domains_text: args.domains_text,
      desired_date: args.desired_date ?? undefined,
      budget_band: args.budget_band ?? undefined,
      scope_text: redactSecrets(args.scope_text),
      consent_accepted: true,
      status: "new",
      notification_attempts: 0,
      created_at: now,
      updated_at: now,
    });
    return { id };
  },
});
