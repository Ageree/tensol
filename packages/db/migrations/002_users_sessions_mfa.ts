import { type Kysely, sql } from 'kysely';

// Migration 002 — users, user_sessions, mfa_secrets.

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) =>
      c.notNull().defaultTo('active').check(sql`status IN ('active', 'disabled', 'pending')`),
    )
    .addColumn('role', 'text', (c) =>
      c
        .notNull()
        .check(
          sql`role IN ('platform_admin','tenant_admin','security_lead','operator','developer','auditor','viewer')`,
        ),
    )
    .addColumn('mfa_enrolled', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('users_tenant_email_unique', ['tenant_id', 'email'])
    .execute();
  await sql`CREATE INDEX idx_users_tenant ON users (tenant_id)`.execute(db);

  await db.schema
    .createTable('user_sessions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('token_hash', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('user_sessions_tenant_token_unique', ['tenant_id', 'token_hash'])
    .execute();
  await sql`CREATE INDEX idx_user_sessions_tenant ON user_sessions (tenant_id)`.execute(db);

  await db.schema
    .createTable('mfa_secrets')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('secret_encrypted', 'text', (c) => c.notNull())
    .addColumn('algo', 'text', (c) => c.notNull().defaultTo('SHA1'))
    .addColumn('digits', 'integer', (c) => c.notNull().defaultTo(6))
    .addColumn('period_seconds', 'integer', (c) => c.notNull().defaultTo(30))
    .addColumn('enrolled_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('mfa_secrets_tenant_user_unique', ['tenant_id', 'user_id'])
    .execute();
  await sql`CREATE INDEX idx_mfa_secrets_tenant ON mfa_secrets (tenant_id)`.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('mfa_secrets').ifExists().execute();
  await db.schema.dropTable('user_sessions').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();
};
