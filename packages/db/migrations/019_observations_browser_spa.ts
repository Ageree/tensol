import { type Kysely, sql } from 'kysely';

// Migration 019 — SPA route discovery columns for observations_browser (Sprint 16).
//
// Adds three columns to record how a browser observation was discovered:
//   source_url       — URL of the page that triggered the SPA navigation (NULL for initial nav)
//   depth            — crawl depth (0 = initial navigation, 1+ = discovered route)
//   discovery_method — 'initial_navigation' | 'pushstate' | 'popstate'
//
// observations_browser is NOT append-only (mutable updated_at, no enforce_append_only triggers).
// Existing rows get depth=0 and discovery_method='initial_navigation' via column defaults.

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const up = async (db: Kysely<any>): Promise<void> => {
  await sql`
    ALTER TABLE observations_browser
      ADD COLUMN source_url        text,
      ADD COLUMN depth             integer NOT NULL DEFAULT 0,
      ADD COLUMN discovery_method  text    NOT NULL DEFAULT 'initial_navigation'
  `.execute(db);
};

// biome-ignore lint/suspicious/noExplicitAny: migrations operate on the structural db handle.
export const down = async (db: Kysely<any>): Promise<void> => {
  await sql`
    ALTER TABLE observations_browser
      DROP COLUMN IF EXISTS source_url,
      DROP COLUMN IF EXISTS depth,
      DROP COLUMN IF EXISTS discovery_method
  `.execute(db);
};
