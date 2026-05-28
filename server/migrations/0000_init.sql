CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`event` text NOT NULL,
	`user_id` text,
	`project_id` text,
	`target_id` text,
	`scan_id` text,
	`vps_instance_id` text,
	`auth_proof_id` text,
	`finding_id` text,
	`severity` text,
	`outcome` text NOT NULL,
	`metadata_json` text NOT NULL,
	`prev_signature` text NOT NULL,
	`signature` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_scan_id_idx` ON `audit_log` (`scan_id`);--> statement-breakpoint
CREATE INDEX `audit_log_event_idx` ON `audit_log` (`event`);--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE TABLE `auth_proofs` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`challenge` text NOT NULL,
	`method` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`verified_at` integer,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_proofs_target_id_idx` ON `auth_proofs` (`target_id`);--> statement-breakpoint
CREATE INDEX `auth_proofs_status_idx` ON `auth_proofs` (`status`);--> statement-breakpoint
CREATE INDEX `auth_proofs_expires_at_idx` ON `auth_proofs` (`expires_at`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`evidence_json` text,
	`created_at` integer NOT NULL,
	`dedup_key` text NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `findings_scan_id_idx` ON `findings` (`scan_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `findings_dedup_key_uq` ON `findings` (`dedup_key`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_scheduled_at_idx` ON `jobs` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `jobs_type_idx` ON `jobs` (`type`);--> statement-breakpoint
CREATE TABLE `magic_link_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `magic_link_tokens_email_idx` ON `magic_link_tokens` (`email`);--> statement-breakpoint
CREATE INDEX `magic_link_tokens_expires_at_idx` ON `magic_link_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `projects_user_id_idx` ON `projects` (`user_id`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`target_id` text NOT NULL,
	`profile` text NOT NULL,
	`status` text NOT NULL,
	`failure_reason` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`usage_tokens` integer,
	`usage_usd_cents` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scans_user_id_idx` ON `scans` (`user_id`);--> statement-breakpoint
CREATE INDEX `scans_target_id_idx` ON `scans` (`target_id`);--> statement-breakpoint
CREATE INDEX `scans_status_idx` ON `scans` (`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `targets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `targets_project_id_idx` ON `targets` (`project_id`);--> statement-breakpoint
CREATE INDEX `targets_status_idx` ON `targets` (`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `vps_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_server_id` text NOT NULL,
	`ipv4` text,
	`status` text NOT NULL,
	`sign_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`destroyed_at` integer,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vps_instances_scan_id_uq` ON `vps_instances` (`scan_id`);--> statement-breakpoint
CREATE INDEX `vps_instances_status_idx` ON `vps_instances` (`status`);