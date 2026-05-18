/**
 * T030 — Integration tests for `/api/projects` and `/api/targets` routes.
 *
 * Coverage matrix (acceptance criterion from tasks.md line 70):
 *   1. Full CRUD per user — create / list / delete projects + targets.
 *   2. Auth required — unauthenticated calls → 401.
 *   3. Invalid body → 400.
 *   4. Ownership isolation — user B cannot see / mutate user A's resources.
 *   5. URL guard — private-IP target rejected with 400.
 *   6. Audit chain — all four event names recorded in order; chain verifies.
 *
 * The tests provision a fresh `:memory:` SQLite per test (T009 migration),
 * insert two pre-baked users + sessions directly via Drizzle, then build a
 * Hono app mounting `createProjectsRoutes` + `createTargetsRoutes`. We
 * exercise the routes via `app.request(...)` so cookie round-trips stay
 * entirely in-process.
 *
 * We do NOT go through the magic-link flow here — T026 already covers it.
 * Bypassing it lets these tests stay focused on CRUD semantics and audit
 * emission, not the auth dance.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { asc } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  auditLog,
  sessions as sessionsTable,
  users as usersTable,
} from "../../src/db/schema.ts";
import { createClock } from "../../src/lib/time.ts";
import { ulid } from "../../src/lib/ids.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { SESSION_COOKIE_NAME } from "../../src/auth/session.ts";
import { createProjectsRoutes } from "../../src/routes/projects.ts";
import { createTargetsRoutes } from "../../src/routes/targets.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SIGNING_KEY =
  "test-key-64-chars-hex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  return db;
}

interface PreBakedUser {
  readonly userId: string;
  readonly sessionId: string;
  readonly cookieHeader: string;
}

/**
 * Materialise a user + a live session row directly via Drizzle, then return
 * a ready-to-send `Cookie` header. Bypasses the magic-link flow — T026
 * already covers it.
 */
function bakeUser(
  db: DB,
  args: { email: string; now: number },
): PreBakedUser {
  const userId = ulid(args.now);
  db.insert(usersTable)
    .values({ id: userId, email: args.email, createdAt: args.now })
    .run();
  const sessionId = ulid(args.now + 1);
  db.insert(sessionsTable)
    .values({
      id: sessionId,
      userId,
      createdAt: args.now,
      // 30 days TTL — well past anything tests will burn.
      expiresAt: args.now + 30 * 24 * 60 * 60 * 1000,
    })
    .run();
  return {
    userId,
    sessionId,
    cookieHeader: `${SESSION_COOKIE_NAME}=${sessionId}`,
  };
}

function buildApp(opts: { db: DB; now: () => number }) {
  const app = new Hono();
  app.route(
    "/api/projects",
    createProjectsRoutes({
      db: opts.db,
      signingKey: SIGNING_KEY,
      now: opts.now,
    }),
  );
  app.route(
    "/api/targets",
    createTargetsRoutes({
      db: opts.db,
      signingKey: SIGNING_KEY,
      now: opts.now,
    }),
  );
  return app;
}

