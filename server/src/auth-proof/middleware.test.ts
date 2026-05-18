/**
 * T034 — requireAuthProof middleware tests.
 *
 * Gates downstream handlers behind a verified target whose proof is
 * younger than VERIFIED_TTL_MS (90 days). On failure the middleware
 * short-circuits with HTTP 403 + a JSON envelope carrying a code +
 * re-verification hint; on success it binds the target row into the
 * Hono context so handlers can read it via `c.get("target")`.
 *
 * Test plan (one assertion family per test):
 *   1. Unknown target id → 403 + "target_not_found".
 *   2. status='unverified' → 403 + "auth_proof_required".
 *   3. status='verified', verified_at < 90d ago → 200 + target attached.
 *   4. status='verified', verified_at == 90d ago → 403 + "auth_proof_stale"
 *      (boundary inclusive on the stale side; matches the matching
 *      auth/middleware.ts convention of `now >= expires_at`).
 *   5. status='verified', verified_at == 100d ago → 403 "auth_proof_stale".
 *   6. status='verified' but verified_at IS NULL → 403 (defensive).
 *   7. dual param support: route declared with :id (not :targetId)
 *      still resolves — middleware reads both names.
 *
 * Param naming: spec uses :targetId; some routes in this codebase use :id.
 * Middleware reads `:targetId` first, falling back to `:id` so it can
 * mount under either convention without route rewrites.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { createDb, type DB } from "../db/client.ts";
import {
  createRequireAuthProof,
  VERIFIED_TTL_MS,
  type AuthProofVariables,
} from "./middleware.ts";

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

function applyMigrations(db: DB): void {
  (db.$client as Database).exec(migrationSql());
}

interface SeedOpts {
  readonly status: "unverified" | "verified" | "expired";
  readonly verifiedAt: number | null;
}

interface Seed {
  readonly userId: string;
  readonly projectId: string;
  readonly targetId: string;
}

function seedTarget(db: DB, t0: number, opts: SeedOpts): Seed {
  const raw = db.$client as Database;
  const userId = "user_01HABCXXXXXXXXXXXXXXXXXX1";
  const projectId = "proj_01HABCXXXXXXXXXXXXXXXX2";
  const targetId = "tgt_01HABCXXXXXXXXXXXXXXXXX3";
  raw.exec(
    `INSERT INTO users (id, email, created_at) VALUES ('${userId}', 'a@b.test', ${t0})`,
  );
  raw.exec(
    `INSERT INTO projects (id, user_id, name, created_at) VALUES ('${projectId}', '${userId}', 'p', ${t0})`,
  );
  const verifiedAtSql =
    opts.verifiedAt === null ? "NULL" : String(opts.verifiedAt);
  raw.exec(
    `INSERT INTO targets (id, project_id, url, status, verified_at, created_at) ` +
      `VALUES ('${targetId}', '${projectId}', 'https://example.com', '${opts.status}', ${verifiedAtSql}, ${t0})`,
  );
  return { userId, projectId, targetId };
}

/** Build a tiny app with the middleware mounted and a downstream that
 *  echoes back whatever the middleware bound into context. */
