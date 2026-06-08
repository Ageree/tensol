-- 0016_scan_orders_gcp_provider.sql
-- tensol:migration-disable-foreign-keys
--
-- Production drift repair: an early GCP-pivot deploy created scan_orders with
-- DEFAULT 'yandex' and CHECK (vps_provider IN ('yandex')). Current code writes
-- vps_provider='gcp' at draft creation time, so that stale CHECK makes
-- POST /v1/scan-orders fail with a generic internal_error.
--
-- SQLite cannot ALTER a CHECK constraint in place. Rebuild the table with the
-- current GCP-only constraint while preserving rows and converting historical
-- 'yandex' values to 'gcp'. The deploy/boot migrators disable FK enforcement
-- for this marked migration before BEGIN, then re-enable it and run
-- PRAGMA foreign_key_check after COMMIT so child rows survive the rebuild.

CREATE TABLE `scan_orders__gcp_provider` (
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

INSERT INTO `scan_orders__gcp_provider` (
	`id`,
	`user_id`,
	`status`,
	`tier`,
	`primary_domain`,
	`attack_surface_json`,
	`safety_rps`,
	`dns_verify_token`,
	`dns_verify_requested_at`,
	`dns_verified_at`,
	`dns_check_attempts`,
	`vps_instance_id`,
	`vps_provider`,
	`vps_zone`,
	`scan_id`,
	`failure_reason`,
	`cancelled_at`,
	`payment_kind`,
	`amount_kopecks`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`user_id`,
	`status`,
	`tier`,
	`primary_domain`,
	`attack_surface_json`,
	`safety_rps`,
	`dns_verify_token`,
	`dns_verify_requested_at`,
	`dns_verified_at`,
	`dns_check_attempts`,
	`vps_instance_id`,
	CASE `vps_provider` WHEN 'yandex' THEN 'gcp' ELSE `vps_provider` END,
	`vps_zone`,
	`scan_id`,
	`failure_reason`,
	`cancelled_at`,
	`payment_kind`,
	`amount_kopecks`,
	`created_at`,
	`updated_at`
FROM `scan_orders`;--> statement-breakpoint

DROP TABLE `scan_orders`;--> statement-breakpoint
ALTER TABLE `scan_orders__gcp_provider` RENAME TO `scan_orders`;--> statement-breakpoint
CREATE INDEX `scan_orders_user_created_idx` ON `scan_orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scan_orders_status_updated_idx` ON `scan_orders` (`status`,`updated_at`);
