-- 0015_agent_api_tokens.sql
-- First-class bearer tokens for CLI and MCP access.
--
-- Tokens are returned to the dashboard once on creation and are never stored
-- plaintext. `token_hash` is SHA-256 over the full token, while
-- `token_prefix` is display-only metadata for humans to identify a token.

CREATE TABLE `agent_api_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
  `name` text NOT NULL,
  `token_hash` text NOT NULL,
  `token_prefix` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `last_used_at` integer,
  `revoked_at` integer
);

CREATE UNIQUE INDEX `agent_api_tokens_token_hash_uq`
  ON `agent_api_tokens` (`token_hash`);
CREATE INDEX `agent_api_tokens_user_idx`
  ON `agent_api_tokens` (`user_id`, `created_at`);
