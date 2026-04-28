import { type Kysely, sql } from 'kysely';
import { attachAppendOnlyTriggers, dropAppendOnlyTriggers } from './_common.ts';

// Migration 016 — Sprint 5 schema.
//
// Ships four tables + one column add:
//   1. assessment_targets — many-to-many join (assessments × targets).
//   2. idempotency_keys — Idempotency-Key cache for state-transition POSTs.
//      Sprint 5 R2: insert path persists ONLY 2xx responses; 4xx/5xx never
//      write a cache row. The DB schema doesn't constrain this — the
//      middleware in apps/api/src/middleware/idempotency.ts does (defence
//      in depth: the lookup path also gates on response_status ∈ [200,300)).
//   3. target_ownership_claims — append-only history of ownership-proof
//      submissions. Path A from Sprint 5 contract A-Tgt-Schema-1 / OQ-3.
//   4. assessment_approvals — append-only forensic record of approvals.
//      Sprint 5 contract R5 (Path B). Hot-path columns (`approved_by`,
//      `approved_at`) live on `assessments` for fast list/summary queries.
//
// Plus: ALTER TABLE assessments ADD COLUMN approved_at TIMESTAMPTZ NULL.
// (`approved_by` is already on assessments since migration 004.)
//
// Append-only triggers attached via the shared helper from migration 011 —
// statement-level UPDATE/DELETE catches WHERE-1=0 attack (Sprint 2 F1 fix).

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  // 1. assessment_targets — N:N join. Tenant-id denormalised so tenant-scoped
  //    queries stay single-table (no join through assessments or targets).
  await db.schema
    .createTable('assessment_targets')
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('target_id', 'uuid', (c) => c.notNull().references('targets.id'))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('assessment_targets_pk', ['assessment_id', 'target_id'])
    .execute();
  await sql`CREATE INDEX idx_assessment_targets_tenant_assessment ON assessment_targets (tenant_id, assessment_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_assessment_targets_tenant_target ON assessment_targets (tenant_id, target_id)`.execute(
    db,
  );

  // 2. idempotency_keys — request-cache for state-transition POSTs (R2).
  //    PK on (tenant_id, key) provides natural concurrent-duplicate dedup.
  await db.schema
    .createTable('idempotency_keys')
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('actor_id', 'text', (c) => c.notNull())
    .addColumn('route_method', 'text', (c) => c.notNull())
    .addColumn('route_path', 'text', (c) => c.notNull())
    .addColumn('request_hash', 'text', (c) => c.notNull())
    .addColumn('response_status', 'integer', (c) => c.notNull())
    .addColumn('response_body', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('idempotency_keys_pk', ['tenant_id', 'key'])
    .execute();
  await sql`CREATE INDEX idx_idempotency_keys_created ON idempotency_keys (created_at)`.execute(db);
  await sql`COMMENT ON COLUMN idempotency_keys.response_body IS 'purpose=cached_2xx_response_body; expected_size_bytes=8192; if_larger=externalize_via_object_storage'`.execute(
    db,
  );

  // 3. target_ownership_claims — append-only. Each POST /targets/:id/ownership-proof
  //    inserts one row. Audit invariant requires reconstructing who claimed
  //    what when; JSONB overwrite would lose history.
  await db.schema
    .createTable('target_ownership_claims')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('target_id', 'uuid', (c) => c.notNull().references('targets.id'))
    .addColumn('method', 'text', (c) =>
      c.notNull().check(sql`method IN ('dns_txt','http_meta','manual_attestation')`),
    )
    .addColumn('evidence', 'text', (c) => c.notNull())
    .addColumn('submitted_by_user_id', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('submitted_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_target_ownership_claims_tenant_target_submitted ON target_ownership_claims (tenant_id, target_id, submitted_at DESC)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN target_ownership_claims.evidence IS 'purpose=ownership_proof_evidence_blob; expected_size_bytes=8192; if_larger=externalize_via_object_storage'`.execute(
    db,
  );

  // 4. assessment_approvals — append-only (Path B from contract R5).
  await db.schema
    .createTable('assessment_approvals')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.notNull().references('assessments.id'))
    .addColumn('approved_by', 'uuid', (c) => c.notNull().references('users.id'))
    .addColumn('approved_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('target_count', 'integer', (c) => c.notNull())
    .addColumn('high_impact_categories', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_assessment_approvals_tenant_assessment ON assessment_approvals (tenant_id, assessment_id, approved_at DESC)`.execute(
    db,
  );
  await sql`COMMENT ON COLUMN assessment_approvals.high_impact_categories IS 'purpose=approval_snapshot_categories; expected_size_bytes=128; if_larger=N/A — array of fixed enum strings'`.execute(
    db,
  );

  // 5. ALTER assessments — add hot-path approved_at column. approved_by
  //    already exists since migration 004.
  await sql`ALTER TABLE assessments ADD COLUMN approved_at TIMESTAMPTZ NULL`.execute(db);

  // Append-only triggers (Sprint 2 F1: statement-level catches WHERE-1=0).
  await attachAppendOnlyTriggers(db, 'target_ownership_claims');
  await attachAppendOnlyTriggers(db, 'assessment_approvals');
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await dropAppendOnlyTriggers(db, 'assessment_approvals');
  await dropAppendOnlyTriggers(db, 'target_ownership_claims');
  await sql`ALTER TABLE assessments DROP COLUMN IF EXISTS approved_at`.execute(db);
  await db.schema.dropTable('assessment_approvals').ifExists().execute();
  await db.schema.dropTable('target_ownership_claims').ifExists().execute();
  await db.schema.dropTable('idempotency_keys').ifExists().execute();
  await db.schema.dropTable('assessment_targets').ifExists().execute();
};
