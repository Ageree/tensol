-- 0011_webhook_dedup.sql
-- T-step-6c — Replace O(n) LIKE-scan idempotency on audit_log.metadata_json with
-- a dedicated O(1) UNIQUE-constraint dedup table.
--
-- Background:
--   `webhooks-scan-complete.ts` originally used a `LIKE '%scan_order_id%'`
--   query against `audit_log.metadata_json` to detect replay deliveries. That
--   query is O(n) over the entire audit_log and becomes a hot-path concern
--   at scale (every webhook delivery scans every prior audit row).
--
-- This migration introduces `webhook_dedup`:
--   - PK `id` (ULID)
--   - `webhook_kind`  (e.g. 'scan_complete') — future-proofs other kinds.
--   - `dedup_key`     (e.g. scan_order_id)   — the actual idempotency anchor.
--   - `received_at`   unix ms of first acceptance.
--   - `metadata_json` opaque diag blob.
--   - UNIQUE (webhook_kind, dedup_key) — provides O(1) collision via INSERT
--     attempt; SQLITE_CONSTRAINT_UNIQUE on second delivery → 200 duplicate.
--
-- The `webhook_received` audit row (Constitution X: post-commit signed audit)
-- remains unchanged — audit chain and dedup are now two separate concerns.

CREATE TABLE `webhook_dedup` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_kind` text NOT NULL,
	`dedup_key` text NOT NULL,
	`received_at` integer NOT NULL,
	`metadata_json` text
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_webhook_dedup_kind_key` ON `webhook_dedup` (`webhook_kind`,`dedup_key`);--> statement-breakpoint
CREATE INDEX `idx_webhook_dedup_kind_received_at` ON `webhook_dedup` (`webhook_kind`,`received_at` DESC);
