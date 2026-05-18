/**
 * T035 — Integration tests for `/api/targets/:id/auth-proof/*` routes.
 *
 * Coverage matrix (acceptance criterion from tasks.md line 82):
 *   1. Issue → verify happy path with mocked DNS.
 *   2. Failure-mode response shape (all probes fail → 422).
 *   3. Expiry behavior (challenge expired → 410).
 *   4. Refusal to scan unverified target (US2 — POST /api/scans → 403).
 *   5. Unauthenticated → 401.
 *   6. Cross-user ownership → 404.
 *   7. Verify before any challenge issued → 410 no_challenge.
 *   8. Audit chain still verifies after mixed ops.
 *
 * Pattern mirrors `projects-targets.test.ts` (T030): fresh `:memory:` SQLite per
 * test, schema applied via raw migration SQL, user+session baked via Drizzle
 * (no magic-link round-trip — T026 already covers that surface).
 *
 * US2 scan-refusal note:
 *   The full `POST /api/scans` route lands in T041. To still cover US2's
 *   "refusal to scan unverified target" contract at T035, we mount a thin
 *   inline endpoint `POST /api/scans-test` that pipes the request through
 *   `createRequireAuthProof` — exactly the middleware the production scans
 *   route will use. A 403 here proves the gating chain end-to-end without
 *   forward-coupling this test file to T041.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  authProofs as authProofsTable,
  projects as projectsTable,
  sessions as sessionsTable,
  targets as targetsTable,
  users as usersTable,
} from "../../src/db/schema.ts";
import { createClock } from "../../src/lib/time.ts";
import { ulid } from "../../src/lib/ids.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { SESSION_COOKIE_NAME } from "../../src/auth/session.ts";
import {
  createRequireAuth,
  type AuthVariables,
} from "../../src/auth/middleware.ts";
import {
  createRequireAuthProof,
  type AuthProofVariables,
} from "../../src/auth-proof/middleware.ts";
import { createAuthProofRoutes } from "../../src/routes/auth-proof.ts";
import type { VerifyDeps, FetchResponseLike } from "../../src/auth-proof/verify.ts";
import { eq } from "drizzle-orm";

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
      expiresAt: args.now + 30 * 24 * 60 * 60 * 1000,
    })
    .run();
  return {
    userId,
    sessionId,
    cookieHeader: `${SESSION_COOKIE_NAME}=${sessionId}`,
  };
}

interface BakedTarget {
  readonly projectId: string;
  readonly targetId: string;
  readonly url: string;
  readonly hostname: string;
}

function bakeProjectAndTarget(
  db: DB,
  args: { userId: string; url: string; now: number },
): BakedTarget {
  const projectId = ulid(args.now + 10);
  db.insert(projectsTable)
    .values({
      id: projectId,
      userId: args.userId,
      name: "P",
      createdAt: args.now,
    })
    .run();
  const targetId = ulid(args.now + 20);
  db.insert(targetsTable)
    .values({
      id: targetId,
      projectId,
      url: args.url,
      status: "unverified",
      verifiedAt: null,
      createdAt: args.now,
    })
    .run();
  return {
    projectId,
    targetId,
    url: args.url,
    hostname: new URL(args.url).hostname,
  };
}

/** No-op fetch fake; always returns a 404-shaped response. */
function nullFetch(): VerifyDeps["fetchUrl"] {
  return async (): Promise<FetchResponseLike> => ({
    ok: false,
    status: 404,
    text: async () => "",
  });
}

/** No-op DNS fake; always returns zero records. */
function emptyResolveTxt(): VerifyDeps["resolveTxt"] {
  return async () => [];
}

interface BuildAppOpts {
  readonly db: DB;
  readonly now: () => number;
  readonly verifyDeps: VerifyDeps;
}

/**
 * Build a Hono test harness mounting the production auth-proof routes plus
 * an inline `POST /api/scans-test` endpoint that exercises the
 * `requireAuthProof` middleware — proxy for US2's "refusal to scan
 * unverified target" until T041 lands the real scans route.
 */