// ---------------------------------------------------------------------------
// Test 1 — Full CRUD on projects.
// ---------------------------------------------------------------------------
test("T030: project CRUD — create → list → delete → list (empty)", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const app = buildApp({ db, now: clock.now });

  // Create P1.
  const createRes = await app.request("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ name: "Project Alpha" }),
  });
  expect(createRes.status).toBe(201);
  const createBody = (await createRes.json()) as {
    project: { id: string; name: string };
  };
  expect(createBody.project.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(createBody.project.name).toBe("Project Alpha");

  const projectId = createBody.project.id;

  // List → contains P1.
  const listRes = await app.request("/api/projects", {
    headers: { Cookie: alice.cookieHeader },
  });
  expect(listRes.status).toBe(200);
  const listBody = (await listRes.json()) as {
    projects: Array<{ id: string; name: string }>;
  };
  expect(listBody.projects.length).toBe(1);
  expect(listBody.projects[0]!.id).toBe(projectId);

  // Delete P1.
  const delRes = await app.request(`/api/projects/${projectId}`, {
    method: "DELETE",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(delRes.status).toBe(204);

  // List → empty.
  const listAfter = await app.request("/api/projects", {
    headers: { Cookie: alice.cookieHeader },
  });
  expect(listAfter.status).toBe(200);
  const listAfterBody = (await listAfter.json()) as {
    projects: ReadonlyArray<unknown>;
  };
  expect(listAfterBody.projects.length).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 2 — Auth required.
// ---------------------------------------------------------------------------
test("T030: GET /api/projects without cookie → 401", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const app = buildApp({ db, now: clock.now });

  const res = await app.request("/api/projects");
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Test 3 — Invalid body shape → 400.
// ---------------------------------------------------------------------------
test("T030: POST /api/projects with empty body → 400", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const app = buildApp({ db, now: clock.now });

  const res = await app.request("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// Test 4 — Ownership isolation: user B cannot delete user A's project.
// ---------------------------------------------------------------------------
test("T030: cross-user delete on project → 404 (row preserved)", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const bob = bakeUser(db, { email: "bob@example.com", now: clock.now() });
  const app = buildApp({ db, now: clock.now });

  // Alice creates a project.
  const createRes = await app.request("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ name: "Alice's Secret" }),
  });
  const { project } = (await createRes.json()) as {
    project: { id: string };
  };

  // Bob tries to delete it.
  const delRes = await app.request(`/api/projects/${project.id}`, {
    method: "DELETE",
    headers: { Cookie: bob.cookieHeader },
  });
  expect(delRes.status).toBe(404); // NOT 403 — enumeration mitigation.

  // Alice still sees it.
  const listRes = await app.request("/api/projects", {
    headers: { Cookie: alice.cookieHeader },
  });
  const listBody = (await listRes.json()) as {
    projects: ReadonlyArray<unknown>;
  };
  expect(listBody.projects.length).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 5 — Full CRUD on targets via nested route.
// ---------------------------------------------------------------------------
test("T030: target CRUD — create via nested route → list → delete", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const app = buildApp({ db, now: clock.now });

  // Create parent project first.
  const projRes = await app.request("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ name: "Parent" }),
  });
  const { project } = (await projRes.json()) as { project: { id: string } };

  // Create target.
  const tRes = await app.request(
    `/api/projects/${project.id}/targets`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({ url: "https://example.com" }),
    },
  );
  expect(tRes.status).toBe(201);
  const tBody = (await tRes.json()) as {
    target: { id: string; url: string; status: string };
  };
  expect(tBody.target.url).toBe("https://example.com");
  expect(tBody.target.status).toBe("unverified");

  // List → contains it.
  const listRes = await app.request(
    `/api/projects/${project.id}/targets`,
    { headers: { Cookie: alice.cookieHeader } },
  );
  expect(listRes.status).toBe(200);
  const listBody = (await listRes.json()) as {
    targets: Array<{ id: string }>;
  };
  expect(listBody.targets.length).toBe(1);
  expect(listBody.targets[0]!.id).toBe(tBody.target.id);

  // Delete via /api/targets/:id.
  const delRes = await app.request(`/api/targets/${tBody.target.id}`, {
    method: "DELETE",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(delRes.status).toBe(204);

  // List → empty.
  const listAfter = await app.request(
    `/api/projects/${project.id}/targets`,
    { headers: { Cookie: alice.cookieHeader } },
  );
  const listAfterBody = (await listAfter.json()) as {
    targets: ReadonlyArray<unknown>;
  };
  expect(listAfterBody.targets.length).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 6 — Private IP rejected by url-guard.
// ---------------------------------------------------------------------------
test("T030: POST target with private IP → 400", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const app = buildApp({ db, now: clock.now });

  const projRes = await app.request("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ name: "Parent" }),
  });
  const { project } = (await projRes.json()) as { project: { id: string } };

  const tRes = await app.request(
    `/api/projects/${project.id}/targets`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({ url: "http://127.0.0.1" }),
    },
  );
  expect(tRes.status).toBe(400);
});

// ---------------------------------------------------------------------------
// Test 7 — Target ownership: user B cannot delete user A's target.
// ---------------------------------------------------------------------------
test("T030: cross-user target delete → 404", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const bob = bakeUser(db, { email: "bob@example.com", now: clock.now() });
  const app = buildApp({ db, now: clock.now });

  const projRes = await app.request("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ name: "Alice" }),
  });
  const { project } = (await projRes.json()) as { project: { id: string } };

  const tRes = await app.request(
    `/api/projects/${project.id}/targets`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({ url: "https://example.com" }),
    },
  );
  const { target } = (await tRes.json()) as { target: { id: string } };

  // Bob attempts delete.
  const delRes = await app.request(`/api/targets/${target.id}`, {
    method: "DELETE",
    headers: { Cookie: bob.cookieHeader },
  });
  expect(delRes.status).toBe(404);
});

// ---------------------------------------------------------------------------
// Test 8 — Audit rows captured in correct order across full mutation flow.
// ---------------------------------------------------------------------------
test("T030: audit log captures project + target lifecycle events in order", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const app = buildApp({ db, now: clock.now });

  // Create project.
  const projRes = await app.request("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ name: "Audit" }),
  });
  const { project } = (await projRes.json()) as { project: { id: string } };

  // Create target.
  const tRes = await app.request(
    `/api/projects/${project.id}/targets`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({ url: "https://example.com" }),
    },
  );
  const { target } = (await tRes.json()) as { target: { id: string } };

  // Delete target.
  await app.request(`/api/targets/${target.id}`, {
    method: "DELETE",
    headers: { Cookie: alice.cookieHeader },
  });

  // Delete project.
  await app.request(`/api/projects/${project.id}`, {
    method: "DELETE",
    headers: { Cookie: alice.cookieHeader },
  });

  const events = db
    .select({ event: auditLog.event })
    .from(auditLog)
    .orderBy(asc(auditLog.id))
    .all();
  expect(events.map((r) => r.event)).toEqual([
    "project_created",
    "target_created",
    "target_deleted",
    "project_deleted",
  ]);
});

// ---------------------------------------------------------------------------
// Test 9 — Audit chain still verifies after mixed CRUD.
// ---------------------------------------------------------------------------
test("T030: audit chain verifies after mixed CRUD operations", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const app = buildApp({ db, now: clock.now });

  // create P, create T, delete T, delete P, create P', list.
  const projRes = await app.request("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: alice.cookieHeader,
    },
    body: JSON.stringify({ name: "Chain" }),
  });
  const { project } = (await projRes.json()) as { project: { id: string } };

  const tRes = await app.request(
    `/api/projects/${project.id}/targets`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({ url: "https://example.com" }),
    },
  );
  const { target } = (await tRes.json()) as { target: { id: string } };

  await app.request(`/api/targets/${target.id}`, {
    method: "DELETE",
    headers: { Cookie: alice.cookieHeader },
  });
  await app.request(`/api/projects/${project.id}`, {
    method: "DELETE",
    headers: { Cookie: alice.cookieHeader },
  });

  const result = verifyChain(db, SIGNING_KEY);
  expect(result.ok).toBe(true);
  expect(result.rows).toBe(4);
});
