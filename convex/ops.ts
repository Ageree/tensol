import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { refundQuotaIfDebited } from "./lib/quota";

const findingInput = v.object({
  external_id: v.optional(v.string()),
  severity: v.optional(v.union(v.literal("critical"), v.literal("high"), v.literal("medium"), v.literal("low"), v.literal("informational"))),
  title: v.string(),
  target: v.optional(v.string()),
  body_md: v.optional(v.string()),
  evidence_keys: v.optional(v.array(v.string())),
  cwe: v.optional(v.array(v.string())),
  mitre: v.optional(v.array(v.string())),
  confidence: v.optional(v.union(v.literal("verified"), v.literal("high"), v.literal("medium"), v.literal("low"))),
});

export const markVmRunning = internalMutation({
  args: {
    scanId: v.id("scans"),
    provider: v.union(v.literal("gcp"), v.literal("dry_run")),
    providerServerId: v.string(),
    publicIp: v.optional(v.string()),
    zone: v.optional(v.string()),
    operationId: v.optional(v.string()),
    signKey: v.string(),
  },
  handler: async (ctx, args) => {
    const scan = await ctx.db.get(args.scanId);
    if (!scan) throw new ConvexError({ error: "not_found", message: "scan not found" });
    const order = await ctx.db.get(scan.scan_order_id);
    if (!order) throw new ConvexError({ error: "not_found", message: "scan order not found" });
    const now = Date.now();
    const shouldTearDownImmediately =
      scan.status !== "queued" || order.status !== "vm_provisioning";
    const vpsId = await ctx.db.insert("vpsInstances", {
      scan_id: args.scanId,
      provider: args.provider,
      provider_server_id: args.providerServerId,
      ipv4: args.publicIp,
      status: shouldTearDownImmediately ? "tearing_down" : "alive",
      sign_key: args.signKey,
      zone: args.zone,
      operation_id: args.operationId,
      created_at: now,
      updated_at: now,
    });
    if (shouldTearDownImmediately) {
      await ctx.scheduler.runAfter(0, internal.gcloud.teardownScanVm, {
        scanId: args.scanId,
      });
      return vpsId;
    }
    await ctx.db.patch(scan._id, { status: "running" });
    await ctx.db.patch(order._id, {
      status: "running",
      vps_instance_id: vpsId,
      vps_provider: args.provider,
      vps_zone: args.zone,
      updated_at: now,
    });
    await ctx.db.insert("scanEvents", {
      scan_id: args.scanId,
      event_type: "vm_ready",
      payload: { provider: args.provider, provider_server_id: args.providerServerId, public_ip: args.publicIp ?? null },
      created_at: now,
    });
    await ctx.db.insert("scanEvents", {
      scan_id: args.scanId,
      event_type: "agent_started",
      payload: { transport: args.provider === "dry_run" ? "convex-dry-run" : "gcp-vps-agent" },
      created_at: now + 1,
    });
    return vpsId;
  },
});