function buildApp(opts: BuildAppOpts) {
  const app = new Hono();
  app.route(
    "/api/targets",
    createAuthProofRoutes({
      db: opts.db,
      signingKey: SIGNING_KEY,
      now: opts.now,
      verifyDeps: opts.verifyDeps,
    }),
  );

  // ---- US2 scan-refusal proxy --------------------------------------------
  const scansTest = new Hono<{
    Variables: AuthVariables & AuthProofVariables;
  }>();
  scansTest.use(
    "*",
    createRequireAuth({ db: opts.db, now: opts.now }),
  );
  scansTest.post(
    "/",
    createRequireAuthProof({ db: opts.db, now: opts.now }),
    (c) => c.json({ scan: "started" }, 201),
  );
  // Body schema would mandate target_id; we keep this proxy minimal — the
  // path carries the id (mirroring how T041 will declare the param).
  const scansById = new Hono<{
    Variables: AuthVariables & AuthProofVariables;
  }>();
  scansById.use(
    "*",
    createRequireAuth({ db: opts.db, now: opts.now }),
  );
  scansById.post(
    "/:id",
    createRequireAuthProof({ db: opts.db, now: opts.now }),
    (c) => c.json({ scan: "started" }, 201),
  );
  app.route("/api/scans-test", scansById);

  return app;
}

// ---------------------------------------------------------------------------
// Test 1 — Issue → verify happy path with mocked DNS.
// ---------------------------------------------------------------------------
test("T035: issue → verify happy path (DNS TXT)", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const target = bakeProjectAndTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });

  // Capturable closure so the DNS fake can yield the freshly issued token.
  let issuedRawToken: string | null = null;
  const verifyDeps: VerifyDeps = {
    resolveTxt: async (hostname) => {
      if (hostname !== `_tensol-verify.${target.hostname}`) return [];
      if (!issuedRawToken) return [];
      return [[`tensol-verify=${issuedRawToken}`]];
    },
    fetchUrl: nullFetch(),
  };

  const app = buildApp({ db, now: clock.now, verifyDeps });

  // 1. Issue.
  const issueRes = await app.request(
    `/api/targets/${target.targetId}/auth-proof/challenge`,
    {
      method: "POST",
      headers: { Cookie: alice.cookieHeader },
    },
  );
  expect(issueRes.status).toBe(201);
  const issueBody = (await issueRes.json()) as {
    challenge_id: string;
    token: string;
    raw_token: string;
    expires_at: number;
    methods: {
      dns_txt: { record_name: string; record_value: string };
      well_known_file: { path: string; content: string };
      meta_tag: { name: string; content: string; html_snippet: string };
    };
  };
  expect(issueBody.raw_token).toMatch(/^[0-9a-f]{64}$/);
  expect(issueBody.methods.dns_txt.record_name).toBe(
    `_tensol-verify.${target.hostname}`,
  );
  expect(issueBody.methods.dns_txt.record_value).toBe(
    `tensol-verify=${issueBody.raw_token}`,
  );
  expect(issueBody.methods.well_known_file.content).toBe(issueBody.raw_token);
  expect(issueBody.methods.meta_tag.content).toBe(issueBody.raw_token);

  issuedRawToken = issueBody.raw_token;

  // 2. Verify.
  const verifyRes = await app.request(
    `/api/targets/${target.targetId}/auth-proof/verify`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({}),
    },
  );
  expect(verifyRes.status).toBe(200);
  const verifyBody = (await verifyRes.json()) as {
    verified: boolean;
    method: string;
    attempted: Array<{ method: string; succeeded: boolean }>;
  };
  expect(verifyBody.verified).toBe(true);
  expect(verifyBody.method).toBe("dns_txt");
  expect(verifyBody.attempted[0]!.method).toBe("dns_txt");
  expect(verifyBody.attempted[0]!.succeeded).toBe(true);

  // 3. Target row reflects verification.
  const targetRow = db
    .select()
    .from(targetsTable)
    .where(eq(targetsTable.id, target.targetId))
    .get();
  expect(targetRow?.status).toBe("verified");
  expect(targetRow?.verifiedAt).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Test 2 — Unauthenticated.
