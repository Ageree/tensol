/**
 * T028 — Projects service tests.
 *
 * Pins down:
 *   1. `create` inserts a row scoped to the caller, returns the new Project,
 *      and emits a `project_created` audit row with the project_id + name.
 *   2. `listForUser` is owner-scoped: it MUST NOT leak rows owned by a
 *      different user even if no extra filter is supplied at the call site.
 *      Order is `created_at DESC`.
 *   3. `deleteProject` cascades to `targets` rows via the FK ON DELETE
 *      CASCADE (relies on `PRAGMA foreign_keys = ON` set by `createDb`).
 *   4. `deleteProject` for an UNKNOWN id returns `{ ok:false, code:404 }`.
 *   5. `deleteProject` for a project owned by a DIFFERENT user returns
 *      `{ ok:false, code:404 }` (NOT 403) — we hide existence to prevent
 *      enumeration. The audit row MUST NOT be emitted on the failure path.
 *   6. After a happy-path create+delete, `verifyChain` reports `ok` —
 *      proves emit pattern (mutation in tx, audit AFTER commit) preserves
 *      chain monotonicity.
 *
 * Setup mirrors `auth/magic-link.test.ts`: fresh `:memory:` DB per test,
 * apply migrations directly, seed users with raw drizzle insert.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import {
  auditLog,
  projects as projectsTable,
  targets as targetsTable,
  users as usersTable,
} from "../db/schema.ts";
import { verifyChain } from "../audit/verify-chain.ts";
import { createClock } from "../lib/time.ts";
import { ulid } from "../lib/ids.ts";
import { create, deleteProject, listForUser } from "./service.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY =
  "test-key-64-chars-hex-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

function applyMigrations(db: DB): void {
  (db.$client as Database).exec(migrationSql());
}

function freshMemDb(): DB {
  const db = createDb(":memory:");
  applyMigrations(db);
  return db;
}

function seedUser(db: DB, email: string, ts: number): string {
  const id = ulid(ts);
  db.insert(usersTable).values({ id, email, createdAt: ts }).run();
  return id;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
test("create inserts a row and emits project_created audit", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());

  const project = await create(
    db,
    { userId, name: "My API" },
    { signingKey: KEY, now: clock.now },
  );

  expect(project.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(project.owner_user_id).toBe(userId);
  expect(project.name).toBe("My API");
  expect(typeof project.created_at).toBe("number");

  // Row really landed.
  const rows = db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, project.id))
    .all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.userId).toBe(userId);
  expect(rows[0]!.name).toBe("My API");

  // Audit row present, with name in metadata.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "project_created"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.userId).toBe(userId);
  expect(audits[0]!.projectId).toBe(project.id);
  expect(audits[0]!.outcome).toBe("success");
  const meta = JSON.parse(audits[0]!.metadataJson);
  expect(meta.name).toBe("My API");
});

// ---------------------------------------------------------------------------
// listForUser — owner scoping
// ---------------------------------------------------------------------------
test("listForUser returns only the caller's projects, newest first", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = seedUser(db, "alice@example.com", clock.now());
  const bob = seedUser(db, "bob@example.com", clock.now());

  const a1 = await create(
    db,
    { userId: alice, name: "alice-1" },
    { signingKey: KEY, now: clock.now },
  );
  // Force the next created_at strictly later so the DESC order is observable.
  clock.advance(10);
  const a2 = await create(
    db,
    { userId: alice, name: "alice-2" },
    { signingKey: KEY, now: clock.now },
  );
  clock.advance(10);
  await create(
    db,
    { userId: bob, name: "bob-1" },
    { signingKey: KEY, now: clock.now },
  );

  const list = await listForUser(db, alice);
  expect(list.map((p) => p.name)).toEqual(["alice-2", "alice-1"]);
  expect(list.every((p) => p.owner_user_id === alice)).toBe(true);
  expect(list.map((p) => p.id)).toEqual([a2.id, a1.id]);
});

// ---------------------------------------------------------------------------
// deleteProject — happy path
// ---------------------------------------------------------------------------
test("deleteProject removes the row and emits project_deleted", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());

  const project = await create(
    db,
    { userId, name: "Delete Me" },
    { signingKey: KEY, now: clock.now },
  );

  const res = await deleteProject(
    db,
    { userId, projectId: project.id },
    { signingKey: KEY, now: clock.now },
  );

  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.deleted).toBe(true);

  // Project row is gone.
  const remaining = db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, project.id))
    .all();
  expect(remaining).toHaveLength(0);

  // Audit row present.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "project_deleted"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.userId).toBe(userId);
  expect(audits[0]!.projectId).toBe(project.id);
});

// ---------------------------------------------------------------------------
// deleteProject — cascade to targets
// ---------------------------------------------------------------------------
test("deleteProject cascades to targets via FK ON DELETE CASCADE", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());

  const project = await create(
    db,
    { userId, name: "Parent" },
    { signingKey: KEY, now: clock.now },
  );

  // Seed two child target rows referencing the project.
  const t1Id = ulid(clock.now());
  const t2Id = ulid(clock.now());
  db.insert(targetsTable)
    .values([
      {
        id: t1Id,
        projectId: project.id,
        url: "https://example.com",
        status: "unverified",
        verifiedAt: null,
        createdAt: clock.now(),
      },
      {
        id: t2Id,
        projectId: project.id,
        url: "https://example.org",
        status: "unverified",
        verifiedAt: null,
        createdAt: clock.now(),
      },
    ])
    .run();

  // Pre-condition.
  expect(
    db.select().from(targetsTable).where(eq(targetsTable.projectId, project.id)).all(),
  ).toHaveLength(2);

  const res = await deleteProject(
    db,
    { userId, projectId: project.id },
    { signingKey: KEY, now: clock.now },
  );
  expect(res.ok).toBe(true);

  // Cascade removed both children.
  const remainingTargets = db
    .select()
    .from(targetsTable)
    .where(eq(targetsTable.projectId, project.id))
    .all();
  expect(remainingTargets).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// deleteProject — unknown id → 404
// ---------------------------------------------------------------------------
test("deleteProject returns 404 for an unknown project id", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());

  const res = await deleteProject(
    db,
    { userId, projectId: ulid(clock.now()) },
    { signingKey: KEY, now: clock.now },
  );

  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.code).toBe(404);
    expect(res.reason).toBe("not_found");
  }

  // No audit row was emitted on the failure path.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "project_deleted"))
    .all();
  expect(audits).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// deleteProject — foreign user → 404 (NOT 403)
// ---------------------------------------------------------------------------
test("deleteProject returns 404 (not 403) when a foreign user tries to delete", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = seedUser(db, "alice@example.com", clock.now());
  const bob = seedUser(db, "bob@example.com", clock.now());

  const project = await create(
    db,
    { userId: alice, name: "alice-secret" },
    { signingKey: KEY, now: clock.now },
  );

  const res = await deleteProject(
    db,
    { userId: bob, projectId: project.id },
    { signingKey: KEY, now: clock.now },
  );

  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.code).toBe(404);
    expect(res.reason).toBe("not_found");
  }

  // Project is still there — confirm we did not silently delete on the
  // ownership-mismatch path.
  const stillThere = db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, project.id))
    .all();
  expect(stillThere).toHaveLength(1);

  // No project_deleted audit row was emitted.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "project_deleted"))
    .all();
  expect(audits).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// audit chain integrity
// ---------------------------------------------------------------------------
test("audit chain stays linked across create + delete cycles", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());

  const p1 = await create(
    db,
    { userId, name: "p1" },
    { signingKey: KEY, now: clock.now },
  );
  const p2 = await create(
    db,
    { userId, name: "p2" },
    { signingKey: KEY, now: clock.now },
  );
  await deleteProject(
    db,
    { userId, projectId: p1.id },
    { signingKey: KEY, now: clock.now },
  );
  await deleteProject(
    db,
    { userId, projectId: p2.id },
    { signingKey: KEY, now: clock.now },
  );

  const res = verifyChain(db, KEY);
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.rows).toBe(4);
  }
});
