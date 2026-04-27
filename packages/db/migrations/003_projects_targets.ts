import { type Kysely, sql } from 'kysely';

// Migration 003 — projects, targets. Targets get a version column for
// optimistic locking (Sprint 2 contract B20).

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('projects')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('status', 'text', (c) =>
      c.notNull().defaultTo('active').check(sql`status IN ('active', 'archived')`),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('projects_tenant_name_unique', ['tenant_id', 'name'])
    .execute();
  await sql`CREATE INDEX idx_projects_tenant ON projects (tenant_id)`.execute(db);

  await db.schema
    .createTable('targets')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('project_id', 'uuid', (c) => c.notNull().references('projects.id'))
    .addColumn('kind', 'text', (c) =>
      c
        .notNull()
        .check(sql`kind IN ('url','domain','ip','cidr','cloud_account','k8s_namespace','repo')`),
    )
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('ownership_status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('unverified')
        .check(sql`ownership_status IN ('unverified','pending','verified')`),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
    .addUniqueConstraint('targets_tenant_project_value_unique', [
      'tenant_id',
      'project_id',
      'kind',
      'value',
    ])
    .execute();
  await sql`CREATE INDEX idx_targets_tenant ON targets (tenant_id)`.execute(db);
  await sql`CREATE INDEX idx_targets_project ON targets (tenant_id, project_id)`.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: Kysely migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('targets').ifExists().execute();
  await db.schema.dropTable('projects').ifExists().execute();
};