// ---------------------------------------------------------------------------
test("T035: POST /challenge without cookie → 401", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const app = buildApp({
    db,
    now: clock.now,
    verifyDeps: { resolveTxt: emptyResolveTxt(), fetchUrl: nullFetch() },
  });
  // Need a valid ULID-looking id to bypass schema gate.
  const res = await app.request(
    `/api/targets/${ulid(clock.now())}/auth-proof/challenge`,
    { method: "POST" },
  );
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Test 3 — Foreign target (ownership) → 404.
// ---------------------------------------------------------------------------
test("T035: cross-user challenge → 404 not_found", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const bob = bakeUser(db, { email: "bob@example.com", now: clock.now() });
  const aliceTarget = bakeProjectAndTarget(db, {
    userId: alice.userId,
    url: "https://alice.example.com",
    now: clock.now(),
  });
  const app = buildApp({
    db,
    now: clock.now,
    verifyDeps: { resolveTxt: emptyResolveTxt(), fetchUrl: nullFetch() },
  });

  const res = await app.request(
    `/api/targets/${aliceTarget.targetId}/auth-proof/challenge`,
    {
      method: "POST",
      headers: { Cookie: bob.cookieHeader },
    },
  );
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not_found");
});

// ---------------------------------------------------------------------------
// Test 4 — Verify with no challenge yet → 410 no_challenge.
// ---------------------------------------------------------------------------
test("T035: verify before any challenge issued → 410 no_challenge", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const target = bakeProjectAndTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const app = buildApp({
    db,
    now: clock.now,
    verifyDeps: { resolveTxt: emptyResolveTxt(), fetchUrl: nullFetch() },
  });

  const res = await app.request(
    `/api/targets/${target.targetId}/auth-proof/verify`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({}),
    },
  );
  expect(res.status).toBe(410);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("no_challenge");
});

// ---------------------------------------------------------------------------
// Test 5 — All probes fail → 422 with attempted array.
// ---------------------------------------------------------------------------
test("T035: verify with all probes failing → 422 all_failed", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const target = bakeProjectAndTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const app = buildApp({
    db,
    now: clock.now,
    verifyDeps: {
      resolveTxt: async () => [["unrelated-record"]],
      fetchUrl: async () => ({
        ok: true,
        status: 200,
        text: async () => "garbage that does not match",
      }),
    },
  });

  // Issue first.
  const issueRes = await app.request(
    `/api/targets/${target.targetId}/auth-proof/challenge`,
    {
      method: "POST",
      headers: { Cookie: alice.cookieHeader },
    },
  );
  expect(issueRes.status).toBe(201);

  const verifyRes = await app.request(
    `/api/targets/${target.targetId}/auth-proof/verify`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({}),
    },
  );
  expect(verifyRes.status).toBe(422);
  const body = (await verifyRes.json()) as {
    error: string;
    attempted: Array<{ method: string; succeeded: boolean; note: string }>;
  };
  expect(body.error).toBe("all_failed");
  expect(body.attempted.length).toBe(3);
  expect(body.attempted.every((a) => a.succeeded === false)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 6 — Expired challenge → 410 expired.
// ---------------------------------------------------------------------------
test("T035: verify after expiry → 410 expired", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const target = bakeProjectAndTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const app = buildApp({
    db,
    now: clock.now,
    verifyDeps: { resolveTxt: emptyResolveTxt(), fetchUrl: nullFetch() },
  });

  // Issue.
  const issueRes = await app.request(
    `/api/targets/${target.targetId}/auth-proof/challenge`,
    {
      method: "POST",
      headers: { Cookie: alice.cookieHeader },
    },
  );
  expect(issueRes.status).toBe(201);

  // Fast-forward past the 24h TTL.
  clock.advance(25 * 60 * 60 * 1000);

  const verifyRes = await app.request(
    `/api/targets/${target.targetId}/auth-proof/verify`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({}),
    },
  );
  expect(verifyRes.status).toBe(410);
  const body = (await verifyRes.json()) as { error: string };
  expect(body.error).toBe("expired");
});

// ---------------------------------------------------------------------------
// Test 7 — US2: POST /api/scans on unverified target → 403.
// ---------------------------------------------------------------------------
test("T035: refusal to scan unverified target (US2) — 403", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const target = bakeProjectAndTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const app = buildApp({
    db,
    now: clock.now,
    verifyDeps: { resolveTxt: emptyResolveTxt(), fetchUrl: nullFetch() },
  });

  const res = await app.request(`/api/scans-test/${target.targetId}`, {
    method: "POST",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string; hint?: string };
  expect(body.error).toBe("auth_proof_required");
});

