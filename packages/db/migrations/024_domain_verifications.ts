import { type Kysely, sql } from 'kysely';

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('domain_verifications')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('target_id', 'uuid', (c) => c.notNull().references('targets.id'))
    .addColumn('domain', 'text', (c) => c.notNull())
    .addColumn('token', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) =>
      c.notNull().defaultTo('pending').check(sql`status IN ('pending','verified','expired')`),
    )
    .addColumn('verified_at', 'timestamptz')
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('domain_verifications_target_id_unique', ['target_id'])
    .execute();

  await sql`CREATE INDEX idx_domain_verif_expires ON domain_verifications (expires_at)
    WHERE status = 'pending'`.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('domain_verifications').ifExists().execute();
};
