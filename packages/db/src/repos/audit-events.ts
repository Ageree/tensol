// AuditEventsRepo — Sprint 4 A11/A12.
//
// Tenant-aware read API for `audit_events`. Two invariants enforced at SQL
// level (instead of in callers, where regressions are easy):
//
//   1. tenant_id = $1 — the actor's tenant only.
//   2. tenant_id != (SELECT id FROM tenants WHERE slug = '__platform__')
//      — the unattributed sentinel never appears in a per-tenant aggregate.
//
// The repo is read-only (audit_events is append-only — Sprint 2 trigger
// invariant). Inserts go through `packages/audit:emitAudit`, never here.
//
// Cursor (A14 R2): opaque base64 of `{occurredAt: ISO, id: UUID}`.
// Sort: ORDER BY occurred_at DESC, id DESC (id tiebreak for same-timestamp).

import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { AuditEventsTable, Database } from '../schema.ts';

export const PLATFORM_TENANT_SLUG = '__platform__' as const;

export interface AuditEventCursor {
  readonly occurredAt: string;
  readonly id: string;
}

export interface AuditEventsPage {
  readonly rows: ReadonlyArray<Selectable<AuditEventsTable>>;
  readonly nextCursor: string | null;
}

export const encodeCursor = (cursor: AuditEventCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64');

export const decodeCursor = (raw: string): AuditEventCursor | null => {
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as Partial<AuditEventCursor>;
    if (
      typeof parsed.occurredAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      parsed.occurredAt.length === 0 ||
      parsed.id.length === 0
    ) {
      return null;
    }
    return { occurredAt: parsed.occurredAt, id: parsed.id };
  } catch {
    return null;
  }
};

export class AuditEventsRepo {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  /**
   * Per-tenant audit-events page. Excludes platform-sentinel rows.
   * Order: occurred_at DESC, id DESC. Cursor is exclusive.
   */
  async findForTenantPage(args: {
    tenantId: string;
    limit: number;
    cursor?: AuditEventCursor;
  }): Promise<AuditEventsPage> {
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit)));

    let q = this.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', args.tenantId)
      .where(
        sql<boolean>`tenant_id != (SELECT id FROM tenants WHERE slug = ${PLATFORM_TENANT_SLUG})`,
      )
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);

    if (args.cursor) {
      // Strict less-than on (occurred_at, id) lexicographic order. Postgres
      // supports row constructors directly.
      const occurredAt = new Date(args.cursor.occurredAt);
      q = q.where(sql<boolean>`(occurred_at, id) < (${occurredAt}, ${args.cursor.id})`);
    }

    const rows = await q.execute();
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const nextCursor: string | null =
      hasMore && last
        ? encodeCursor({ occurredAt: last.occurred_at.toISOString(), id: last.id })
        : null;

    return {
      rows: sliced,
      nextCursor,
    };
  }

  /** Used by tests + admin code. Same sentinel-exclusion guarantee. */
  async countForTenant(tenantId: string): Promise<number> {
    const row = await this.db
      .selectFrom('audit_events')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where(
        sql<boolean>`tenant_id != (SELECT id FROM tenants WHERE slug = ${PLATFORM_TENANT_SLUG})`,
      )
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