export const failScan = internalMutation({
  args: {
    scanId: v.id("scans"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const scan = await ctx.db.get(args.scanId);
    if (!scan) return null;
    const order = await ctx.db.get(scan.scan_order_id);
    const now = Date.now();
    if (["completed", "failed", "cancelled"].includes(scan.status)) {
      return null;
    }
    await ctx.db.patch(scan._id, {
      status: "failed",
      failure_reason: args.reason,
      completed_at: now,
    });
    if (order) {
      await refundQuotaIfDebited(ctx, order, now);
      await ctx.db.patch(order._id, {
        status: "failed",
        failure_reason: args.reason,
        updated_at: now,
      });
    }
    await ctx.db.insert("scanEvents", {
      scan_id: args.scanId,
      event_type: "scan_failed",
      payload: { reason: args.reason },
      created_at: now,
    });
    return null;
  },
});

export const completeScan = internalMutation({
  args: {
    scanId: v.id("scans"),
    findings: v.array(findingInput),
    usageTokens: v.optional(v.number()),
    usageUsdCents: v.optional(v.number()),
    reportUrl: v.optional(v.string()),
    dedupKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scan = await ctx.db.get(args.scanId);
    if (!scan) throw new ConvexError({ error: "not_found", message: "scan not found" });
    const order = await ctx.db.get(scan.scan_order_id);
    if (!order) throw new ConvexError({ error: "not_found", message: "scan order not found" });
    const now = Date.now();
    const dedupKey = args.dedupKey;
    if (dedupKey) {
      const existing = await ctx.db
        .query("webhookDedup")
        .withIndex("by_webhook_kind_and_dedup_key", (q) =>
          q.eq("webhook_kind", "scan_complete").eq("dedup_key", dedupKey),
        )
        .first();
      if (existing) return { status: "duplicate" as const };
      await ctx.db.insert("webhookDedup", {
        webhook_kind: "scan_complete",
        dedup_key: dedupKey,
        received_at: now,
        metadata: { scan_id: args.scanId },
      });
    }
    if (
      ["completed", "failed", "cancelled"].includes(scan.status) ||
      ["completed", "failed", "cancelled"].includes(order.status)
    ) {
      return { status: "ignored_terminal" as const };
    }
    let count = 0;
    for (const f of args.findings) {
      count += 1;
      await ctx.db.insert("findings", {
        scan_id: args.scanId,
        external_id: f.external_id ?? `finding-${count}`,
        severity: f.severity ?? "medium",
        title: f.title,
        target: f.target ?? order.primary_domain,
        cwe: f.cwe ?? [],
        mitre: f.mitre ?? [],
        confidence: f.confidence ?? "high",
        body_md: f.body_md ?? "Finding produced by the Convex scan pipeline.",
        evidence_keys: f.evidence_keys ?? [],
        discovered_at: now,
        created_at: now + count,
      });
      await ctx.db.insert("scanEvents", {
        scan_id: args.scanId,
        event_type: "finding_detected",
        payload: { severity: f.severity ?? "medium", title: f.title },
        created_at: now + count,
      });
    }
    await ctx.db.patch(scan._id, {
      status: "completed",
      completed_at: now + 10,
      usage_tokens: args.usageTokens ?? 0,
      usage_usd_cents: args.usageUsdCents ?? 0,
    });
    await ctx.db.patch(order._id, {
      status: "completed",
      updated_at: now + 10,
    });
    await ctx.db.insert("scanEvents", {
      scan_id: args.scanId,
      event_type: "scan_completed",
      payload: { findings_count: count },
      created_at: now + 10,
    });
    if (args.reportUrl) {
      await ctx.db.insert("reports", {
        scan_id: args.scanId,
        status: "ready",
        download_url: args.reportUrl,
        download_expires_at: now + 24 * 60 * 60 * 1000,
        created_at: now,
        updated_at: now + 10,
      });
    } else {
      await ctx.db.insert("reports", {
        scan_id: args.scanId,
        status: "pending",
        created_at: now,
        updated_at: now + 10,
      });
    }
    return { status: "completed" as const };
  },
});

export const getWebhookVerificationMaterial = internalQuery({
  args: { scanId: v.id("scans") },
  handler: async (ctx, args) => {
    const scan = await ctx.db.get(args.scanId);
    if (!scan) {
      throw new ConvexError({ error: "not_found", message: "scan not found" });
    }
    const vps = await ctx.db
      .query("vpsInstances")
      .withIndex("by_scan_id", (q) => q.eq("scan_id", args.scanId))
      .order("desc")
      .first();
    if (!vps || vps.status === "failed") {
      throw new ConvexError({
        error: "conflict",
        message: "scan does not have a usable VPS signing key",
      });
    }
    return {
      signKey: vps.sign_key,
      scanStatus: scan.status,
      vpsStatus: vps.status,
    };
  },
});

export const markReportReady = internalMutation({
  args: {
    reportId: v.id("reports"),
    downloadUrl: v.string(),
    downloadExpiresAt: v.optional(v.number()),
    byteSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const report = await ctx.db.get(args.reportId);
    if (!report) return null;
    const now = Date.now();
    const patch = {
      status: "ready",
      download_url: args.downloadUrl,
      updated_at: now,
      ...(args.downloadExpiresAt === undefined
        ? {}
        : { download_expires_at: args.downloadExpiresAt }),
      ...(args.byteSize === undefined ? {} : { byte_size: args.byteSize }),
    } as const;
    await ctx.db.patch(report._id, patch);
    return null;
  },
});

export const markVpsDestroyed = internalMutation({
  args: {
    scanId: v.id("scans"),
  },
  handler: async (ctx, args) => {
    const vps = await ctx.db
      .query("vpsInstances")
      .withIndex("by_scan_id", (q) => q.eq("scan_id", args.scanId))
      .order("desc")
      .first();
    if (!vps) return null;
    if (vps.status === "destroyed") return null;
    const now = Date.now();
    await ctx.db.patch(vps._id, { status: "destroyed", updated_at: now });
    await ctx.db.insert("scanEvents", {
      scan_id: args.scanId,
      event_type: "vm_teardown",
      payload: { provider: vps.provider, provider_server_id: vps.provider_server_id },
      created_at: now,
    });
    return null;
  },
});

export const beginVpsTeardown = internalMutation({
  args: {
    scanId: v.id("scans"),
  },
  handler: async (ctx, args) => {
    const vps = await ctx.db
      .query("vpsInstances")
      .withIndex("by_scan_id", (q) => q.eq("scan_id", args.scanId))
      .order("desc")
      .first();
    if (!vps) return null;
    if (vps.status === "destroyed") {
      return { status: "already_destroyed" as const };
    }
    const now = Date.now();
    await ctx.db.patch(vps._id, { status: "tearing_down", updated_at: now });
    return {
      status: "tearing_down" as const,
      provider: vps.provider,
      providerServerId: vps.provider_server_id,
      zone: vps.zone,
    };
  },
});

export const markVpsTeardownFailed = internalMutation({
  args: {
    scanId: v.id("scans"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const vps = await ctx.db
      .query("vpsInstances")
      .withIndex("by_scan_id", (q) => q.eq("scan_id", args.scanId))
      .order("desc")
      .first();
    if (!vps) return null;
    const now = Date.now();
    await ctx.db.patch(vps._id, { status: "failed", updated_at: now });
    await ctx.db.insert("scanEvents", {
      scan_id: args.scanId,
      event_type: "vm_teardown",
      payload: {
        provider: vps.provider,
        provider_server_id: vps.provider_server_id,
        status: "failed",
        reason: args.reason,
      },
      created_at: now,
    });
    return null;
  },
});