// ---------------------------------------------------------------------------
// Test 8 — After verify, scan attempt succeeds (proves middleware lets through).
// ---------------------------------------------------------------------------
test("T035: post-verify scan attempt passes auth-proof gate", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const target = bakeProjectAndTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });

  let raw: string | null = null;
  const app = buildApp({
    db,
    now: clock.now,
    verifyDeps: {
      resolveTxt: async (h) =>
        h === `_tensol-verify.${target.hostname}` && raw
          ? [[`tensol-verify=${raw}`]]
          : [],
      fetchUrl: nullFetch(),
    },
  });

  // Issue.
  const issueRes = await app.request(
    `/api/targets/${target.targetId}/auth-proof/challenge`,
    { method: "POST", headers: { Cookie: alice.cookieHeader } },
  );
  const issueBody = (await issueRes.json()) as { raw_token: string };
  raw = issueBody.raw_token;

  // Verify.
  const verifyRes = await app.request(
    `/api/targets/${target.targetId}/auth-proof/verify`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({}),
    },
  );
  expect(verifyRes.status).toBe(200);

  // Scan should now pass the gate.
  const scanRes = await app.request(`/api/scans-test/${target.targetId}`, {
    method: "POST",
    headers: { Cookie: alice.cookieHeader },
  });
  expect(scanRes.status).toBe(201);
});

// ---------------------------------------------------------------------------
// Test 9 — Audit chain still verifies after mixed ops.
// ---------------------------------------------------------------------------
test("T035: audit chain verifies after issue + verify + failed verify", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const target1 = bakeProjectAndTarget(db, {
    userId: alice.userId,
    url: "https://example.com",
    now: clock.now(),
  });
  const target2 = bakeProjectAndTarget(db, {
    userId: alice.userId,
    url: "https://other.example.com",
    now: clock.now() + 100,
  });

  let raw1: string | null = null;
  const app = buildApp({
    db,
    now: clock.now,
    verifyDeps: {
      resolveTxt: async (h) =>
        h === `_tensol-verify.${target1.hostname}` && raw1
          ? [[`tensol-verify=${raw1}`]]
          : [],
      fetchUrl: nullFetch(),
    },
  });

  // Issue + verify target1 (success).
  const issue1 = await app.request(
    `/api/targets/${target1.targetId}/auth-proof/challenge`,
    { method: "POST", headers: { Cookie: alice.cookieHeader } },
  );
  raw1 = ((await issue1.json()) as { raw_token: string }).raw_token;
  await app.request(
    `/api/targets/${target1.targetId}/auth-proof/verify`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({}),
    },
  );

  // Issue + verify target2 (fails — all probes empty).
  await app.request(
    `/api/targets/${target2.targetId}/auth-proof/challenge`,
    { method: "POST", headers: { Cookie: alice.cookieHeader } },
  );
  await app.request(
    `/api/targets/${target2.targetId}/auth-proof/verify`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: alice.cookieHeader,
      },
      body: JSON.stringify({}),
    },
  );

  const chainRes = verifyChain(db, SIGNING_KEY);
  expect(chainRes.ok).toBe(true);
  // 2 issued + 1 verified + 1 failed = 4 rows.
  expect(chainRes.rows).toBe(4);

  // Sanity: auth_proofs has 2 rows, one verified one pending.
  const proofs = db.select().from(authProofsTable).all();
  expect(proofs.length).toBe(2);
  const verifiedCount = proofs.filter((p) => p.status === "verified").length;
  expect(verifiedCount).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 10 — Malformed target id → 404 (consistency with projects/targets routes).
// ---------------------------------------------------------------------------
test("T035: malformed target id → 404", async () => {
  const db = freshMemDb();
  const clock = createClock(1_700_000_000_000);
  const alice = bakeUser(db, { email: "alice@example.com", now: clock.now() });
  const app = buildApp({
    db,
    now: clock.now,
    verifyDeps: { resolveTxt: emptyResolveTxt(), fetchUrl: nullFetch() },
  });

  const res = await app.request(
    `/api/targets/not-a-ulid/auth-proof/challenge`,
    {
      method: "POST",
      headers: { Cookie: alice.cookieHeader },
    },
  );
  expect(res.status).toBe(404);
});
