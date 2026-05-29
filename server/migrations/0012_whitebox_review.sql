-- 0012_whitebox_review.sql
-- 003-whitebox: AI whitebox security testing (PR Review + Whitebox Pentest).
-- Plan: specs/003-whitebox/plan.md  Research: docs/research/2026-05-29-hacktron-whitebox-dossier.md
--
-- Both sub-products share ONE engine + ONE schema. `reviews.kind` discriminates
-- 'pr' (GitHub PR review) from 'whitebox' (repo-scope deep audit).
--
-- New tables: review_repos, reviews, review_findings, review_threads, review_feedback.
-- No changes to existing tables (jobs.type is free text — new kinds wired in the TS union).
-- Conventions mirror 0010: 26-char ULID text PKs, unix-ms INTEGER timestamps,
-- CHECK constraints inline, indexes named verbatim, --> statement-breakpoint separators.

-- === review_repos === connected source repos (GitHub App installations)
CREATE TABLE `review_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scm` text DEFAULT 'github' NOT NULL,
	`installation_id` text,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`covered_branches_json` text DEFAULT '[]' NOT NULL,
	`rules_md` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`scm` IN ('github','gitlab','bitbucket')),
	CHECK (`status` IN ('active','paused','revoked'))
);--> statement-breakpoint
-- Unique PER USER (multi-tenant): two users may each connect the same repo;
-- a caller's upsert can only ever find/create their OWN row (no cross-tenant bind).
CREATE UNIQUE INDEX `review_repos_scm_owner_name_user_uq` ON `review_repos` (`scm`,`owner`,`name`,`user_id`);--> statement-breakpoint
CREATE INDEX `review_repos_user_idx` ON `review_repos` (`user_id`);--> statement-breakpoint
CREATE INDEX `review_repos_installation_idx` ON `review_repos` (`installation_id`);--> statement-breakpoint

-- === reviews === one row per review run (PR or whitebox)
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text,
	`user_id` text,
	`kind` text NOT NULL,
	`pr_number` integer,
	`head_sha` text,
	`base_sha` text,
	`commit_ref` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`score_0_5` real,
	`summary_md` text,
	`github_review_id` text,
	`findings_count` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CHECK (`kind` IN ('pr','whitebox')),
	CHECK (`status` IN ('queued','running','completed','failed','cancelled')),
	CHECK (`score_0_5` IS NULL OR (`score_0_5` >= 0 AND `score_0_5` <= 5))
);--> statement-breakpoint
CREATE INDEX `reviews_repo_idx` ON `reviews` (`repo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_user_idx` ON `reviews` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_status_idx` ON `reviews` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `reviews_repo_pr_idx` ON `reviews` (`repo_id`,`pr_number`);--> statement-breakpoint

-- === review_findings === per-finding output of the engine
CREATE TABLE `review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`file_path` text NOT NULL,
	`start_line` integer,
	`end_line` integer,
	`side` text DEFAULT 'RIGHT' NOT NULL,
	`severity` text NOT NULL,
	`cwe_json` text DEFAULT '[]' NOT NULL,
	`cvss_vector` text,
	`cvss_score` real,
	`confidence` text,
	`reachable` integer,
	`category` text,
	`title` text NOT NULL,
	`rationale_md` text NOT NULL,
	`poc_md` text,
	`fix_prompt_md` text,
	`source` text DEFAULT 'llm' NOT NULL,
	`lifecycle_state` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`severity` IN ('critical','high','medium','low','informational')),
	CHECK (`side` IN ('LEFT','RIGHT')),
	CHECK (`confidence` IS NULL OR `confidence` IN ('verified','high','medium','low')),
	CHECK (`lifecycle_state` IN ('open','resolved','suppressed'))
);--> statement-breakpoint
CREATE INDEX `review_findings_review_idx` ON `review_findings` (`review_id`,`severity`);--> statement-breakpoint
CREATE INDEX `review_findings_fingerprint_idx` ON `review_findings` (`fingerprint`);--> statement-breakpoint

-- === review_threads === fingerprint -> GitHub review-thread map (dedup + resolve)
CREATE TABLE `review_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`repo_id` text,
	`fingerprint` text NOT NULL,
	`github_thread_id` text,
	`github_comment_id` text,
	`is_resolved` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `review_threads_review_idx` ON `review_threads` (`review_id`);--> statement-breakpoint
CREATE INDEX `review_threads_fingerprint_idx` ON `review_threads` (`fingerprint`);--> statement-breakpoint

-- === review_feedback === team-partitioned triage signal (powers the noise filter)
CREATE TABLE `review_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`fingerprint` text,
	`signal` text NOT NULL,
	`comment_text` text,
	`embedding_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `review_repos`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`signal` IN ('up','down','addressed','ignored'))
);--> statement-breakpoint
CREATE INDEX `review_feedback_repo_idx` ON `review_feedback` (`repo_id`);
