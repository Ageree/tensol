/**
 * T029 — Targets service tests.
 *
 * Pins down:
 *   1. `createTarget` normalises the URL (lowercase host, trailing-root-slash
 *      trim) before insert; the row reflects the normalised form and the
 *      `target_created` audit metadata carries the same normalised URL.
 *   2. `guardTargetUrl` rejections (private IPv4, localhost) bubble up as
 *      `{ ok:false, code:400 }` with NO row inserted AND NO audit emitted.
 *   3. Project-ownership boundary: a foreign user calling `createTarget`
 *      with another user's projectId gets 404 (NOT 403, NOT auto-created).
 *   4. `listForProject` is project-scoped AND ownership-checked: foreign
 *      user → 404; owner sees their targets newest-first; unknown project → 404.
 *   5. `deleteTarget` happy path removes the row and emits `target_deleted`.
 *   6. `deleteTarget` foreign user → 404, row untouched, NO audit row.
 *   7. URL normalisation preserves path + query; only host case + root-only
 *      trailing slash are touched.
 *   8. After mixed create/delete operations, `verifyChain` reports `ok` —
 *      proves emit pattern (mutation in tx, audit AFTER commit) keeps the
 *      hash chain linked.
 *
 * Setup mirrors `projects/service.test.ts`: fresh `:memory:` DB per test,
 * applied migrations, raw drizzle seeds for users + projects.
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
import { createTarget, deleteTarget, listForProject } from "./service.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY =
  "test-key-64-chars-hex-cccccccccccccccccccccccccccccccccccccccccc";

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

function seedProject(
  db: DB,
  userId: string,
  name: string,
  ts: number,
): string {
  const id = ulid(ts);
  db.insert(projectsTable)
    .values({ id, userId, name, createdAt: ts })
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// createTarget — happy path with normalisation
// ---------------------------------------------------------------------------
test("createTarget normalises url (lowercase host, trim root slash) and audits", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());
  const projectId = seedProject(db, userId, "API", clock.now());

  const res = await createTarget(
    db,
    { userId, projectId, url: "https://Example.COM/" },
    { signingKey: KEY, now: clock.now },
  );

  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const target = res.value;
  expect(target.project_id).toBe(projectId);
  expect(target.url).toBe("https://example.com");
  expect(target.status).toBe("unverified");
  expect(target.verified_at).toBeNull();

  // Row really landed.
  const rows = db
    .select()
    .from(targetsTable)
    .where(eq(targetsTable.id, target.id))
    .all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.url).toBe("https://example.com");
  expect(rows[0]!.projectId).toBe(projectId);
  expect(rows[0]!.status).toBe("unverified");

  // Audit row with the normalised URL in metadata.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "target_created"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.userId).toBe(userId);
  expect(audits[0]!.projectId).toBe(projectId);
  expect(audits[0]!.targetId).toBe(target.id);
  expect(audits[0]!.outcome).toBe("success");
  const meta = JSON.parse(audits[0]!.metadataJson);
  expect(meta.url).toBe("https://example.com");
});

// ---------------------------------------------------------------------------
// createTarget — private IPv4 rejected
// ---------------------------------------------------------------------------
test("createTarget rejects private IPv4 with 400 and no side effects", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());
  const projectId = seedProject(db, userId, "API", clock.now());

  const res = await createTarget(
    db,
    { userId, projectId, url: "http://192.168.1.1" },
    { signingKey: KEY, now: clock.now },
  );

  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.code).toBe(400);
    expect(res.reason).toMatch(/private/);
  }

  // No row inserted.
  expect(
    db
      .select()
      .from(targetsTable)
      .where(eq(targetsTable.projectId, projectId))
      .all(),
  ).toHaveLength(0);

  // No audit row emitted on the rejection path.
  expect(
    db.select().from(auditLog).where(eq(auditLog.event, "target_created")).all(),
  ).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// createTarget — localhost rejected
// ---------------------------------------------------------------------------
test("createTarget rejects localhost with 400", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());
  const projectId = seedProject(db, userId, "API", clock.now());

  const res = await createTarget(
    db,
    { userId, projectId, url: "http://localhost" },
    { signingKey: KEY, now: clock.now },
  );

  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.code).toBe(400);
    expect(res.reason).toMatch(/localhost/);
  }
  expect(
    db
      .select()
      .from(targetsTable)
      .where(eq(targetsTable.projectId, projectId))
      .all(),
  ).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// createTarget — foreign project → 404 (NOT 403, NOT silent create)
// ---------------------------------------------------------------------------
test("createTarget returns 404 when projectId belongs to another user", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = seedUser(db, "alice@example.com", clock.now());
  const bob = seedUser(db, "bob@example.com", clock.now());
  const bobProject = seedProject(db, bob, "bob-secret", clock.now());

  const res = await createTarget(
    db,
    { userId: alice, projectId: bobProject, url: "https://example.com" },
    { signingKey: KEY, now: clock.now },
  );

  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.code).toBe(404);
    expect(res.reason).toBe("not_found");
  }
  // No target row was inserted into bob's project from alice's hand.
  expect(
    db
      .select()
      .from(targetsTable)
      .where(eq(targetsTable.projectId, bobProject))
      .all(),
  ).toHaveLength(0);
  // No audit row emitted on the failure path.
  expect(
    db.select().from(auditLog).where(eq(auditLog.event, "target_created")).all(),
  ).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// listForProject — ownership scoping + ordering
// ---------------------------------------------------------------------------
test("listForProject returns targets newest first and rejects foreign callers", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = seedUser(db, "alice@example.com", clock.now());
  const bob = seedUser(db, "bob@example.com", clock.now());
  const aliceProject = seedProject(db, alice, "api", clock.now());

  const t1 = await createTarget(
    db,
    { userId: alice, projectId: aliceProject, url: "https://one.example.com" },
    { signingKey: KEY, now: clock.now },
  );
  clock.advance(10);
  const t2 = await createTarget(
    db,
    { userId: alice, projectId: aliceProject, url: "https://two.example.com" },
    { signingKey: KEY, now: clock.now },
  );
  expect(t1.ok && t2.ok).toBe(true);
  if (!t1.ok || !t2.ok) return;

  // Owner sees both newest-first.
  const ownerList = await listForProject(db, {
    userId: alice,
    projectId: aliceProject,
  });
  expect(ownerList.ok).toBe(true);
  if (ownerList.ok) {
    expect(ownerList.value.map((t) => t.id)).toEqual([t2.value.id, t1.value.id]);
  }

  // Foreign user on the same project → 404 (NOT empty list — hides existence).
  const foreignList = await listForProject(db, {
    userId: bob,
    projectId: aliceProject,
  });
  expect(foreignList.ok).toBe(false);
  if (!foreignList.ok) {
    expect(foreignList.code).toBe(404);
    expect(foreignList.reason).toBe("not_found");
  }

  // Unknown projectId → 404.
  const unknownList = await listForProject(db, {
    userId: alice,
    projectId: ulid(clock.now()),
  });
  expect(unknownList.ok).toBe(false);
  if (!unknownList.ok) expect(unknownList.code).toBe(404);
});

// ---------------------------------------------------------------------------
// deleteTarget — happy path
// ---------------------------------------------------------------------------
test("deleteTarget removes the row and emits target_deleted", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());
  const projectId = seedProject(db, userId, "API", clock.now());

  const created = await createTarget(
    db,
    { userId, projectId, url: "https://example.com" },
    { signingKey: KEY, now: clock.now },
  );
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const res = await deleteTarget(
    db,
    { userId, targetId: created.value.id },
    { signingKey: KEY, now: clock.now },
  );
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.deleted).toBe(true);

  // Row gone.
  expect(
    db
      .select()
      .from(targetsTable)
      .where(eq(targetsTable.id, created.value.id))
      .all(),
  ).toHaveLength(0);

  // Audit row present.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "target_deleted"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.userId).toBe(userId);
  expect(audits[0]!.projectId).toBe(projectId);
  expect(audits[0]!.targetId).toBe(created.value.id);
});

// ---------------------------------------------------------------------------
// deleteTarget — foreign user → 404, row preserved, no audit
// ---------------------------------------------------------------------------
test("deleteTarget returns 404 when caller does not own the target's project", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const alice = seedUser(db, "alice@example.com", clock.now());
  const bob = seedUser(db, "bob@example.com", clock.now());
  const aliceProject = seedProject(db, alice, "api", clock.now());

  const created = await createTarget(
    db,
    { userId: alice, projectId: aliceProject, url: "https://example.com" },
    { signingKey: KEY, now: clock.now },
  );
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const res = await deleteTarget(
    db,
    { userId: bob, targetId: created.value.id },
    { signingKey: KEY, now: clock.now },
  );
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.code).toBe(404);
    expect(res.reason).toBe("not_found");
  }

  // Target still there.
  expect(
    db
      .select()
      .from(targetsTable)
      .where(eq(targetsTable.id, created.value.id))
      .all(),
  ).toHaveLength(1);
  // No target_deleted audit row.
  expect(
    db.select().from(auditLog).where(eq(auditLog.event, "target_deleted")).all(),
  ).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// URL normalisation preserves path + query
// ---------------------------------------------------------------------------
test("createTarget preserves path and query; only host case + root slash change", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());
  const projectId = seedProject(db, userId, "API", clock.now());

  const res = await createTarget(
    db,
    {
      userId,
      projectId,
      url: "https://Example.COM/some/path?q=1",
    },
    { signingKey: KEY, now: clock.now },
  );
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  // Host lowercased; path + query preserved as-is; no trailing slash to trim.
  expect(res.value.url).toBe("https://example.com/some/path?q=1");
});

// ---------------------------------------------------------------------------
// audit chain integrity across mixed ops
// ---------------------------------------------------------------------------
test("audit chain stays linked after createTarget + deleteTarget cycles", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000, true);
  const userId = seedUser(db, "alice@example.com", clock.now());
  const projectId = seedProject(db, userId, "API", clock.now());

  const a = await createTarget(
    db,
    { userId, projectId, url: "https://a.example.com" },
    { signingKey: KEY, now: clock.now },
  );
  const b = await createTarget(
    db,
    { userId, projectId, url: "https://b.example.com" },
    { signingKey: KEY, now: clock.now },
  );
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok || !b.ok) return;
  await deleteTarget(
    db,
    { userId, targetId: a.value.id },
    { signingKey: KEY, now: clock.now },
  );
  await deleteTarget(
    db,
    { userId, targetId: b.value.id },
    { signingKey: KEY, now: clock.now },
  );

  const chain = verifyChain(db, KEY);
  expect(chain.ok).toBe(true);
  if (chain.ok) expect(chain.rows).toBe(4);
});
