/**
 * T011 — DB client + withTx helper.
 *
 * Three guarantees this test pins down:
 *   1. `createDb(path)` returns a Drizzle instance wired to the bun:sqlite
 *      driver and the schema in `./schema`. Round-trip INSERT/SELECT works.
 *   2. `withTx(db, fn)` commits on success and rolls back on thrown errors.
 *   3. Concurrent `withTx` calls across *separate* connections to the same
 *      file serialize via `BEGIN IMMEDIATE` + `PRAGMA busy_timeout` — i.e. a
 *      naive read-modify-write counter loop does NOT lose updates.
 *
 * Why two connections for the concurrency test:
 *   bun:sqlite's `Database` instance is single-threaded; multiple
 *   `db.transaction(...)` calls on one connection are inherently serialised
 *   inside the JS event loop. The only meaningful concurrency a SQLite
 *   single-binary backend ever sees is *cross-connection* (e.g. two HTTP
 *   request handlers each holding their own pooled connection — though we
 *   plan one shared connection, the contract still has to be safe under
 *   future fan-out). Hence the test opens two `createDb` instances against
 *   the same temp file and races writes via Promise.all.
 *
 * Why a temp file rather than `:memory:`:
 *   each `new Database(":memory:")` opens an INDEPENDENT database — two
 *   `createDb(":memory:")` calls would not share state and the concurrency
 *   test would be meaningless.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, withTx, type DB } from "./client";
import { users } from "./schema";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .sql migrations found in ${MIGRATIONS_DIR}`);
  }
  return files
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

/** Apply the bundled migrations directly to the raw sqlite handle held by
 *  the Drizzle instance. Avoids drizzle-kit `migrate` runtime. */
function applyMigrations(db: DB): void {
  // `db.$client` is the underlying `bun:sqlite` Database; see drizzle-orm
  // `bun-sqlite/driver.ts` `BunSQLiteDatabase.$client`.
  (db.$client as Database).exec(migrationSql());
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tensol-client-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — createDb returns a working Drizzle instance.
// ---------------------------------------------------------------------------
test("createDb(:memory:) returns a Drizzle instance with insert+select", () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  db.insert(users)
    .values({ id: "01H0000000000000000000USER", email: "a@b.com", createdAt: 1 })
    .run();

  const rows = db.select().from(users).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.email).toBe("a@b.com");
});

// ---------------------------------------------------------------------------
// Test 2 — withTx commits on success.
// ---------------------------------------------------------------------------
test("withTx commits inserts visible to the outer connection", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  await withTx(db, async (tx) => {
    tx.insert(users)
      .values({
        id: "01H0000000000000000000COM1",
        email: "commit@x.com",
        createdAt: 2,
      })
      .run();
  });

  const rows = db.select().from(users).where(eq(users.email, "commit@x.com")).all();
  expect(rows).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Test 3 — withTx rolls back on thrown error.
// ---------------------------------------------------------------------------
test("withTx rolls back when callback throws", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);

  await expect(
    withTx(db, async (tx) => {
      tx.insert(users)
        .values({
          id: "01H0000000000000000000RBK1",
          email: "rollback@x.com",
          createdAt: 3,
        })
        .run();
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");

  const rows = db
    .select()
    .from(users)
    .where(eq(users.email, "rollback@x.com"))
    .all();
  expect(rows).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 4 — concurrent withTx calls across two connections serialize via
// BEGIN IMMEDIATE. Read-modify-write on a counter row must NOT lose updates.
// ---------------------------------------------------------------------------
test(
  "concurrent withTx across connections serializes via BEGIN IMMEDIATE",
  async () => {
    const dbPath = join(tmpDir, "concurrent.sqlite");

    // Bootstrap schema + a counter row on a throwaway connection.
    const boot = createDb(dbPath);
    applyMigrations(boot);
    // Reuse `users.createdAt` as the counter — saves wiring an ad-hoc table.
    boot
      .insert(users)
      .values({
        id: "01H0000000000000000000CNTR",
        email: "counter@tensol",
        createdAt: 0,
      })
      .run();
    (boot.$client as Database).close();

    // Two independent connections sharing the same file.
    const N = 5;
    const conns = Array.from({ length: N }, () => createDb(dbPath));

    try {
      const COUNTER_ID = "01H0000000000000000000CNTR";

      await Promise.all(
        conns.map((conn) =>
          withTx(conn, async (tx) => {
            const row = tx
              .select({ v: users.createdAt })
              .from(users)
              .where(eq(users.id, COUNTER_ID))
              .get();
            const current = row?.v ?? 0;
            // tiny await so the JS scheduler hands control to the next
            // concurrent withTx before this one commits — without
            // BEGIN IMMEDIATE this is where lost updates would happen.
            await new Promise((r) => setTimeout(r, 5));
            tx.update(users)
              .set({ createdAt: current + 1 })
              .where(eq(users.id, COUNTER_ID))
              .run();
          }),
        ),
      );

      // After serialised execution, the counter equals N.
      const final = conns[0]!
        .select({ v: users.createdAt })
        .from(users)
        .where(eq(users.id, COUNTER_ID))
        .get();
      expect(final?.v).toBe(N);
    } finally {
      for (const conn of conns) {
        (conn.$client as Database).close();
      }
    }
  },
  15_000,
);

// ---------------------------------------------------------------------------
// Test 5 — sanity: createDb applies foreign_keys=ON and leaves C-level
// busy_timeout at zero (JS-level retry handles BUSY — see client.ts).
// ---------------------------------------------------------------------------
test("createDb applies foreign_keys=ON and zero C-level busy_timeout", () => {
  const db = createDb(":memory:");
  const raw = db.$client as Database;
  const fk = raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  expect(fk.foreign_keys).toBe(1);
  // We DELIBERATELY leave busy_timeout at 0 so bun:sqlite's sync C call
  // returns SQLITE_BUSY immediately, allowing the withTx JS retry loop
  // to yield the event loop via setTimeout.
  const bt = raw.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  expect(bt.timeout).toBe(0);
  // Silence unused import linter — sql is part of the public surface we want
  // documented here even though we did not call it directly.
  void sql;
});