function buildApp(db: DB, now: () => number, paramName: "targetId" | "id" = "targetId") {
  const app = new Hono<{ Variables: AuthProofVariables }>();
  const mw = createRequireAuthProof({ db, now });
  app.use(`/protected/:${paramName}`, mw);
  app.get(`/protected/:${paramName}`, (c) => {
    const target = c.get("target");
    return c.json({ ok: true, target });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Test 1 — unknown target → 403.
// ---------------------------------------------------------------------------
test("requireAuthProof: unknown target → 403 target_not_found", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const app = buildApp(db, () => t0);

  const res = await app.request("/protected/unknown-id");
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string; hint?: string };
  expect(body.error).toBe("target_not_found");
});

// ---------------------------------------------------------------------------
// Test 2 — unverified target → 403.
// ---------------------------------------------------------------------------
test("requireAuthProof: unverified target → 403 auth_proof_required", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0, {
    status: "unverified",
    verifiedAt: null,
  });
  const app = buildApp(db, () => t0);

  const res = await app.request(`/protected/${targetId}`);
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string; hint?: string };
  expect(body.error).toBe("auth_proof_required");
  expect(typeof body.hint).toBe("string");
  expect(body.hint!.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 3 — verified, fresh (< 90d) → next() + target attached.
// ---------------------------------------------------------------------------
test("requireAuthProof: verified < 90d → 200 + target on context", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const oneDay = 24 * 60 * 60 * 1000;
  const { targetId, projectId } = seedTarget(db, t0 - 10 * oneDay, {
    status: "verified",
    verifiedAt: t0 - oneDay,
  });
  const app = buildApp(db, () => t0);

  const res = await app.request(`/protected/${targetId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    target: {
      id: string;
      project_id: string;
      url: string;
      status: string;
      verified_at: number | null;
    };
  };
  expect(body.ok).toBe(true);
  expect(body.target.id).toBe(targetId);
  expect(body.target.project_id).toBe(projectId);
  expect(body.target.status).toBe("verified");
  expect(body.target.verified_at).toBe(t0 - oneDay);
  expect(body.target.url).toBe("https://example.com");
});

// ---------------------------------------------------------------------------
// Test 4 — verified, boundary (== 90d) → 403 stale (inclusive on stale side).
// ---------------------------------------------------------------------------
test("requireAuthProof: verified == 90d (boundary) → 403 auth_proof_stale", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0 - VERIFIED_TTL_MS, {
    status: "verified",
    verifiedAt: t0 - VERIFIED_TTL_MS,
  });
  const app = buildApp(db, () => t0);

  const res = await app.request(`/protected/${targetId}`);
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string; hint?: string };
  expect(body.error).toBe("auth_proof_stale");
  expect(typeof body.hint).toBe("string");
});

// ---------------------------------------------------------------------------
// Test 5 — verified, very stale (> 90d) → 403.
// ---------------------------------------------------------------------------
test("requireAuthProof: verified > 90d → 403 auth_proof_stale", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const oneDay = 24 * 60 * 60 * 1000;
  const verifiedAt = t0 - 100 * oneDay;
  const { targetId } = seedTarget(db, verifiedAt, {
    status: "verified",
    verifiedAt,
  });
  const app = buildApp(db, () => t0);

  const res = await app.request(`/protected/${targetId}`);
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string; hint?: string };
  expect(body.error).toBe("auth_proof_stale");
});

// ---------------------------------------------------------------------------
// Test 6 — verified status but NULL verified_at → 403 (defensive).
// ---------------------------------------------------------------------------
test("requireAuthProof: status='verified' but verified_at IS NULL → 403", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  // Inconsistent row (should never happen via the verify flow, but
  // defend against manual DB intervention / migration bugs).
  const { targetId } = seedTarget(db, t0, {
    status: "verified",
    verifiedAt: null,
  });
  const app = buildApp(db, () => t0);

  const res = await app.request(`/protected/${targetId}`);
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  // Treated as stale (no timestamp == cannot prove freshness).
  expect(body.error).toBe("auth_proof_stale");
});

// ---------------------------------------------------------------------------
// Test 7 — middleware resolves :id path param too (dual support).
// ---------------------------------------------------------------------------
test("requireAuthProof: works with :id path param as well as :targetId", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const oneDay = 24 * 60 * 60 * 1000;
  const { targetId } = seedTarget(db, t0 - 10 * oneDay, {
    status: "verified",
    verifiedAt: t0 - oneDay,
  });
  const app = buildApp(db, () => t0, "id");

  const res = await app.request(`/protected/${targetId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; target: { id: string } };
  expect(body.ok).toBe(true);
  expect(body.target.id).toBe(targetId);
});
