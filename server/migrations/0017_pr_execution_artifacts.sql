-- 0017_pr_execution_artifacts.sql
-- PR execution validation: default-off runtime evidence for branch reviews.
--
-- The API server is the control plane only. Execution artifacts are metadata
-- and bounded inline summaries produced by an isolated worker, not customer
-- code executed inside the API process.

ALTER TABLE `review_repos` ADD COLUMN `pr_execution_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE `reviews` ADD COLUMN `execution_status` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD COLUMN `execution_summary_md` text;--> statement-breakpoint

CREATE TABLE `review_execution_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`summary_md` text NOT NULL,
	`storage_key` text,
	`inline_body` text,
	`mime_type` text,
	`sha256` text,
	`byte_size` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`kind` IN ('log','screenshot','api_trace','generated_test','video','file')),
	CHECK (`inline_body` IS NULL OR length(`inline_body`) <= 32768)
);--> statement-breakpoint
CREATE INDEX `review_execution_artifacts_review_idx` ON `review_execution_artifacts` (`review_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `review_execution_artifacts_kind_idx` ON `review_execution_artifacts` (`kind`);
