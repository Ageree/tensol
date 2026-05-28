/**
 * T011 — Database client factory + transactional helper.
 *
 * Single source of truth for opening a Drizzle-wrapped `bun:sqlite` handle.
 * Why `bun:sqlite` and not `better-sqlite3`:
 *   T010 (commit b523fbf) discovered better-sqlite3 is incompatible with
 *   Bun 1.3 (issue #4290). bun:sqlite is the supported native driver and
 *   Drizzle ships first-class support via `drizzle-orm/bun-sqlite`.
 *
 * `withTx(db, fn)` wraps Drizzle's native `transaction(...)` with the
 * `behavior: "immediate"` option, which emits `BEGIN IMMEDIATE` instead of
 * the default `BEGIN DEFERRED`. IMMEDIATE acquires a RESERVED lock at
 * transaction start, so two concurrent transactions cannot both read a
 * row and then race to write it — the second tx waits (up to
 * `busy_timeout`) for the first to commit before its BEGIN succeeds.
 *
 * NOTE: this module does NOT apply migrations. Migration application
 * belongs to the server boot path (T028+) so that test code, CLI tools,
 * and the running server can each choose how they want to seed schema.
 */
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

/** Public DB type. Generic on our schema so all Drizzle query builders are
 *  fully type-narrowed when consumers import this. */
export type DB = BunSQLiteDatabase<typeof schema> & { $client: Database };

/** Transaction handle passed to `withTx` callbacks. Same Drizzle surface
 *  as `DB` (minus `$client`) — `transaction(...)` inside Drizzle returns
 *  a `BaseSQLiteDatabase`-compatible value. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** SQLite C-level busy_timeout in ms. MUST be 0 (i.e. no C-level retry):
 *  bun:sqlite v1.3 calls SQLite synchronously, so any C-level wait blocks
 *  the entire JS event loop — preventing the lock-holder's `await`-based
 *  callback from making progress (head-of-line deadlock). We therefore
 *  surface SQLITE_BUSY immediately and let `withTx` retry in JS, where
 *  `setTimeout` can yield the loop. */
const DEFAULT_BUSY_TIMEOUT_MS = 0;

/**
 * Open a Drizzle-wrapped SQLite database.
 *
 * @param path absolute filesystem path, or `:memory:` for an in-process DB.
 *             In-memory DBs are NOT shared between calls — each
 *             `createDb(":memory:")` opens a fresh isolated database.
 */
export function createDb(path: string): DB {
  const sqlite = new Database(path);

  // WAL mode is a meaningful concurrency win on disk-backed databases but
  // is not supported on in-memory ones. Skip it for `:memory:` to avoid
  // a surprising SQLITE_ERROR.
  if (path !== ":memory:") {
    sqlite.exec("PRAGMA journal_mode = WAL");
  }
  // Foreign-key enforcement is OFF by default in SQLite. We rely on
  // CASCADE deletes (e.g. sessions → users) so it must be ON for every
  // connection.
  sqlite.exec("PRAGMA foreign_keys = ON");
  // Without busy_timeout, the second concurrent `BEGIN IMMEDIATE` would
  // return SQLITE_BUSY immediately. Set a generous timeout so the OS
  // scheduler hands us the lock after the holder commits.
  sqlite.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);

  // drizzle() returns BunSQLiteDatabase<typeof schema>; the public DB
  // type pins $client to the bun Database (rather than `unknown`) so
  // server code can call low-level ops (e.g. close()) without a cast.
  return drizzle(sqlite, { schema }) as DB;
}

/** Default cap (ms) on how long withTx will keep retrying a contended
 *  `BEGIN IMMEDIATE` before surfacing SQLITE_BUSY to the caller. Matches
 *  the PRAGMA busy_timeout above so behaviour is symmetric whether
 *  SQLite's C-level retry or our JS-level retry wins the race. */
const WITH_TX_BUSY_DEADLINE_MS = 5_000;
/** Starting back-off (ms) for the JS-level BEGIN-IMMEDIATE retry loop. */
const WITH_TX_BACKOFF_INITIAL_MS = 2;
/** Cap on back-off (ms) per retry. */
const WITH_TX_BACKOFF_MAX_MS = 50;

function isSqliteBusy(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "SQLITE_BUSY"
  );
}

/**
 * Run `fn` inside a `BEGIN IMMEDIATE ... COMMIT/ROLLBACK` block.
 *
 * The return value of `fn` (sync or async) is awaited and propagated. If
 * `fn` throws, the transaction is rolled back and the error rethrown.
 *
 * Concurrency semantics: two concurrent calls (typically from separate
 * connections, since a single bun:sqlite handle is single-threaded by
 * design) serialize. The second caller's `BEGIN IMMEDIATE` returns
 * SQLITE_BUSY while the first holds a RESERVED lock; this function then
 * retries (with capped exponential back-off) until the first commits or
 * until `WITH_TX_BUSY_DEADLINE_MS` elapses.
 *
 * Why we retry in JS rather than rely on SQLite's `busy_timeout` PRAGMA:
 *   `bun:sqlite` v1.3 surfaces SQLITE_BUSY synchronously and does NOT
 *   honour the C-level busy_timeout for `BEGIN IMMEDIATE` contention —
 *   the underlying syscall returns immediately. We therefore implement
 *   the retry loop in JS so callers can rely on the documented serialize
 *   semantics. (PRAGMA busy_timeout is still set for non-BEGIN contention
 *   on statement-level locks, where bun's wrapper does block.)
 *
 * Implementation detail: drizzle's bun-sqlite `transaction(...)` is
 * synchronous (it wraps bun:sqlite's native sync `Database.transaction`).
 * We therefore CANNOT `await` inside the Drizzle callback — bun's
 * transaction wrapper would commit before the awaited promise resolves.
 * Instead we hand-roll the BEGIN/COMMIT/ROLLBACK so async `fn`
 * implementations work as expected.
 */
export async function withTx<T>(
  db: DB,
  fn: (tx: DB) => Promise<T> | T,
): Promise<T> {
  const raw = db.$client;

  const deadline = Date.now() + WITH_TX_BUSY_DEADLINE_MS;
  let backoff = WITH_TX_BACKOFF_INITIAL_MS;
  // Acquire BEGIN IMMEDIATE with retry on SQLITE_BUSY.
  while (true) {
    try {
      raw.exec("BEGIN IMMEDIATE");
      break;
    } catch (err) {
      if (!isSqliteBusy(err) || Date.now() >= deadline) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, WITH_TX_BACKOFF_MAX_MS);
    }
  }

  try {
    const result = await fn(db);
    raw.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      // ROLLBACK can fail if the tx was already aborted by SQLite (e.g.
      // an automatic rollback on a constraint violation). Swallow — the
      // original error is what the caller wants to see.
    }
    throw err;
  }
}
