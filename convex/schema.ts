import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const scanOrderStatus = v.union(
  v.literal("draft"),
  v.literal("dns_pending"),
  v.literal("dns_verified"),
  v.literal("vm_provisioning"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const scanStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const scanEventType = v.union(
  v.literal("vm_provisioning"),
  v.literal("vm_ready"),
  v.literal("vm_teardown"),
  v.literal("agent_started"),
  v.literal("agent_phase_changed"),
  v.literal("finding_detected"),
  v.literal("scan_completed"),
  v.literal("scan_failed"),
);

const severity = v.union(
  v.literal("critical"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
  v.literal("informational"),
);

const attackSurfaceEntry = v.object({
  domain: v.string(),
  primary: v.boolean(),
  headers: v.array(v.object({ k: v.string(), v: v.string() })),
});

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    subject: v.optional(v.string()),
    issuer: v.optional(v.string()),
    email: v.string(),
    name: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    free_quick_consumed_at: v.optional(v.number()),
    free_quick_consumed_count: v.number(),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_email", ["email"]),

  entitlements: defineTable({
    userId: v.id("users"),
    scan_credits: v.number(),
    review_credits: v.optional(v.number()),
    manual_grant: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_userId", ["userId"]),

  billingCheckoutSessions: defineTable({
    userId: v.id("users"),
    provider: v.literal("oxapay"),
    product_key: v.union(
      v.literal("pr_review"),
      v.literal("starter"),
      v.literal("team"),
      v.literal("pro"),
    ),
    product_name: v.string(),
    status: v.union(
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
    ),
    amount_usd_cents: v.number(),
    currency: v.literal("USD"),
    scan_credits: v.number(),
    review_credits: v.optional(v.number()),
    return_path: v.string(),
    provider_track_id: v.optional(v.string()),
    provider_payment_url: v.optional(v.string()),
    raw_provider_response: v.optional(v.any()),
    raw_webhook_payload: v.optional(v.any()),
    expires_at: v.optional(v.number()),
    paid_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_userId_and_created_at", ["userId", "created_at"])
    .index("by_provider_track_id", ["provider_track_id"]),

  scanOrders: defineTable({
    userId: v.id("users"),
    status: scanOrderStatus,
    tier: v.union(v.literal("quick"), v.literal("deep")),
    primary_domain: v.string(),
    attack_surface: v.array(attackSurfaceEntry),
    safety_rps: v.number(),
    dns_verify_token: v.string(),
    dns_verify_requested_at: v.optional(v.number()),
    dns_verified_at: v.optional(v.number()),
    dns_check_attempts: v.number(),
    vps_instance_id: v.optional(v.id("vpsInstances")),
    vps_provider: v.union(v.literal("gcp"), v.literal("dry_run")),
    vps_zone: v.optional(v.string()),
    scan_id: v.optional(v.id("scans")),
    failure_reason: v.optional(v.string()),
    cancelled_at: v.optional(v.number()),
    payment_kind: v.union(v.literal("free_quick"), v.literal("manual_credit")),
    quota_debit_kind: v.optional(v.union(v.literal("free_quick"), v.literal("manual_credit"))),
    quota_debited_at: v.optional(v.number()),
    quota_refunded_at: v.optional(v.number()),
    amount_kopecks: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_userId_and_created_at", ["userId", "created_at"])
    .index("by_status_and_updated_at", ["status", "updated_at"])
    .index("by_scan_id", ["scan_id"]),

  scans: defineTable({
    userId: v.id("users"),
    scan_order_id: v.id("scanOrders"),
    profile: v.union(v.literal("recon"), v.literal("standard"), v.literal("max")),
    status: scanStatus,
    failure_reason: v.optional(v.string()),
    started_at: v.number(),
    completed_at: v.optional(v.number()),
    usage_tokens: v.optional(v.number()),
    usage_usd_cents: v.optional(v.number()),
  })
    .index("by_userId_and_started_at", ["userId", "started_at"])
    .index("by_scan_order_id", ["scan_order_id"])
    .index("by_status", ["status"]),

  scanEvents: defineTable({
    scan_id: v.id("scans"),
    event_type: scanEventType,
    payload: v.optional(v.any()),
    created_at: v.number(),
  }).index("by_scan_id_and_created_at", ["scan_id", "created_at"]),

  findings: defineTable({
    scan_id: v.id("scans"),
    external_id: v.string(),
    severity,
    title: v.string(),
    target: v.string(),
    cvss_score: v.optional(v.number()),
    cvss_vector: v.optional(v.string()),
    cvss_version: v.optional(v.string()),
    cwe: v.array(v.string()),
    mitre: v.array(v.string()),
    confidence: v.optional(v.union(v.literal("verified"), v.literal("high"), v.literal("medium"), v.literal("low"))),
    phase: v.optional(v.string()),
    agent: v.optional(v.string()),
    body_md: v.string(),
    evidence_keys: v.array(v.string()),
    discovered_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_scan_id_and_created_at", ["scan_id", "created_at"])
    .index("by_scan_id_and_severity", ["scan_id", "severity"])
    .index("by_scan_id_and_severity_created_at", ["scan_id", "severity", "created_at"]),

  reports: defineTable({
    scan_id: v.id("scans"),
    status: v.union(v.literal("pending"), v.literal("rendering"), v.literal("ready"), v.literal("failed")),
    download_url: v.optional(v.string()),
    download_expires_at: v.optional(v.number()),
    byte_size: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_scan_id_and_updated_at", ["scan_id", "updated_at"])
    .index("by_status_and_updated_at", ["status", "updated_at"]),

  vpsInstances: defineTable({
    scan_id: v.id("scans"),
    provider: v.union(v.literal("gcp"), v.literal("dry_run")),
    provider_server_id: v.string(),
    ipv4: v.optional(v.string()),
    status: v.union(v.literal("provisioning"), v.literal("alive"), v.literal("tearing_down"), v.literal("destroyed"), v.literal("failed")),
    sign_key: v.string(),
    zone: v.optional(v.string()),
    operation_id: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_scan_id", ["scan_id"])
    .index("by_status_and_updated_at", ["status", "updated_at"]),

  jobs: defineTable({
    type: v.string(),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("failed")),
    payload: v.any(),
    attempts: v.number(),
    last_error: v.optional(v.string()),
    scheduled_at: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_status_and_scheduled_at", ["status", "scheduled_at"]),

  webhookDedup: defineTable({
    webhook_kind: v.string(),
    dedup_key: v.string(),
    received_at: v.number(),
    metadata: v.optional(v.any()),
  }).index("by_webhook_kind_and_dedup_key", ["webhook_kind", "dedup_key"]),

  deepInquiries: defineTable({
    userId: v.optional(v.id("users")),
    company: v.string(),
    contact_name: v.string(),
    position: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.string(),
    domains_text: v.string(),
    desired_date: v.optional(v.number()),
    budget_band: v.optional(v.string()),
    scope_text: v.string(),
    consent_accepted: v.boolean(),
    status: v.union(v.literal("new"), v.literal("contacted"), v.literal("converted"), v.literal("closed")),
    notification_attempts: v.number(),
    notified_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_userId_and_created_at", ["userId", "created_at"]),

  userSettings: defineTable({
    userId: v.id("users"),
    organization_name: v.string(),
    url_slug: v.string(),
    sla_thresholds: v.object({
      critical_days: v.number(),
      critical_target: v.number(),
      high_days: v.number(),
      high_target: v.number(),
      medium_days: v.number(),
      medium_target: v.number(),
      low_days: v.number(),
      low_target: v.number(),
    }),
    security_score_min: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_url_slug", ["url_slug"]),

  agentTokens: defineTable({
    userId: v.id("users"),
    name: v.string(),
    token_prefix: v.string(),
    token_hash_hint: v.string(),
    created_at: v.number(),
    last_used_at: v.optional(v.number()),
    revoked_at: v.optional(v.number()),
  }).index("by_userId_and_created_at", ["userId", "created_at"]),

  reviewRepos: defineTable({
    userId: v.id("users"),
    scm: v.union(v.literal("github"), v.literal("gitlab"), v.literal("bitbucket")),
    owner: v.string(),
    name: v.string(),
    default_branch: v.string(),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("revoked")),
    installation_id: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_userId_and_created_at", ["userId", "created_at"]),

  reviews: defineTable({
    userId: v.id("users"),
    kind: v.union(v.literal("pr"), v.literal("whitebox")),
    mode: v.union(v.literal("fast"), v.literal("deep")),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
    score_0_5: v.optional(v.number()),
    summary_md: v.optional(v.string()),
    pr_number: v.optional(v.number()),
    repo: v.optional(v.string()),
    findings: v.array(v.any()),
    created_at: v.number(),
    completed_at: v.optional(v.number()),
  }).index("by_userId_and_created_at", ["userId", "created_at"]),

  githubInstallations: defineTable({
    userId: v.id("users"),
    installation_id: v.string(),
    account_login: v.string(),
    account_type: v.union(v.literal("User"), v.literal("Organization")),
    repository_selection: v.union(v.literal("all"), v.literal("selected")),
    status: v.union(v.literal("active"), v.literal("suspended"), v.literal("deleted")),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_userId_and_created_at", ["userId", "created_at"])
    .index("by_installation_id", ["installation_id"]),

  auditEvents: defineTable({
    userId: v.optional(v.id("users")),
    scan_id: v.optional(v.id("scans")),
    scan_order_id: v.optional(v.id("scanOrders")),
    event: v.string(),
    outcome: v.string(),
    metadata: v.optional(v.any()),
    created_at: v.number(),
  })
    .index("by_scan_id_and_created_at", ["scan_id", "created_at"])
    .index("by_userId_and_created_at", ["userId", "created_at"]),
});
