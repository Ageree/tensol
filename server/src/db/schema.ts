/**
 * Drizzle schema — Blackbox MVP (002-blackbox-mvp).
 *
 * Source of truth: `specs/002-blackbox-mvp/data-model.md` (E1–E11) and
 * migration `server/migrations/0010_blackbox_mvp.sql` (T011, commit 1dfb206).
 * Pivot overlay (telegram-link auth): `docs/pivot-2026-05-19-telegram-auth.md`.
 *
 * Layout after 0010:
 *   Retained from 001-backend-v2:
 *     - users    (extended: free-quota + telegram-pivot columns)
 *     - sessions
 *     - audit_log
 *     - vps_instances
 *     - jobs
 *   Dropped from 001-backend-v2:
 *     - auth_proofs, targets, projects, magic_link_tokens
 *     - scans (rebuilt with scan_order_id FK; target_id removed)
 *     - findings (rebuilt with E5 18-column shape; old dedup_key dropped)
 *   New tables (002):
 *     - scan_orders          (E2)
 *     - scan_events          (E4)
 *     - deep_inquiries       (E6)
 *     - evidence_artifacts   (E9)
 *     - reports              (E10)
 *     - pending_signups      (pivot — telegram /start <token> auth)
 *
 * Conventions:
 *   - All PKs are 26-char Crockford ULIDs (text), except `audit_log.id`
 *     which stays as autoincrement integer for monotonic ordering.
 *   - All timestamps are unix milliseconds in INTEGER columns (no Drizzle
 *     `{ mode: 'timestamp_ms' }`; see audit-log canonicalization rationale
 *     in 001 — kept verbatim).
 *   - CHECK constraints from the SQL migration are NOT redeclared here:
 *     they live in the DB layer; Zod owns boundary validation. Enum
 *     awareness is via `$type<...>()` for compile-time help only.
 *   - 27 indexes — names mirror the migration's `CREATE [UNIQUE] INDEX` names
 *     verbatim so drizzle-kit treats them as a no-op diff.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// users — extended with free-quota + telegram-pivot columns.
//
// Migration 0010 leaves `email` as `text NOT NULL` because SQLite cannot DROP
// NOT NULL without a full table rebuild. The pivot doc treats null/empty
// `email` as semantically absent in the service layer; downstream code MUST
// honour that, and inserts MUST supply at least an empty string until a
// future cleanup migration rebuilds the table.
// ---------------------------------------------------------------------------
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    createdAt: integer("created_at").notNull(),
    freeQuickConsumedAt: integer("free_quick_consumed_at"),
    freeQuickConsumedCount: integer("free_quick_consumed_count")
      .notNull()
      .default(0),
    telegramUserId: integer("telegram_user_id"),
    telegramUsername: text("telegram_username"),
  },
  (t) => ({
    emailUq: uniqueIndex("users_email_uq").on(t.email),
    telegramUserIdUq: uniqueIndex("users_telegram_user_id_uq").on(
      t.telegramUserId,
    ),
    telegramUsernameUq: uniqueIndex("users_telegram_username_uq").on(
      t.telegramUsername,
    ),
  }),
);

// ---------------------------------------------------------------------------
// sessions — unchanged from 001
// ---------------------------------------------------------------------------
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => ({
    userIdx: index("sessions_user_id_idx").on(t.userId),
    expiresIdx: index("sessions_expires_at_idx").on(t.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// scan_orders (E2) — the wizard's intent-to-scan record.
//
// State machine encoded in `status`: draft → dns_pending → dns_verified →
// vm_provisioning → running → completed | failed | cancelled. See E2 in
// data-model.md for transitions and per-state audit events.
// ---------------------------------------------------------------------------
export const scanOrders = sqliteTable(
  "scan_orders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<
        | "draft"
        | "dns_pending"
        | "dns_verified"
        | "vm_provisioning"
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
      >()
      .notNull()
      .default("draft"),
    tier: text("tier").$type<"quick" | "deep">().notNull(),
    primaryDomain: text("primary_domain").notNull(),
    attackSurfaceJson: text("attack_surface_json").notNull().default("[]"),
    safetyRps: integer("safety_rps").notNull().default(50),
    dnsVerifyToken: text("dns_verify_token").notNull(),
    dnsVerifyRequestedAt: integer("dns_verify_requested_at"),
    dnsVerifiedAt: integer("dns_verified_at"),
    dnsCheckAttempts: integer("dns_check_attempts").notNull().default(0),
    vpsInstanceId: text("vps_instance_id"),
    vpsProvider: text("vps_provider")
      .$type<"yandex">()
      .notNull()
      .default("yandex"),
    vpsZone: text("vps_zone"),
    // NOTE: `scan_id` is a soft pointer; the migration does NOT declare a FK
    // because the scans row is created at launch time (after the order). The
    // reverse `scans.scan_order_id` FK is the canonical link.
    scanId: text("scan_id"),
    failureReason: text("failure_reason"),
    cancelledAt: integer("cancelled_at"),
    paymentKind: text("payment_kind")
      .$type<"free_quick" | "yookassa">()
      .notNull()
      .default("free_quick"),
    amountKopecks: integer("amount_kopecks"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    userCreatedIdx: index("scan_orders_user_created_idx").on(
      t.userId,
      t.createdAt,
    ),
    statusUpdatedIdx: index("scan_orders_status_updated_idx").on(
      t.status,
      t.updatedAt,
    ),
  }),
);

// ---------------------------------------------------------------------------
// scans (E3) — rebuilt: target_id removed, scan_order_id FK added.
// ---------------------------------------------------------------------------
export const scans = sqliteTable(
  "scans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scanOrderId: text("scan_order_id")
      .notNull()
      .references(() => scanOrders.id, { onDelete: "cascade" }),
    profile: text("profile").$type<"recon" | "standard" | "max">().notNull(),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed" | "cancelled">()
      .notNull(),
    failureReason: text("failure_reason"),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    usageTokens: integer("usage_tokens"),
    usageUsdCents: integer("usage_usd_cents"),
  },
  (t) => ({
    userIdx: index("scans_user_id_idx").on(t.userId),
    scanOrderIdx: index("scans_scan_order_id_idx").on(t.scanOrderId),
    statusIdx: index("scans_status_idx").on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// scan_events (E4) — append-only progress log for Live page + SSE replay.
// ---------------------------------------------------------------------------
export const scanEvents = sqliteTable(
  "scan_events",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    eventType: text("event_type")
      .$type<
        | "vm_provisioning"
        | "vm_ready"
        | "vm_teardown"
        | "agent_started"
        | "agent_phase_changed"
        | "finding_detected"
        | "scan_completed"
        | "scan_failed"
      >()
      .notNull(),
    payloadJson: text("payload_json"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    scanCreatedIdx: index("scan_events_scan_id_created_at_idx").on(
      t.scanId,
      t.createdAt,
    ),
  }),
);

// ---------------------------------------------------------------------------
// findings (E5) — full 18-column shape; replaces the 001 stub.
// ---------------------------------------------------------------------------
export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    severity: text("severity")
      .$type<"critical" | "high" | "medium" | "low" | "informational">()
      .notNull(),
    title: text("title").notNull(),
    target: text("target").notNull(),
    cvssScore: real("cvss_score"),
    cvssVector: text("cvss_vector"),
    cvssVersion: text("cvss_version"),
    cweJson: text("cwe_json").notNull().default("[]"),
    mitreJson: text("mitre_json").notNull().default("[]"),
    confidence: text("confidence").$type<
      "verified" | "high" | "medium" | "low" | null
    >(),
    phase: text("phase"),
    agent: text("agent"),
    bodyMd: text("body_md").notNull(),
    rawYamlJson: text("raw_yaml_json").notNull(),
    evidenceKeysJson: text("evidence_keys_json").notNull().default("[]"),
    discoveredAt: integer("discovered_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    scanSeverityIdx: index("findings_scan_severity_idx").on(
      t.scanId,
      t.severity,
    ),
    severityCreatedIdx: index("findings_severity_created_idx").on(
      t.severity,
      t.createdAt,
    ),
  }),
);

// ---------------------------------------------------------------------------
// deep_inquiries (E6) — lead-gen records.
//
// FK onDelete is SET NULL (not cascade) — anonymous inquiries must survive
// user deletion for funnel analytics. Matches the migration's
// `ON DELETE set null`.
// ---------------------------------------------------------------------------
export const deepInquiries = sqliteTable(
  "deep_inquiries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    company: text("company").notNull(),
    contactName: text("contact_name").notNull(),
    position: text("position"),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    domainsText: text("domains_text").notNull(),
    desiredDate: integer("desired_date"),
    budgetBand: text("budget_band").$type<
      "under_500k" | "500k_1m" | "1m_3m" | "3m_plus" | "open" | null
    >(),
    scopeText: text("scope_text").notNull(),
    consentAcceptedAt: integer("consent_accepted_at").notNull(),
    status: text("status")
      .$type<"new" | "contacted" | "converted" | "declined" | "dropped">()
      .notNull()
      .default("new"),
    telegramSentAt: integer("telegram_sent_at"),
    telegramSendAttempts: integer("telegram_send_attempts")
      .notNull()
      .default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    statusCreatedIdx: index("deep_inquiries_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    userIdx: index("deep_inquiries_user_id_idx").on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// evidence_artifacts (E9) — Object Storage key → scan map for lifecycle.
// ---------------------------------------------------------------------------
export const evidenceArtifacts = sqliteTable(
  "evidence_artifacts",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    sizeBytes: integer("size_bytes"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    scanIdx: index("evidence_artifacts_scan_id_idx").on(t.scanId),
    expiresIdx: index("evidence_artifacts_expires_at_idx").on(t.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// reports (E10) — PDF render state; one row per scan (UNIQUE scan_id).
// ---------------------------------------------------------------------------
export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<"pending" | "rendering" | "ready" | "failed">()
      .notNull()
      .default("pending"),
    bucket: text("bucket"),
    key: text("key"),
    byteSize: integer("byte_size"),
    renderAttempts: integer("render_attempts").notNull().default(0),
    lastError: text("last_error"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    scanUq: uniqueIndex("reports_scan_id_uq").on(t.scanId),
  }),
);

// ---------------------------------------------------------------------------
// pending_signups (pivot) — telegram-link auth: `/start <token>` flow.
//
// No FK to users — the row is created BEFORE the user account exists.
// `telegram_username` is stored lowercased without the leading `@`.
// `chat_id` is populated when the bot receives `/start <token>`.
// ---------------------------------------------------------------------------
export const pendingSignups = sqliteTable(
  "pending_signups",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    telegramUsername: text("telegram_username").notNull(),
    chatId: integer("chat_id"),
    status: text("status")
      .$type<"pending" | "resolved" | "expired">()
      .notNull()
      .default("pending"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => ({
    tokenUq: uniqueIndex("pending_signups_token_uq").on(t.token),
    usernameStatusExpiresIdx: index(
      "pending_signups_username_status_expires_idx",
    ).on(t.telegramUsername, t.status, t.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// audit_log (E8) — unchanged from 001. INTEGER PK AUTOINCREMENT for
// monotonic ordering and HMAC signature chain; no FKs (audit rows must
// never be blocked by referential integrity).
// ---------------------------------------------------------------------------
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    event: text("event").notNull(),
    userId: text("user_id"),
    projectId: text("project_id"),
    targetId: text("target_id"),
    scanId: text("scan_id"),
    vpsInstanceId: text("vps_instance_id"),
    authProofId: text("auth_proof_id"),
    findingId: text("finding_id"),
    severity: text("severity"),
    outcome: text("outcome")
      .$type<"success" | "failure" | "rejected">()
      .notNull(),
    metadataJson: text("metadata_json").notNull(),
    prevSignature: text("prev_signature").notNull(),
    signature: text("signature").notNull(),
  },
  (t) => ({
    scanIdx: index("audit_log_scan_id_idx").on(t.scanId),
    eventIdx: index("audit_log_event_idx").on(t.event),
    tsIdx: index("audit_log_ts_idx").on(t.ts),
  }),
);

// ---------------------------------------------------------------------------
// vps_instances — unchanged from 001 (1:1 with scans via UNIQUE scan_id).
// Migration 0010 does not touch this table; it remains as-is.
// ---------------------------------------------------------------------------
export const vpsInstances = sqliteTable(
  "vps_instances",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"hetzner" | "yandex">().notNull(),
    providerServerId: text("provider_server_id").notNull(),
    ipv4: text("ipv4"),
    status: text("status")
      .$type<"provisioning" | "alive" | "tearing_down" | "destroyed">()
      .notNull(),
    signKey: text("sign_key").notNull(),
    createdAt: integer("created_at").notNull(),
    destroyedAt: integer("destroyed_at"),
  },
  (t) => ({
    scanUq: uniqueIndex("vps_instances_scan_id_uq").on(t.scanId),
    statusIdx: index("vps_instances_status_idx").on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// jobs — unchanged structure from 001; the `type` enum is extended at the
// application layer per data-model.md E7 (no schema change required).
// ---------------------------------------------------------------------------
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type")
      .$type<
        // 001 originals (some now deprecated aliases handled by the runner)
        | "spawn_vps"
        | "dispatch_scan"
        | "watchdog_scan"
        | "teardown_vps"
        // 002 additions (E7)
        | "spawn_yandex_vm"
        | "teardown_yandex_vm"
        | "render_pdf"
        | "send_scan_complete_telegram"
        | "poll_dns_verify"
        | "scan_timeout_watcher"
        | "retry_telegram_notification"
        | "cleanup_orphan_vms"
      >()
      .notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status")
      .$type<"pending" | "running" | "done" | "failed">()
      .notNull(),
    scheduledAt: integer("scheduled_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    statusScheduledIdx: index("jobs_status_scheduled_at_idx").on(
      t.status,
      t.scheduledAt,
    ),
    typeIdx: index("jobs_type_idx").on(t.type),
  }),
);

// ---------------------------------------------------------------------------
// Inferred row types — consumed by repositories / services.
// ---------------------------------------------------------------------------
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ScanOrder = typeof scanOrders.$inferSelect;
export type NewScanOrder = typeof scanOrders.$inferInsert;
export type Scan = typeof scans.$inferSelect;
export type NewScan = typeof scans.$inferInsert;
export type ScanEvent = typeof scanEvents.$inferSelect;
export type NewScanEvent = typeof scanEvents.$inferInsert;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type DeepInquiry = typeof deepInquiries.$inferSelect;
export type NewDeepInquiry = typeof deepInquiries.$inferInsert;
export type EvidenceArtifact = typeof evidenceArtifacts.$inferSelect;
export type NewEvidenceArtifact = typeof evidenceArtifacts.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type PendingSignup = typeof pendingSignups.$inferSelect;
export type NewPendingSignup = typeof pendingSignups.$inferInsert;
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type VpsInstance = typeof vpsInstances.$inferSelect;
export type NewVpsInstance = typeof vpsInstances.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

// Keep `sql` import live for future `sql\`...\`` defaults (mirrors 001).
void sql;
