import { type Kysely, sql } from 'kysely';

// Migration 027 — EE-2 (2026-05-12) HMAC-SHA256 audit signing.
//
// Adds:
//   1. tenants.audit_key (bytea, NOT NULL, default = 32 random bytes via pgcrypto)
//      — per-tenant symmetric key used to HMAC every audit row.
//   2. audit_events.signature (text, NULL allowed during rollout so historical
//      rows without signatures don't break the append-only invariant)
//      — base64-url-encoded HMAC-SHA256 of the canonical audit message.
//
// HMAC-SHA256 was chosen over Ed25519 for MVP: symmetric is faster, simpler
// key rotation, and "the auditor verifies with the same secret they were
// shown" is acceptable for v1. Ed25519 reserved for enterprise SKU where
// clients want self-verifiable evidence with a public key.
//
// Why bytea over text(64-hex): keeps the raw 256-bit key without hex/base64
// round-tripping in the hot path (every emitAudit call reads this).
//
// audit_events.signature is NULLABLE on purpose:
//   - audit_events is append-only with BEFORE UPDATE/DELETE triggers (mig 011).
//   - We CAN'T backfill signatures for historical rows (no key to sign with —
//     keys are generated lazily on rollout).
//   - emitAudit writes signature on EVERY new row going forward (EE-2.3).
//   - Verification path tolerates NULL signature on pre-EE-2 rows (treated as
//     "legacy, no integrity guarantee") and asserts non-NULL on post-EE-2 rows.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  // pgcrypto extension is already loaded by mig 001 (gen_random_uuid).
  // gen_random_bytes(32) → 256-bit key.

  await sql`
    ALTER TABLE tenants
      ADD COLUMN audit_key bytea NOT NULL DEFAULT gen_random_bytes(32)
  `.execute(db);

  await sql`
    ALTER TABLE audit_events
      ADD COLUMN signature text
  `.execute(db);

  // Append-only trigger (mig 011) blocks UPDATE on existing rows, so the
  // ALTER above sets the default only on NEW writes. Existing tenants need
  // a one-shot UPDATE to receive their key — but since tenants is NOT
  // append-only (no trigger on it), this works without trigger bypass.
  await sql`UPDATE tenants SET audit_key = gen_random_bytes(32) WHERE audit_key IS NULL`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await sql`ALTER TABLE audit_events DROP COLUMN signature`.execute(db);
  await sql`ALTER TABLE tenants DROP COLUMN audit_key`.execute(db);
};
