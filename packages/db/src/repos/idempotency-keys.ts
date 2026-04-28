// IdempotencyKeysRepo — Sprint 5 / R2.
//
// Read- and insert-only over `idempotency_keys`. Rows are never updated:
// either we win the (tenant_id, key) unique-on-PK race and insert, or the
// caller observes the winner's row and replays it.
//
// Sprint 5 R2 invariant: ONLY 2xx responses persist. The `insert()` method
// throws if asked to cache a non-2xx status. The lookup also defends:
// `find()` returns null for cached rows whose `response_status` is outside
// [200, 300) — defence in depth in case a future code path bypassed the
// insert guard.

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database, IdempotencyKeysTable } from '../schema.ts';

export interface IdempotencyLookupArgs {
  readonly tenantId: string;
  readonly key: string;
}

export interface IdempotencyInsertArgs {
  readonly tenantId: string;
  readonly key: string;
  readonly actorId: string;
  readonly routeMethod: string;
  readonly routePath: string;
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

export type IdempotencyRow = Selectable<IdempotencyKeysTable>;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const isCacheable = (status: number): boolean => status >= 200 && status < 300;

export class IdempotencyKeysRepo {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  /**
   * Look up a cached row. Returns null if:
   *   - no row exists,
   *   - row exists but is older than 24h (stale; treat as MISS),
   *   - row exists but its `response_status` is outside [200, 300) (R2
   *     defence-in-depth — we never cached one of these via insert(), but
   *     guard the read path too).
   */
  async find(
    args: IdempotencyLookupArgs,
    nowMs: number = Date.now(),
  ): Promise<IdempotencyRow | null> {
    const row = await this.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('tenant_id', '=', args.tenantId)
      .where('key', '=', args.key)
      .executeTakeFirst();
    if (!row) return null;
    const ageMs = nowMs - new Date(row.created_at).getTime();
    if (ageMs > TWENTY_FOUR_HOURS_MS) return null;
    if (!isCacheable(row.response_status)) return null;
    return row;
  }

  /**
   * Insert a cache row. THROWS if `responseStatus` is not 2xx — the only
   * reason this would be called with a non-2xx status is a programming bug
   * in the middleware. Failing loudly here protects R2.
   *
   * Concurrent-duplicate races: PK on (tenant_id, key) makes one INSERT win.
   * The loser must catch the unique-violation and re-run find(). Callers
   * use `onConflict.doNothing()` semantics — see `findOrInsert()` below.
   */
  async insert(args: IdempotencyInsertArgs): Promise<IdempotencyRow> {
    if (!isCacheable(args.responseStatus)) {
      throw new Error(
        `idempotency_keys.insert: refusing to cache non-2xx status ${args.responseStatus} (R2)`,
      );
    }
    const values: Insertable<IdempotencyKeysTable> = {
      tenant_id: args.tenantId,
      key: args.key,
      actor_id: args.actorId,
      route_method: args.routeMethod,
      route_path: args.routePath,
      request_hash: args.requestHash,
      response_status: args.responseStatus,
      // biome-ignore lint/suspicious/noExplicitAny: Json boundary.
      response_body: args.responseBody as any,
    };
    const row = await this.db
      .insertInto('idempotency_keys')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
    return row;
  }

  /**
   * Insert-if-absent. Returns the inserted row OR the pre-existing row. Used
   * by the middleware after the handler runs successfully (2xx) — the loser
   * of a concurrent race observes the winner's body and re-emits it.
   */
  async findOrInsert(args: IdempotencyInsertArgs): Promise<IdempotencyRow> {
    if (!isCacheable(args.responseStatus)) {
      throw new Error(
        `idempotency_keys.findOrInsert: refusing to cache non-2xx status ${args.responseStatus} (R2)`,
      );
    }
    const inserted = await this.db
      .insertInto('idempotency_keys')
      .values({
        tenant_id: args.tenantId,
        key: args.key,
        actor_id: args.actorId,
        route_method: args.routeMethod,
        route_path: args.routePath,
        request_hash: args.requestHash,
        response_status: args.responseStatus,
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary.
        response_body: args.responseBody as any,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted;
    // Lost the race — read the winner.
    const winner = await this.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('tenant_id', '=', args.tenantId)
      .where('key', '=', args.key)
      .executeTakeFirstOrThrow();
    return winner;
  }
}
