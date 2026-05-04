import type { Kysely } from 'kysely';
import { sql } from 'kysely';

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await sql`ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT true`.execute(db);

  await sql`
    CREATE TABLE subscriptions (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       uuid NOT NULL REFERENCES tenants(id),
      tier            text NOT NULL CHECK (tier IN ('light', 'medium', 'aggressive')),
      status          text NOT NULL DEFAULT 'trial'
                        CHECK (status IN ('trial', 'active', 'cancelled')),
      trial_ends_at   timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE invoices (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       uuid NOT NULL REFERENCES tenants(id),
      amount_kopecks  bigint NOT NULL DEFAULT 0,
      status          text NOT NULL DEFAULT 'mock'
                        CHECK (status IN ('mock', 'pending', 'paid', 'failed')),
      metadata        jsonb NOT NULL DEFAULT '{}',
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  // P30 invariant (B23b): every JSONB column must carry a COMMENT with
  // purpose=... and expected_size_bytes=... so future operators know what to
  // expect and when to externalize. invoices.metadata holds free-form
  // billing-stub metadata until real payment integration replaces this table.
  await sql`COMMENT ON COLUMN invoices.metadata IS 'purpose=billing_stub_metadata; expected_size_bytes=512; if_larger=replace_with_real_payment_integration'`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await sql`DROP TABLE IF EXISTS invoices`.execute(db);
  await sql`DROP TABLE IF EXISTS subscriptions`.execute(db);
  await sql`ALTER TABLE users DROP COLUMN IF EXISTS email_verified`.execute(db);
};
