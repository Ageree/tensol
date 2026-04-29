import { type Kysely, sql } from 'kysely';

// Migration 017 — Sprint 13: add langgraph_thread_id to decepticon_sessions.
//
// Nullable text column. Populated by startDecepticonSession when the
// RealDecepticonAdapter creates a thread on the LangGraph Platform endpoint.
// FakeDecepticonAdapter leaves it NULL. Enables tracing real engagements back
// to their upstream LangGraph thread without a separate lookup table.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await sql`ALTER TABLE decepticon_sessions ADD COLUMN IF NOT EXISTS langgraph_thread_id text`.execute(
    db,
  );
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await sql`ALTER TABLE decepticon_sessions DROP COLUMN IF EXISTS langgraph_thread_id`.execute(db);
};
