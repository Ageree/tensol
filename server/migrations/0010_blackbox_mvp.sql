-- 0010_blackbox_mvp.sql
-- T011: Blackbox MVP schema reshape per specs/002-blackbox-mvp/data-model.md
-- Pivot: docs/pivot-2026-05-19-telegram-auth.md (telegram-link auth)
--
-- DROP legacy: auth_proofs, targets, projects, magic_link_tokens, findings (stub)
-- ALTER users: free-tier quota + telegram_user_id/telegram_username (pivot)
-- ALTER scans: target_id -> scan_order_id FK
-- CREATE: scan_orders, scan_events, findings (full), deep_inquiries,
--         evidence_artifacts, reports, pending_signups (pivot)
-- + indexes per data-model.md E2/E4/E5
--
-- No data preservation (Constitution V — no prod users in 001).
-- Format: --> statement-breakpoint separators (drizzle-kit convention).

-- === DROP legacy tables ===
DROP TABLE IF EXISTS `auth_proofs`;--> statement-breakpoint
DROP TABLE IF EXISTS `findings`;--> statement-breakpoint
DROP TABLE IF EXISTS `scans`;--> statement-breakpoint
DROP TABLE IF EXISTS `targets`;--> statement-breakpoint
DROP TABLE IF EXISTS `projects`;--> statement-breakpoint
DROP TABLE IF EXISTS `magic_link_tokens`;--> statement-breakpoint

-- === ALTER users (free quota + telegram pivot) ===
-- E1 free-quota columns
ALTER TABLE `users` ADD COLUMN `free_quick_consumed_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `free_quick_consumed_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Pivot: telegram-link auth (docs/pivot-2026-05-19-telegram-auth.md)
-- `email` becomes nullable in semantics (SQLite has no DROP NOT NULL; the
-- existing column is left as text NOT NULL but service layer treats null/empty
-- as absent. Table-rebuild deferred to a future cleanup migration to avoid
-- destabilising 0010's blast radius. Interpretation note in commit body.)
ALTER TABLE `users` ADD COLUMN `telegram_user_id` integer;--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `telegram_username` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_telegram_user_id_uq` ON `users` (`telegram_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_telegram_username_uq` ON `users` (`telegram_username`);--> statement-breakpoint

-- === CREATE scan_orders === (E2)
CREATE TABLE `scan_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`tier` text NOT NULL,
	`primary_domain` text NOT NULL,
	`attack_surface_json` text DEFAULT '[]' NOT NULL,
	`safety_rps` integer DEFAULT 50 NOT NULL,
	`dns_verify_token` text NOT NULL,
	`dns_verify_requested_at` integer,
	`dns_verified_at` integer,
	`dns_check_attempts` integer DEFAULT 0 NOT NULL,
	`vps_instance_id` text,
	`vps_provider` text DEFAULT 'gcp' NOT NULL,
	`vps_zone` text,
	`scan_id` text,
	`failure_reason` text,
	`cancelled_at` integer,
	`payment_kind` text DEFAULT 'free_quick' NOT NULL,
	`amount_kopecks` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`status` IN ('draft','dns_pending','dns_verified','vm_provisioning','running','completed','failed','cancelled')),
	CHECK (`tier` IN ('quick','deep')),
	CHECK (`safety_rps` BETWEEN 1 AND 500),
	CHECK (`vps_provider` IN ('gcp')),
	CHECK (`payment_kind` IN ('free_quick','yookassa'))
);--> statement-breakpoint
CREATE INDEX `scan_orders_user_created_idx` ON `scan_orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scan_orders_status_updated_idx` ON `scan_orders` (`status`,`updated_at`);--> statement-breakpoint

-- === CREATE scans === (E3 — re-created post-DROP with new shape)
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scan_order_id` text NOT NULL,
	`profile` text NOT NULL,
	`status` text NOT NULL,
	`failure_reason` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`usage_tokens` integer,
	`usage_usd_cents` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_order_id`) REFERENCES `scan_orders`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `scans_user_id_idx` ON `scans` (`user_id`);--> statement-breakpoint
