import { type Kysely, sql } from 'kysely';

// Migration 021 — Sprint 18: OOB callback log table.
//
// Records every inbound HTTP/DNS callback received by the oob-receiver service
// during SSRF replay validation. Append-only (no UPDATE trigger needed — rows
// are never updated; DELETE+TRUNCATE guards prevent tampering).
//
// No FK constraints on tenant_id or candidate_id — the receiver runs at
// network edge and must not be blocked by candidate row presence; token-based
// correlation is the design (contract R2 option a).

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('oob_callbacks')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid')
    .addColumn('candidate_id', 'uuid')
    .addColumn('token', 'text')
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('method', 'text')
    .addColumn('path', 'text')
    .addColumn('qname', 'text')
    .addColumn('qtype', 'text')
    .addColumn('headers', 'jsonb')
    .addColumn('body', 'text')
    .addColumn('source_ip', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    ALTER TABLE oob_callbacks
      ADD CONSTRAINT oob_callbacks_kind_check
      CHECK (kind IN ('http', 'dns'))
  `.execute(db);

  await sql`COMMENT ON COLUMN oob_callbacks.headers IS 'purpose=oob_callback_http_headers; expected_size_bytes=2048; if_larger=drop_oversized_values'`.execute(
    db,
  );

  await sql`
    CREATE INDEX idx_oob_callbacks_tenant ON oob_callbacks (tenant_id)
    WHERE tenant_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX idx_oob_callbacks_token ON oob_callbacks (token)
    WHERE token IS NOT NULL
  `.execute(db);

  // Append-only: DELETE trigger (statement-level — catches zero-row DELETE).
  await sql`
    CREATE TRIGGER oob_callbacks_no_delete_stmt
      BEFORE DELETE ON oob_callbacks
      FOR EACH STATEMENT EXECUTE FUNCTION enforce_append_only()
  `.execute(db);

  // Append-only: TRUNCATE trigger.
  await sql`
    CREATE TRIGGER oob_callbacks_no_truncate
      BEFORE TRUNCATE ON oob_callbacks
      FOR EACH STATEMENT EXECUTE FUNCTION enforce_append_only()
  `.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await sql`DROP TRIGGER IF EXISTS oob_callbacks_no_truncate ON oob_callbacks`.execute(db);
  await sql`DROP TRIGGER IF EXISTS oob_callbacks_no_delete_stmt ON oob_callbacks`.execute(db);
  await db.schema.dropTable('oob_callbacks').ifExists().execute();
};
