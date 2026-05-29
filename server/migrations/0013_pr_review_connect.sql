-- 0013_pr_review_connect.sql
-- 004-sthrip-pr-review: Connect GitHub App + per-repo enable/disable + verification gate.
-- Plan: specs/004-sthrip-pr-review/plan.md  Data-model: specs/004-sthrip-pr-review/data-model.md
--
-- New tables: installations, review_suppressions.
-- New columns on: review_repos (+5), review_findings (+2).
-- Conventions mirror 0012: 26-char ULID text PKs, unix-ms INTEGER timestamps,
-- CHECK constraints inline, indexes named verbatim, --> statement-breakpoint separators.

-- === installations === first-class GitHub-App installation (connect-flow anchor)
CREATE TABLE `installations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scm` text DEFAULT 'github' NOT NULL,
	`installation_id` text NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`repository_selection` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`setup_action` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`account_type` IN ('User','Organization')),
	CHECK (`repository_selection` IN ('all','selected')),
	CHECK (`status` IN ('active','suspended','deleted'))
);--> statement-breakpoint
-- Unique per SCM: one GitHub installation id maps to exactly one row.
CREATE UNIQUE INDEX `installations_scm_installation_id_uq` ON `installations` (`scm`,`installation_id`);--> statement-breakpoint
CREATE INDEX `installations_user_idx` ON `installations` (`user_id`);--> statement-breakpoint

-- === review_repos new columns ===
-- enabled: explicit enable/disable independent of status (US1 toggle)
ALTER TABLE `review_repos` ADD COLUMN `enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- status_check_enabled: post the "Sthrip N/5" check-run (FR-014)
ALTER TABLE `review_repos` ADD COLUMN `status_check_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- merge_block_on_critical: check-run conclusion = failure when a verified critical exists (FR-014)
ALTER TABLE `review_repos` ADD COLUMN `merge_block_on_critical` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- last_review_id: pointer to the most recent review for the per-repo "last-review status" (FR-007)
ALTER TABLE `review_repos` ADD COLUMN `last_review_id` text REFERENCES `reviews`(`id`);--> statement-breakpoint
-- installation_row_id: link to the new installations entity
ALTER TABLE `review_repos` ADD COLUMN `installation_row_id` text REFERENCES `installations`(`id`);--> statement-breakpoint

-- === review_findings new columns ===
-- verification_status: verified | unverified | refuted (FR-018); only 'verified' are posted
ALTER TABLE `review_findings` ADD COLUMN `verification_status` text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
-- reachability_evidence_md: taint path / why-reachable evidence (FR-019/020)
ALTER TABLE `review_findings` ADD COLUMN `reachability_evidence_md` text;--> statement-breakpoint

-- === review_suppressions === derived suppression decisions for the learning loop (FR-023/024)
-- INVARIANT (code-enforced): rows whose category ∈ {security, correctness} are NEVER written.
CREATE TABLE `review_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`category` text NOT NULL,
	`reason` text NOT NULL,
	`ignore_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`reason` IN ('ignored_n_times','manual'))
);--> statement-breakpoint
-- One suppression row per (repo, category): upsert-friendly.
CREATE UNIQUE INDEX `review_suppressions_repo_category_uq` ON `review_suppressions` (`repo_id`,`category`);--> statement-breakpoint
CREATE INDEX `review_suppressions_repo_idx` ON `review_suppressions` (`repo_id`);
