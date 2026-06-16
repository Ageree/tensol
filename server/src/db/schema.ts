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
 *   - 29 indexes (27 from 0010 + 2 from 0011 webhook_dedup) — names mirror
 *     the migration's `CREATE [UNIQUE] INDEX` names verbatim so drizzle-kit
 *     treats them as a no-op diff.
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
		vpsProvider: text("vps_provider").$type<"gcp">().notNull().default("gcp"),
		vpsZone: text("vps_zone"),
		// NOTE: `scan_id` is a soft pointer; the migration does NOT declare a FK
		// because the scans row is created at launch time (after the order). The
		// reverse `scans.scan_order_id` FK is the canonical link.
		scanId: text("scan_id"),
		failureReason: text("failure_reason"),
		cancelledAt: integer("cancelled_at"),
		// Legacy pre-international-pivot payment marker. New billing should be
		// provider-agnostic and entitlement-based; do not add new YooKassa logic.
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
// webhook_dedup (0011) — O(1) idempotency for inbound webhook deliveries.
//
// Replaces the previous O(n) LIKE-scan on `audit_log.metadata_json` used by
// `webhooks-scan-complete.ts`. UNIQUE(webhook_kind, dedup_key) is the dedup
// anchor: insert-then-catch-SQLITE_CONSTRAINT_UNIQUE collapses replay to a
// single index probe.
//
// `received_at` is the timestamp of the FIRST accepted delivery. Subsequent
// deliveries fail the UNIQUE constraint and are short-circuited to 200
// duplicate — they do not update this row.
// ---------------------------------------------------------------------------
export const webhookDedup = sqliteTable(
	"webhook_dedup",
	{
		id: text("id").primaryKey(),
		webhookKind: text("webhook_kind").notNull(),
		dedupKey: text("dedup_key").notNull(),
		receivedAt: integer("received_at").notNull(),
		metadataJson: text("metadata_json"),
	},
	(t) => ({
		uniqWebhookKindKey: uniqueIndex("uniq_webhook_dedup_kind_key").on(
			t.webhookKind,
			t.dedupKey,
		),
		byKindReceived: index("idx_webhook_dedup_kind_received_at").on(
			t.webhookKind,
			t.receivedAt,
		),
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
		provider: text("provider").$type<"hetzner" | "gcp">().notNull(),
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
				| "spawn_scan_vm"
				| "teardown_scan_vm"
				| "render_pdf"
				| "send_scan_complete_telegram"
				| "send_deep_inquiry_telegram"
				| "poll_dns_verify"
				| "scan_timeout_watcher"
				| "retry_telegram_notification"
				| "cleanup_orphan_vms"
				// 003-whitebox additions (specs/003-whitebox/plan.md)
				| "pr_review"
				| "whitebox_scan"
				| "resolve_threads"
				| "index_repo"
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

// ===========================================================================
// 003-whitebox — AI whitebox security testing (PR Review + Whitebox Pentest).
// Migration: 0012_whitebox_review.sql. Both sub-products share one engine +
// one schema; `reviews.kind` discriminates 'pr' from 'whitebox'.
// ===========================================================================

// ---------------------------------------------------------------------------
// installations — first-class GitHub-App installation (connect-flow anchor).
// Migration: 0013_pr_review_connect.sql.
// Authorization root: webhook deliveries resolve owning account via
// `installationId` → `installations.userId`; repo slug alone never authorizes.
// ---------------------------------------------------------------------------
export const installations = sqliteTable(
	"installations",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		scm: text("scm").notNull().default("github"),
		installationId: text("installation_id").notNull(),
		accountLogin: text("account_login").notNull(),
		accountType: text("account_type")
			.$type<"User" | "Organization">()
			.notNull(),
		repositorySelection: text("repository_selection")
			.$type<"all" | "selected">()
			.notNull(),
		status: text("status")
			.$type<"active" | "suspended" | "deleted">()
			.notNull()
			.default("active"),
		setupAction: text("setup_action"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		scmInstallationIdUq: uniqueIndex("installations_scm_installation_id_uq").on(
			t.scm,
			t.installationId,
		),
		userIdx: index("installations_user_idx").on(t.userId),
	}),
);

// ---------------------------------------------------------------------------
// review_repos — connected source repos (GitHub App installations).
// ---------------------------------------------------------------------------
export const reviewRepos = sqliteTable(
	"review_repos",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		scm: text("scm")
			.$type<"github" | "gitlab" | "bitbucket">()
			.notNull()
			.default("github"),
		installationId: text("installation_id"),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		defaultBranch: text("default_branch").notNull().default("main"),
		coveredBranchesJson: text("covered_branches_json").notNull().default("[]"),
		rulesMd: text("rules_md"),
		status: text("status")
			.$type<"active" | "paused" | "revoked">()
			.notNull()
			.default("active"),
		// 004-sthrip-pr-review new columns (migration 0013)
		enabled: integer("enabled").notNull().default(1),
		statusCheckEnabled: integer("status_check_enabled").notNull().default(1),
		mergeBlockOnCritical: integer("merge_block_on_critical")
			.notNull()
			.default(0),
		prExecutionEnabled: integer("pr_execution_enabled").notNull().default(0),
		lastReviewId: text("last_review_id"),
		installationRowId: text("installation_row_id"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		scmOwnerNameUserUq: uniqueIndex("review_repos_scm_owner_name_user_uq").on(
			t.scm,
			t.owner,
			t.name,
			t.userId,
		),
		userIdx: index("review_repos_user_idx").on(t.userId),
		installationIdx: index("review_repos_installation_idx").on(
			t.installationId,
		),
	}),
);

// ---------------------------------------------------------------------------
// reviews — one row per review run (PR or whitebox).
// ---------------------------------------------------------------------------
export const reviews = sqliteTable(
	"reviews",
	{
		id: text("id").primaryKey(),
		repoId: text("repo_id").references(() => reviewRepos.id, {
			onDelete: "set null",
		}),
		userId: text("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		kind: text("kind").$type<"pr" | "whitebox">().notNull(),
		// Engine mode (migration 0014). 'deep' selects the multi-agent research
		// pipeline (F1); 'fast' is the single-pass default. Per-review opt-in so a
		// dashboard user can request deep research per scan.
		mode: text("mode").$type<"fast" | "deep">().notNull().default("fast"),
		prNumber: integer("pr_number"),
		headSha: text("head_sha"),
		baseSha: text("base_sha"),
		commitRef: text("commit_ref"),
		status: text("status")
			.$type<"queued" | "running" | "completed" | "failed" | "cancelled">()
			.notNull()
			.default("queued"),
		score0to5: real("score_0_5"),
		summaryMd: text("summary_md"),
		executionStatus: text("execution_status").$type<
			"skipped" | "running" | "passed" | "failed" | "error" | null
		>(),
		executionSummaryMd: text("execution_summary_md"),
		githubReviewId: text("github_review_id"),
		findingsCount: integer("findings_count").notNull().default(0),
		startedAt: integer("started_at"),
		completedAt: integer("completed_at"),
		error: text("error"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		repoIdx: index("reviews_repo_idx").on(t.repoId, t.createdAt),
		userIdx: index("reviews_user_idx").on(t.userId, t.createdAt),
		statusIdx: index("reviews_status_idx").on(t.status, t.updatedAt),
		repoPrIdx: index("reviews_repo_pr_idx").on(t.repoId, t.prNumber),
	}),
);

// ---------------------------------------------------------------------------
// review_execution_artifacts — bounded runtime evidence for PR execution.
// ---------------------------------------------------------------------------
export const reviewExecutionArtifacts = sqliteTable(
	"review_execution_artifacts",
	{
		id: text("id").primaryKey(),
		reviewId: text("review_id")
			.notNull()
			.references(() => reviews.id, { onDelete: "cascade" }),
		kind: text("kind")
			.$type<"log" | "screenshot" | "api_trace" | "generated_test" | "video" | "file">()
			.notNull(),
		label: text("label").notNull(),
		summaryMd: text("summary_md").notNull(),
		storageKey: text("storage_key"),
		inlineBody: text("inline_body"),
		mimeType: text("mime_type"),
		sha256: text("sha256"),
		byteSize: integer("byte_size"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		reviewIdx: index("review_execution_artifacts_review_idx").on(
			t.reviewId,
			t.createdAt,
		),
		kindIdx: index("review_execution_artifacts_kind_idx").on(t.kind),
	}),
);

// ---------------------------------------------------------------------------
// review_findings — per-finding output of the engine.
// ---------------------------------------------------------------------------
export const reviewFindings = sqliteTable(
	"review_findings",
	{
		id: text("id").primaryKey(),
		reviewId: text("review_id")
			.notNull()
			.references(() => reviews.id, { onDelete: "cascade" }),
		fingerprint: text("fingerprint").notNull(),
		filePath: text("file_path").notNull(),
		startLine: integer("start_line"),
		endLine: integer("end_line"),
		side: text("side").$type<"LEFT" | "RIGHT">().notNull().default("RIGHT"),
		severity: text("severity")
			.$type<"critical" | "high" | "medium" | "low" | "informational">()
			.notNull(),
		cweJson: text("cwe_json").notNull().default("[]"),
		cvssVector: text("cvss_vector"),
		cvssScore: real("cvss_score"),
		confidence: text("confidence").$type<
			"verified" | "high" | "medium" | "low" | null
		>(),
		reachable: integer("reachable"),
		category: text("category"),
		title: text("title").notNull(),
		rationaleMd: text("rationale_md").notNull(),
		pocMd: text("poc_md"),
		fixPromptMd: text("fix_prompt_md"),
		source: text("source")
			.$type<"llm" | "sast" | "secrets" | "sca">()
			.notNull()
			.default("llm"),
		lifecycleState: text("lifecycle_state")
			.$type<"open" | "resolved" | "suppressed">()
			.notNull()
			.default("open"),
		// Exploit Lab verdict (migration 0013). exploitStatus mirrors the
		// ExploitStatus union in src/exploit/types.ts; scores are 0-100;
		// exploitEvidenceJson is the serialized verdict evidence.
		exploitStatus: text("exploit_status")
			.$type<
				| "not_attempted"
				| "proven"
				| "failed"
				| "error"
				| "skipped_budget"
				| "skipped_unauthorized"
			>()
			.notNull()
			.default("not_attempted"),
		exploitabilityScore: integer("exploitability_score"),
		impactScore: integer("impact_score"),
		exploitEvidenceJson: text("exploit_evidence_json"),
		exploitIterations: integer("exploit_iterations").notNull().default(0),
		// 004-sthrip-pr-review new columns (migration 0013)
		verificationStatus: text("verification_status")
			.$type<"verified" | "unverified" | "refuted">()
			.notNull()
			.default("unverified"),
		reachabilityEvidenceMd: text("reachability_evidence_md"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		reviewIdx: index("review_findings_review_idx").on(t.reviewId, t.severity),
		fingerprintIdx: index("review_findings_fingerprint_idx").on(t.fingerprint),
	}),
);

// ---------------------------------------------------------------------------
// review_threads — fingerprint → GitHub review-thread map (dedup + resolve).
// ---------------------------------------------------------------------------
export const reviewThreads = sqliteTable(
	"review_threads",
	{
		id: text("id").primaryKey(),
		reviewId: text("review_id")
			.notNull()
			.references(() => reviews.id, { onDelete: "cascade" }),
		repoId: text("repo_id"),
		fingerprint: text("fingerprint").notNull(),
		githubThreadId: text("github_thread_id"),
		githubCommentId: text("github_comment_id"),
		isResolved: integer("is_resolved").notNull().default(0),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		reviewIdx: index("review_threads_review_idx").on(t.reviewId),
		fingerprintIdx: index("review_threads_fingerprint_idx").on(t.fingerprint),
	}),
);

// ---------------------------------------------------------------------------
// review_feedback — team-partitioned triage signal (powers the noise filter).
// ---------------------------------------------------------------------------
export const reviewFeedback = sqliteTable(
	"review_feedback",
	{
		id: text("id").primaryKey(),
		repoId: text("repo_id")
			.notNull()
			.references(() => reviewRepos.id, { onDelete: "cascade" }),
		fingerprint: text("fingerprint"),
		signal: text("signal")
			.$type<"up" | "down" | "addressed" | "ignored">()
			.notNull(),
		commentText: text("comment_text"),
		embeddingJson: text("embedding_json"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		repoIdx: index("review_feedback_repo_idx").on(t.repoId),
	}),
);

// ---------------------------------------------------------------------------
// review_suppressions — derived suppression decisions for the learning loop.
// Migration: 0013_pr_review_connect.sql. (FR-023/024)
// INVARIANT (code-enforced): rows whose category ∈ {security, correctness}
// are NEVER written — suppression applies to style/nit classes only.
// ---------------------------------------------------------------------------
export const reviewSuppressions = sqliteTable(
	"review_suppressions",
	{
		id: text("id").primaryKey(),
		repoId: text("repo_id")
			.notNull()
			.references(() => reviewRepos.id, { onDelete: "cascade" }),
		category: text("category").notNull(),
		reason: text("reason").$type<"ignored_n_times" | "manual">().notNull(),
		ignoreCount: integer("ignore_count").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		repoCategoryUq: uniqueIndex("review_suppressions_repo_category_uq").on(
			t.repoId,
			t.category,
		),
		repoIdx: index("review_suppressions_repo_idx").on(t.repoId),
	}),
);