CREATE INDEX `scans_scan_order_id_idx` ON `scans` (`scan_order_id`);--> statement-breakpoint
CREATE INDEX `scans_status_idx` ON `scans` (`status`);--> statement-breakpoint

-- === CREATE scan_events === (E4)
CREATE TABLE `scan_events` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`event_type` IN ('vm_provisioning','vm_ready','vm_teardown','agent_started','agent_phase_changed','finding_detected','scan_completed','scan_failed'))
);--> statement-breakpoint
CREATE INDEX `scan_events_scan_id_created_at_idx` ON `scan_events` (`scan_id`,`created_at`);--> statement-breakpoint

-- === CREATE findings === (E5 — full schema; replaces 001 stub)
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`external_id` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`target` text NOT NULL,
	`cvss_score` real,
	`cvss_vector` text,
	`cvss_version` text,
	`cwe_json` text DEFAULT '[]' NOT NULL,
	`mitre_json` text DEFAULT '[]' NOT NULL,
	`confidence` text,
	`phase` text,
	`agent` text,
	`body_md` text NOT NULL,
	`raw_yaml_json` text NOT NULL,
	`evidence_keys_json` text DEFAULT '[]' NOT NULL,
	`discovered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`severity` IN ('critical','high','medium','low','informational')),
	CHECK (`confidence` IS NULL OR `confidence` IN ('verified','high','medium','low'))
);--> statement-breakpoint
CREATE INDEX `findings_scan_severity_idx` ON `findings` (`scan_id`,`severity`);--> statement-breakpoint
CREATE INDEX `findings_severity_created_idx` ON `findings` (`severity`,`created_at`);--> statement-breakpoint

-- === CREATE deep_inquiries === (E6)
CREATE TABLE `deep_inquiries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`company` text NOT NULL,
	`contact_name` text NOT NULL,
	`position` text,
	`email` text NOT NULL,
	`phone` text NOT NULL,
	`domains_text` text NOT NULL,
	`desired_date` integer,
	`budget_band` text,
	`scope_text` text NOT NULL,
	`consent_accepted_at` integer NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`telegram_sent_at` integer,
	`telegram_send_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CHECK (`budget_band` IS NULL OR `budget_band` IN ('under_500k','500k_1m','1m_3m','3m_plus','open')),
	CHECK (`status` IN ('new','contacted','converted','declined','dropped'))
);--> statement-breakpoint
CREATE INDEX `deep_inquiries_status_created_idx` ON `deep_inquiries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `deep_inquiries_user_id_idx` ON `deep_inquiries` (`user_id`);--> statement-breakpoint

-- === CREATE evidence_artifacts === (E9)
CREATE TABLE `evidence_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`bucket` text NOT NULL,
	`key` text NOT NULL,
	`size_bytes` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `evidence_artifacts_scan_id_idx` ON `evidence_artifacts` (`scan_id`);--> statement-breakpoint
CREATE INDEX `evidence_artifacts_expires_at_idx` ON `evidence_artifacts` (`expires_at`);--> statement-breakpoint

-- === CREATE reports === (E10)
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`bucket` text,
	`key` text,
	`byte_size` integer,
	`render_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`status` IN ('pending','rendering','ready','failed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX `reports_scan_id_uq` ON `reports` (`scan_id`);--> statement-breakpoint

-- === CREATE pending_signups === (pivot — telegram-link auth)
CREATE TABLE `pending_signups` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`telegram_username` text NOT NULL,
	`chat_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CHECK (`status` IN ('pending','resolved','expired'))
);--> statement-breakpoint
CREATE UNIQUE INDEX `pending_signups_token_uq` ON `pending_signups` (`token`);--> statement-breakpoint
CREATE INDEX `pending_signups_username_status_expires_idx` ON `pending_signups` (`telegram_username`,`status`,`expires_at`);
