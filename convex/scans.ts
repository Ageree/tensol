import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  type MutationCtx,
  type QueryCtx,
  mutation,
  query,
} from "./_generated/server";
import { requireUser } from "./lib/auth";
import { eventToWire, findingToWire, scanToWire } from "./lib/wire";

const MAX_SCAN_EVENTS = 500;
const MAX_FINDINGS_PER_SEVERITY = 200;

async function ownedScan(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  id: Id<"scans">,
) {
  const scan = await ctx.db.get(id);
  if (!scan || scan.userId !== userId) {
    throw new ConvexError({ error: "not_found", message: "scan not found" });
  }
  return scan;
}

export const get = query({
  args: { id: v.id("scans") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    return scanToWire(await ownedScan(ctx, user._id, args.id));
  },
});

export const getEvents = query({
  args: { id: v.id("scans"), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await ownedScan(ctx, user._id, args.id);
    const rows = await ctx.db
      .query("scanEvents")
      .withIndex("by_scan_id_and_created_at", (q) =>
        args.since === undefined
          ? q.eq("scan_id", args.id)
          : q.eq("scan_id", args.id).gt("created_at", args.since),
      )
      .order("asc")
      .take(MAX_SCAN_EVENTS);
    return rows.map(eventToWire);
  },
});

export const getFindings = query({
  args: { id: v.id("scans") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await ownedScan(ctx, user._id, args.id);
    const severities = ["critical", "high", "medium", "low", "informational"] as const;
    const rows = [];
    for (const severity of severities) {
      const severityRows = await ctx.db
        .query("findings")
        .withIndex("by_scan_id_and_severity_created_at", (q) =>
          q.eq("scan_id", args.id).eq("severity", severity),
        )
        .order("asc")
        .take(MAX_FINDINGS_PER_SEVERITY);
      rows.push(...severityRows);
    }
    return rows.map(findingToWire);
  },
});

export const getFindingDetail = query({
  args: { id: v.id("scans"), findingId: v.id("findings") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await ownedScan(ctx, user._id, args.id);
    const finding = await ctx.db.get(args.findingId);
    if (!finding || finding.scan_id !== args.id) {
      throw new ConvexError({ error: "not_found", message: "finding not found" });
    }
    return findingToWire(finding);
  },
});

export const getReport = query({
  args: { id: v.id("scans") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await ownedScan(ctx, user._id, args.id);
    const report = await ctx.db
      .query("reports")
      .withIndex("by_scan_id_and_updated_at", (q) => q.eq("scan_id", args.id))
      .order("desc")
      .first();
    if (!report) return { status: "pending" as const };
    return {
      status: report.status,
      download_url: report.download_url ?? null,
      download_expires_at: report.download_expires_at ?? null,
      byte_size: report.byte_size ?? null,
    };
  },
});

export const regenerateReport = mutation({
  args: { id: v.id("scans") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await ownedScan(ctx, user._id, args.id);
    const existing = await ctx.db
      .query("reports")
      .withIndex("by_scan_id_and_updated_at", (q) => q.eq("scan_id", args.id))
      .order("desc")
      .first();
    if (existing && (existing.status === "pending" || existing.status === "rendering")) {
      return { report_id: existing._id, job_id: existing._id };
    }
    const now = Date.now();
    const reportId = await ctx.db.insert("reports", {
      scan_id: args.id,
      status: "pending",
      created_at: now,
      updated_at: now,
    });
    return { report_id: reportId, job_id: reportId };
  },
});
