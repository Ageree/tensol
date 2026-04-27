// Typed Kysely instance factory.
//
// Tests use Bun's lazy module loading; this file does not connect on import.
// `createDatabase` is the only entry that opens a pool.

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './schema.ts';

export interface DbConfig {
  readonly url: string;
  readonly poolMax?: number;
  readonly applicationName?: string;
}

export const createDatabase = (config: DbConfig): Kysely<Database> => {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax ?? 10,
    application_name: config.applicationName ?? 'cyberstrike-hybrid',
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
};
