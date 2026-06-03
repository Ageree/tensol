/**
 * T023 — `requireAuth` middleware tests.
 *
 * The middleware is constructed via a factory (`createRequireAuth({db, now})`)
 * so test code can inject a fresh in-memory DB and a deterministic clock
 * without reaching into a module-level config singleton (Constitution VII).
 *
 * Coverage:
 *   1. Missing cookie → 401 `{error: "unauthenticated"}`.
 *   2. Unknown session id → 401.
 *   3. Expired session → 401.
 *   4. Orphan session (user deleted) → 401. We avoid SQLite's
 *      ON DELETE CASCADE by inserting the session row with `user_id`
 *      pointing at a user we never inserted; the FK is enforced but the
 *      missing user is what we want to assert against.  See test body.
 *   5. Valid session → `next()` runs, downstream sees `c.get("user")`
 *      and `c.get("session")`.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDb, type DB } from "../db/client.ts";
import { sessions as sessionsTable, users as usersTable } from "../db/schema.ts";
import { createClock } from "../lib/time.ts";
import { SESSION_COOKIE_NAME } from "./session.ts";
import {
  createRequireAuth,
  type AuthVariables,
} from "./middleware.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

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

function applyMigrations(db: DB): void {
  (db.$client as Database).exec(migrationSql());
}

function freshMemDb(): DB {
  const db = createDb(":memory:");
  applyMigrations(db);
  return db;
}

// Helper to build a Hono app with the middleware mounted on `*` and a
// downstream `/me` handler that returns the bound user.
function buildApp(
  db: DB,
  nowFn: () => number,
  opts?: {
    clerkAuth?: (req: Request) => Promise<{ id: string; email: string } | null>;
  },
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(
    "*",
    createRequireAuth({
      db,
      now: nowFn,
      ...(opts?.clerkAuth ? { clerkAuth: opts.clerkAuth } : {}),
    }),
  );
  app.get("/me", (c) => {
    const user = c.get("user");
    const session = c.get("session");
    return c.json({ user, session });
  });
  return app;
}

function seedUserAndSession(
  db: DB,
  opts: {
    userId: string;
    email: string;
    sessionId: string;
    createdAt: number;
    expiresAt: number;
  },
): void {
  db.insert(usersTable)
    .values({ id: opts.userId, email: opts.email, createdAt: opts.createdAt })
    .run();
  db.insert(sessionsTable)
    .values({
      id: opts.sessionId,
      userId: opts.userId,
      createdAt: opts.createdAt,
      expiresAt: opts.expiresAt,
    })
    .run();
}

// ---------------------------------------------------------------------------
// 1. No cookie → 401
// ---------------------------------------------------------------------------
test("requireAuth: missing cookie → 401 unauthenticated", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const app = buildApp(db, clock.now);

  const res = await app.request("/me");
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("unauthenticated");
});

// ---------------------------------------------------------------------------
// 2. Unknown session id → 401
// ---------------------------------------------------------------------------
test("requireAuth: unknown session id → 401", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const app = buildApp(db, clock.now);

  const res = await app.request("/me", {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=does-not-exist` },
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("unauthenticated");
});

// ---------------------------------------------------------------------------
// 3. Expired session → 401
// ---------------------------------------------------------------------------
test("requireAuth: expired session → 401", async () => {
  const db = freshMemDb();
  const fixedNow = 1_700_000_000_000;
  const clock = createClock(fixedNow);
  const app = buildApp(db, clock.now);

  // expires_at strictly in the past relative to clock.now()
  seedUserAndSession(db, {
    userId: "user-1",
    email: "alice@example.com",
    sessionId: "sess-expired",
    createdAt: fixedNow - 10_000,
    expiresAt: fixedNow - 1, // expired by 1ms
  });

  const res = await app.request("/me", {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=sess-expired` },
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("unauthenticated");
});

// ---------------------------------------------------------------------------
// 4. Orphan session (user row missing).
//
//    The session FK has ON DELETE CASCADE, so we cannot insert a session
//    row pointing at a non-existent user with foreign_keys=ON. Instead we
//    insert user + session, then DELETE the user — the cascade nukes the
//    session too, which from the middleware's POV looks identical to "no
//    such session" and is already covered by test #2. To exercise the
//    "session found but user lookup empty" branch we temporarily disable
//    FK enforcement on this one connection, insert a dangling session,
//    and re-enable enforcement.
// ---------------------------------------------------------------------------
test("requireAuth: session row exists but user is gone → 401", async () => {
  const db = freshMemDb();
  const fixedNow = 1_700_000_000_000;
  const clock = createClock(fixedNow);
  const app = buildApp(db, clock.now);

  const raw = db.$client;
  raw.exec("PRAGMA foreign_keys = OFF");
  db.insert(sessionsTable)
    .values({
      id: "sess-orphan",
      userId: "ghost-user-id",
      createdAt: fixedNow - 1_000,
      expiresAt: fixedNow + 10_000, // still fresh
    })
    .run();
  raw.exec("PRAGMA foreign_keys = ON");

  const res = await app.request("/me", {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=sess-orphan` },
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("unauthenticated");
});

// ---------------------------------------------------------------------------
// 5. Valid session → next() runs, downstream sees user + session
// ---------------------------------------------------------------------------
test("requireAuth: valid session → next() with user + session bound", async () => {
  const db = freshMemDb();
  const fixedNow = 1_700_000_000_000;
  const clock = createClock(fixedNow);
  const app = buildApp(db, clock.now);

  seedUserAndSession(db, {
    userId: "user-42",
    email: "alice@example.com",
    sessionId: "sess-fresh",
    createdAt: fixedNow - 1_000,
    expiresAt: fixedNow + 60_000,
  });

  const res = await app.request("/me", {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=sess-fresh` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    user: { id: string; email: string };
    session: { id: string; user_id: string; expires_at: number };
  };
  expect(body.user.id).toBe("user-42");
  expect(body.user.email).toBe("alice@example.com");
  expect(body.session.id).toBe("sess-fresh");
  expect(body.session.user_id).toBe("user-42");
  expect(body.session.expires_at).toBe(fixedNow + 60_000);
});

// ---------------------------------------------------------------------------
// 6. Boundary: now() === expires_at → 401 (treat as expired)
// ---------------------------------------------------------------------------
test("requireAuth: expires_at == now() → 401 (boundary is exclusive)", async () => {
  const db = freshMemDb();
  const fixedNow = 1_700_000_000_000;
  const clock = createClock(fixedNow);
  const app = buildApp(db, clock.now);

  seedUserAndSession(db, {
    userId: "user-9",
    email: "bob@example.com",
    sessionId: "sess-boundary",
    createdAt: fixedNow - 10,
    expiresAt: fixedNow, // exactly at the boundary
  });

  const res = await app.request("/me", {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=sess-boundary` },
  });
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// 7. Clerk bearer token fallback creates a local user and binds auth context.
// ---------------------------------------------------------------------------
test("requireAuth: Clerk bearer token → local user + auth context", async () => {
  const db = freshMemDb();
  const fixedNow = 1_700_000_000_000;
  const clock = createClock(fixedNow);
  const app = buildApp(db, clock.now, {
    clerkAuth: async (req) => {
      expect(req.headers.get("authorization")).toBe("Bearer clerk-session");
      return { id: "user_clerk_123", email: "clerk@example.com" };
    },
  });

  const res = await app.request("/me", {
    headers: { Authorization: "Bearer clerk-session" },
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    user: { id: string; email: string };
    session: { id: string; user_id: string; expires_at: number };
  };
  expect(body.user.email).toBe("clerk@example.com");
  expect(body.session.id).toBe("clerk:user_clerk_123");
  expect(body.session.user_id).toBe(body.user.id);
  expect(body.session.expires_at).toBe(Number.MAX_SAFE_INTEGER);

  const rows = db.select().from(usersTable).all();
  expect(rows).toMatchObject([{ email: "clerk@example.com" }]);
});

// ---------------------------------------------------------------------------
// 8. Cookie sessions stay authoritative when both cookie and bearer exist.
// ---------------------------------------------------------------------------
test("requireAuth: valid cookie wins over Clerk bearer fallback", async () => {
  const db = freshMemDb();
  const fixedNow = 1_700_000_000_000;
  const clock = createClock(fixedNow);
  let clerkCalls = 0;
  const app = buildApp(db, clock.now, {
    clerkAuth: async () => {
      clerkCalls += 1;
      return { id: "user_clerk_ignored", email: "ignored@example.com" };
    },
  });
  seedUserAndSession(db, {
    userId: "user-cookie",
    email: "cookie@example.com",
    sessionId: "sess-cookie",
    createdAt: fixedNow - 1_000,
    expiresAt: fixedNow + 60_000,
  });

  const res = await app.request("/me", {
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=sess-cookie`,
      Authorization: "Bearer clerk-session",
    },
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string; email: string } };
  expect(body.user).toEqual({ id: "user-cookie", email: "cookie@example.com" });
  expect(clerkCalls).toBe(0);
});
