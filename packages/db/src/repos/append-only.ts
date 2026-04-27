// AppendOnlyRepository<T>
//
// Insert-only repository base. The TYPE never exposes update/delete/upsert
// methods, and the runtime instance never has those properties on its
// prototype. This is the type-level half of the append-only invariant; the
// Postgres triggers in migrations 005/010/011/012 are the database half.
//
// Sprint 2 contract B15 / B15a / B15b.

import type { Insertable, Kysely, SelectQueryBuilder, Selectable } from 'kysely';
import type { Database } from '../schema.ts';
import { resolveTenantId } from '../tenant-context.ts';

export interface AppendOnlyRepoConfig {
  readonly resourceType: string;
}

export class AppendOnlyRepository<TableName extends keyof Database> {
  protected readonly db: Kysely<Database>;
  protected readonly table: TableName;
  protected readonly resourceType: string;

  constructor(db: Kysely<Database>, table: TableName, config: AppendOnlyRepoConfig) {
    this.db = db;
    this.table = table;
    this.resourceType = config.resourceType;
  }

  async insert(
    tenantId: string | undefined,
    values: Insertable<Database[TableName]>,
  ): Promise<Selectable<Database[TableName]>> {
    const resolved = resolveTenantId({
      explicit: tenantId,
      resourceType: this.resourceType,
      operation: 'insert',
    });
    const withTenant = { ...(values as Record<string, unknown>), tenant_id: resolved };
    const row = await this.db
      // biome-ignore lint/suspicious/noExplicitAny: Kysely insert generic resolution requires a cast at the boundary.
      .insertInto(this.table as any)
      // biome-ignore lint/suspicious/noExplicitAny: Generic insert payload accepted by Kysely runtime.
      .values(withTenant as any)
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as Selectable<Database[TableName]>;
  }

  async findById(
    tenantId: string | undefined,
    id: string,
  ): Promise<Selectable<Database[TableName]> | null> {
    const resolved = resolveTenantId({
      explicit: tenantId,
      resourceType: this.resourceType,
      operation: 'find',
    });
    const row = await (this.baseQuery() as SelectQueryBuilder<Database, TableName, unknown>)
      // biome-ignore lint/suspicious/noExplicitAny: tenant_id / id columns guaranteed by schema convention.
      .where('tenant_id' as any, '=', resolved)
      // biome-ignore lint/suspicious/noExplicitAny: id column guaranteed for every aggregate.
      .where('id' as any, '=', id)
      .selectAll()
      .executeTakeFirst();
    return (row ?? null) as Selectable<Database[TableName]> | null;
  }

  async count(tenantId: string | undefined): Promise<number> {
    const resolved = resolveTenantId({
      explicit: tenantId,
      resourceType: this.resourceType,
      operation: 'count',
    });
    const result = (await (this.baseQuery() as SelectQueryBuilder<Database, TableName, unknown>)
      // biome-ignore lint/suspicious/noExplicitAny: tenant_id column guaranteed by schema convention.
      .where('tenant_id' as any, '=', resolved)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow()) as { count: string };
    return Number(result.count);
  }

  protected baseQuery() {
    // biome-ignore lint/suspicious/noExplicitAny: Kysely's selectFrom generic narrow.
    return this.db.selectFrom(this.table as any);
  }
}
