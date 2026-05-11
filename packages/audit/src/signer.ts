// EE-2 (2026-05-12) — production audit signer backed by `tenants.audit_key`.
//
// Lookup-per-emit. Not cached in-process: tenants.audit_key can rotate via
// admin tooling, and stale cache would invalidate verification. The SELECT
// is ~1ms on a btree primary-key lookup — acceptable overhead for audit
// rows (which are not in any user-facing hot path).
//
// Returns null only when the tenant row has NULL audit_key (legacy data).
// Throws on DB errors; emitAudit's try/catch logs + writes the row unsigned.

import type { Database } from '@cyberstrike/db';
import type { Kysely } from 'kysely';
import { type AuditSigner, type EmitAuditArgs, emitAudit, hmacSign } from './writer.ts';

export const createDbAuditSigner = (db: Kysely<Database>): AuditSigner => ({
  sign: async (tenantId, canonicalMessage) => {
    const row = await db
      .selectFrom('tenants')
      .select(['audit_key'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!row || !row.audit_key) return null;
    const key = Buffer.isBuffer(row.audit_key) ? row.audit_key : Buffer.from(row.audit_key);
    return hmacSign(key, canonicalMessage);
  },
});

/**
 * EE-2 — convenience wrapper for production emitters: signs every row via
 * `createDbAuditSigner(db)`. Equivalent to:
 *
 *   emitAudit({ db, signer: createDbAuditSigner(db) }, args);
 *
 * Use this at every non-test call site instead of bare `emitAudit({db},...)`.
 */
export const emitSignedAudit = (db: Kysely<Database>, args: EmitAuditArgs): Promise<void> =>
  emitAudit({ db, signer: createDbAuditSigner(db) }, args);
