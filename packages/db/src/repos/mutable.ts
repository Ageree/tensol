// MutableRepository<T>
//
// Standard CRUD with two security-critical features:
//   - optimistic locking via `version` column (B20–B22).
//   - `onCrossTenantAttempt` hook fired when SELECT-by-id finds a row that
//     belongs to a different tenant than the active context. Sprint 4 wires
//     this to denyAudit; Sprint 2 just defines + tests the contract (B19b).

import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import { OptimisticLockError } from '../errors.ts';
import type { Database } from '../schema.ts';
import { resolveTenantId } from '../tenant-context.ts';

export interface CrossTenantAttempt {
  readonly actorTenantId: string;
  readonly rowTenantId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly operation: 'find' | 'update' | 'delete';
  readonly occurredAt: Date;
}

export interface MutableRepoConfig {
  readonly resourceType: string;
  readonly versioned?: boolean;
  readonly onCrossTenantAttempt?: ((event: CrossTenantAttempt) => void) | undefined;
}

interface RowWithTenant {
  tenant_id: string;
  id: string;
  version?: number;
}

export class MutableRepository<TableName extends keyof Database> {
  protected readonly db: Kysely<Database>;
  protected readonly table: TableName;
  protected readonly resourceType: string;
  protected readonly versioned: boolean;
  protected readonly onCrossTenantAttempt: ((event: CrossTenantAttempt) => void) | undefined;

  constructor(db: Kysely<Database>, table: TableName, config: MutableRepoConfig) {
    this.db = db;
    this.table = table;
    this.resourceType = config.resourceType;
    this.versioned = config.versioned ?? false;
    this.onCrossTenantAttempt = config.onCrossTenantAttempt;
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
      // biome-ignore lint/suspicious/noExplicitAny: Kysely insert generic resolution.
      .insertInto(this.table as any)
      // biome-ignore lint/suspicious/noExplicitAny: insert payload boundary.
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
    const row = (await this.db
      // biome-ignore lint/suspicious/noExplicitAny: column names guaranteed by schema convention.
      .selectFrom(this.table as any)
      .selectAll()
      // biome-ignore lint/suspicious/noExplicitAny: id column guaranteed.
      .where('id' as any, '=', id)
      .executeTakeFirst()) as RowWithTenant | undefined;

    if (!row) return null;

    if (row.tenant_id !== resolved) {
      this.fireCrossTenantHook(resolved, row.tenant_id, id, 'find');
      return null;
    }

    return row as unknown as Selectable<Database[TableName]>;
  }

  async findAll(
    tenantId: string | undefined,
  ): Promise<ReadonlyArray<Selectable<Database[TableName]>>> {
    const resolved = resolveTenantId({
      explicit: tenantId,
      resourceType: this.resourceType,
      operation: 'find',
    });
    const rows = await this.db
      // biome-ignore lint/suspicious/noExplicitAny: column names guaranteed by schema convention.
      .selectFrom(this.table as any)
      .selectAll()
      // biome-ignore lint/suspicious/noExplicitAny: tenant_id column guaranteed.
      .where('tenant_id' as any, '=', resolved)
      .execute();
    return rows as ReadonlyArray<Selectable<Database[TableName]>>;
  }

  async count(tenantId: string | undefined): Promise<number> {
    const resolved = resolveTenantId({
      explicit: tenantId,
      resourceType: this.resourceType,
      operation: 'count',
    });
    const result = (await this.db
      // biome-ignore lint/suspicious/noExplicitAny: column names guaranteed by schema convention.
      .selectFrom(this.table as any)
      // biome-ignore lint/suspicious/noExplicitAny: tenant_id column guaranteed.
      .where('tenant_id' as any, '=', resolved)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow()) as { count: string };
    return Number(result.count);
  }

