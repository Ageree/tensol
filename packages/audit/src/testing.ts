// Sprint 4 A18 — generalised C29 delta=1 helper.
//
// Re-usable across all integration suites. Sprint 5+ extends c29-delta.test.ts
// by appending new emission points; this helper is the only thing they call.
//
// Predicate is composed from the exact columns we set on `audit_events`:
//   action:      required.
//   tenantId:    optional. When present, scopes the count to one tenant.
//   actorId:     optional.
//   resourceId:  optional.
//   traceId:     optional.

import type { Database } from '@cyberstrike/db';
import type { Kysely } from 'kysely';

export interface AuditPredicate {
  readonly action: string;
  readonly tenantId?: string;
  readonly actorId?: string;
  readonly resourceId?: string;
  readonly traceId?: string;
}

export class AuditCardinalityError extends Error {
  public readonly expected = 1;
  public readonly observed: number;
  public readonly predicate: AuditPredicate;
  constructor(observed: number, predicate: AuditPredicate) {
    super(
      `Expected exactly 1 audit row matching ${JSON.stringify(predicate)}, observed ${observed}`,
    );
    this.name = 'AuditCardinalityError';
    this.observed = observed;
    this.predicate = predicate;
  }
}

const countMatching = async (db: Kysely<Database>, predicate: AuditPredicate): Promise<number> => {
  let q = db
    .selectFrom('audit_events')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('action', '=', predicate.action);
  if (predicate.tenantId) q = q.where('tenant_id', '=', predicate.tenantId);
  if (predicate.actorId) q = q.where('actor_id', '=', predicate.actorId);
  if (predicate.resourceId) q = q.where('resource_id', '=', predicate.resourceId);
  if (predicate.traceId) q = q.where('trace_id', '=', predicate.traceId);
  const row = await q.executeTakeFirstOrThrow();
  return Number(row.count);
};

/**
 * Asserts exactly one audit row matches the predicate. Throws
 * AuditCardinalityError on count != 1 — not a generic Error so the test
 * harness can pin failure modes precisely.
 */
export const assertExactlyOneAuditRow = async (
  db: Kysely<Database>,
  predicate: AuditPredicate,
): Promise<void> => {
  const observed = await countMatching(db, predicate);
  if (observed !== 1) {
    throw new AuditCardinalityError(observed, predicate);
  }
};

export const countAuditRows = countMatching;
