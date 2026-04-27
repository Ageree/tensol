import { type Kysely, sql } from 'kysely';
import { attachAppendOnlyTriggers, dropAppendOnlyTriggers } from './_common.ts';

// Migration 012 — llm_audit_events. APPEND-ONLY. Triggers attached using
// the shared enforce_append_only() function from migration 011.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('llm_audit_events')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('assessment_id', 'uuid', (c) => c.references('assessments.id'))
    .addColumn('model_id', 'text', (c) => c.notNull())
    .addColumn('request_hash', sql`char(64)`, (c) =>
      c.notNull().check(sql`request_hash ~ '^[a-f0-9]{64}$'`),
    )
    .addColumn('response_hash', sql`char(64)`, (c) =>
      c.notNull().check(sql`response_hash ~ '^[a-f0-9]{64}$'`),
    )
    .addColumn('prompt_tokens', 'integer')
    .addColumn('completion_tokens', 'integer')
    .addColumn('cost_usd_micros', 'bigint')
    .addColumn('trace_id', 'text', (c) => c.notNull())
    .addColumn('occurred_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX idx_llm_audit_events_tenant ON llm_audit_events (tenant_id)`.execute(db);
  await sql`CREATE INDEX idx_llm_audit_events_occurred ON llm_audit_events (tenant_id, occurred_at DESC)`.execute(
    db,
  );

  await attachAppendOnlyTriggers(db, 'llm_audit_events');
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await dropAppendOnlyTriggers(db, 'llm_audit_events');
  await db.schema.dropTable('llm_audit_events').ifExists().execute();
};