// ---------------------------------------------------------------------------
// agent_api_tokens — bearer tokens for CLI and MCP.
//
// Plaintext token values are returned once by the creation endpoint and never
// stored. `tokenHash` is SHA-256 over the full token; `tokenPrefix` is display
// metadata so dashboard users can identify/revoke tokens.
// ---------------------------------------------------------------------------
export const agentApiTokens = sqliteTable(
	"agent_api_tokens",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		tokenHash: text("token_hash").notNull(),
		tokenPrefix: text("token_prefix").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		lastUsedAt: integer("last_used_at"),
		revokedAt: integer("revoked_at"),
	},
	(t) => ({
		tokenHashUq: uniqueIndex("agent_api_tokens_token_hash_uq").on(t.tokenHash),
		userIdx: index("agent_api_tokens_user_idx").on(t.userId, t.createdAt),
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
export type WebhookDedup = typeof webhookDedup.$inferSelect;
export type NewWebhookDedup = typeof webhookDedup.$inferInsert;
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type VpsInstance = typeof vpsInstances.$inferSelect;
export type NewVpsInstance = typeof vpsInstances.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
// 003-whitebox inferred row types.
export type ReviewRepo = typeof reviewRepos.$inferSelect;
export type NewReviewRepo = typeof reviewRepos.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type ReviewExecutionArtifact =
	typeof reviewExecutionArtifacts.$inferSelect;
export type NewReviewExecutionArtifact =
	typeof reviewExecutionArtifacts.$inferInsert;
export type ReviewFinding = typeof reviewFindings.$inferSelect;
export type NewReviewFinding = typeof reviewFindings.$inferInsert;
export type ReviewThread = typeof reviewThreads.$inferSelect;
export type NewReviewThread = typeof reviewThreads.$inferInsert;
export type ReviewFeedback = typeof reviewFeedback.$inferSelect;
export type NewReviewFeedback = typeof reviewFeedback.$inferInsert;
// 004-sthrip-pr-review inferred row types.
export type Installation = typeof installations.$inferSelect;
export type NewInstallation = typeof installations.$inferInsert;
export type ReviewSuppression = typeof reviewSuppressions.$inferSelect;
export type NewReviewSuppression = typeof reviewSuppressions.$inferInsert;
export type AgentApiToken = typeof agentApiTokens.$inferSelect;
export type NewAgentApiToken = typeof agentApiTokens.$inferInsert;

// Keep `sql` import live for future `sql\`...\`` defaults (mirrors 001).
void sql;
