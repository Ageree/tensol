import { type Kysely, sql } from 'kysely';

export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('target_authorizations')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('target_id', 'uuid', (c) => c.notNull().references('targets.id').onDelete('cascade'))
    .addColumn('method', 'text', (c) =>
      c.notNull().check(sql`method IN ('dns_txt','file_upload','whois_email')`),
    )
    .addColumn('token_hash', 'char(64)', (c) => c.notNull())
    .addColumn('token_plaintext', 'text')
    .addColumn('email_recipient', 'text')
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('pending')
        .check(sql`status IN ('pending','verified','failed','expired')`),
    )
    .addColumn('verified_at', 'timestamptz')
    .addColumn('consumed_at', 'timestamptz')
    .addColumn('expires_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now() + interval '24 hours'`),
    )
    .addColumn('attempt_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`CREATE INDEX idx_target_auth_target_status ON target_authorizations (target_id, status)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_target_auth_token_hash ON target_authorizations (token_hash) WHERE status='pending'`.execute(
    db,
  );
  await sql`CREATE INDEX idx_target_auth_expires ON target_authorizations (expires_at) WHERE status='pending'`.execute(
    db,
  );
};

export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('target_authorizations').ifExists().execute();
};
