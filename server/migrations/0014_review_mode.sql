-- 0014_review_mode.sql
-- Deep Research (F1) per-review opt-in. Adds `mode` to `reviews` so a registered
-- dashboard user can request the OpenHack-derived multi-agent DEEP research
-- pipeline per scan, instead of the fast single-pass path.
--
-- Additive ONLY: one new TEXT column, NOT NULL with a constant default — applies
-- cleanly on SQLite (which only supports ADD COLUMN with a constant/NULL
-- default). Existing rows and every existing caller default to 'fast', so prior
-- behavior is byte-for-byte unchanged. The TS `reviews` table in
-- src/db/schema.ts mirrors this exactly. Values: 'fast' | 'deep' (plain TEXT,
-- no CHECK — adding a mode later needs no schema migration).

ALTER TABLE `reviews` ADD COLUMN `mode` text DEFAULT 'fast' NOT NULL;