  /**
   * Update rows scoped to the active tenant.
   * If `versioned`, requires `expectedVersion` and fails with OptimisticLockError on mismatch.
   * Returns `{ updated: 0 }` when the row exists but belongs to another tenant — and fires the
   * cross-tenant audit hook (B19b).
   */
  async update(
    tenantId: string | undefined,
    id: string,
    values: Updateable<Database[TableName]>,
    expectedVersion?: number,
  ): Promise<{ updated: number }> {
    const resolved = resolveTenantId({
      explicit: tenantId,
      resourceType: this.resourceType,
      operation: 'update',
    });

    // Cross-tenant detection: read the row first to know if it exists in *another* tenant.
    const existing = (await this.db
      // biome-ignore lint/suspicious/noExplicitAny: column names guaranteed by schema convention.
      .selectFrom(this.table as any)
      // biome-ignore lint/suspicious/noExplicitAny: id column guaranteed.
      .select(['tenant_id', 'id'] as any)
      // biome-ignore lint/suspicious/noExplicitAny: id column guaranteed.
      .where('id' as any, '=', id)
      .executeTakeFirst()) as { tenant_id: string; id: string } | undefined;

    if (existing && existing.tenant_id !== resolved) {
      this.fireCrossTenantHook(resolved, existing.tenant_id, id, 'update');
      return { updated: 0 };
    }

    if (this.versioned) {
      if (expectedVersion === undefined) {
        throw new Error(`${this.resourceType}.update requires expectedVersion (versioned table)`);
      }
      // SET version = version + 1, updated_at = now(), <values...>
      // WHERE id = $ AND tenant_id = $ AND version = $expectedVersion
      // numUpdatedRows = 0 → version mismatch → OptimisticLockError.
      const { sql: kysq } = await import('kysely');
      const result = await this.db
        // biome-ignore lint/suspicious/noExplicitAny: kysely generic boundary.
        .updateTable(this.table as any)
        .set({
          ...(values as Record<string, unknown>),
          version: kysq`version + 1`,
          updated_at: kysq`now()`,
        } as Record<string, unknown>)
        // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
        .where('id' as any, '=', id)
        // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
        .where('tenant_id' as any, '=', resolved)
        // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
        .where('version' as any, '=', expectedVersion)
        .executeTakeFirst();

      const updated = Number(result.numUpdatedRows ?? 0n);
      if (updated === 0) {
        throw new OptimisticLockError({
          resourceType: this.resourceType,
          resourceId: id,
          expectedVersion,
        });
      }
      return { updated };
    }

    const result = await this.db
      // biome-ignore lint/suspicious/noExplicitAny: kysely generic boundary.
      .updateTable(this.table as any)
      // biome-ignore lint/suspicious/noExplicitAny: payload typing boundary.
      .set(values as any)
      // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
      .where('id' as any, '=', id)
      // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
      .where('tenant_id' as any, '=', resolved)
      .executeTakeFirst();

    return { updated: Number(result.numUpdatedRows ?? 0n) };
  }

  async delete(tenantId: string | undefined, id: string): Promise<{ deleted: number }> {
    const resolved = resolveTenantId({
      explicit: tenantId,
      resourceType: this.resourceType,
      operation: 'delete',
    });

    const existing = (await this.db
      // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
      .selectFrom(this.table as any)
      // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
      .select(['tenant_id', 'id'] as any)
      // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
      .where('id' as any, '=', id)
      .executeTakeFirst()) as { tenant_id: string; id: string } | undefined;

    if (existing && existing.tenant_id !== resolved) {
      this.fireCrossTenantHook(resolved, existing.tenant_id, id, 'delete');
      return { deleted: 0 };
    }

    const result = await this.db
      // biome-ignore lint/suspicious/noExplicitAny: kysely generic boundary.
      .deleteFrom(this.table as any)
      // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
      .where('id' as any, '=', id)
      // biome-ignore lint/suspicious/noExplicitAny: schema-known columns.
      .where('tenant_id' as any, '=', resolved)
      .executeTakeFirst();

    return { deleted: Number(result.numDeletedRows ?? 0n) };
  }

  private fireCrossTenantHook(
    actorTenantId: string,
    rowTenantId: string,
    resourceId: string,
    operation: 'find' | 'update' | 'delete',
  ): void {
    if (!this.onCrossTenantAttempt) return;
    try {
      this.onCrossTenantAttempt({
        actorTenantId,
        rowTenantId,
        resourceType: this.resourceType,
        resourceId,
        operation,
        occurredAt: new Date(),
      });
    } catch {
      // Audit hook must never break the calling query path.
    }
  }
}
