import type { Kysely } from 'kysely';
import { sql } from 'kysely';

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await sql`
    CREATE TABLE api_tokens (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     uuid NOT NULL REFERENCES tenants(id),
      user_id       uuid NOT NULL REFERENCES users(id),
      token_hash    text NOT NULL,
      name          text NOT NULL,
      last_used_at  timestamptz,
      expires_at    timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (token_hash)
    )
  `.execute(db);

  await sql`CREATE INDEX idx_api_tokens_tenant ON api_tokens (tenant_id)`.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await sql`DROP TABLE IF EXISTS api_tokens`.execute(db);
};
