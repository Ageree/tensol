/**
 * T032 — issueChallenge tests.
 *
 * Pins the contract documented in `specs/001-backend-v2/data-model.md` and
 * `contracts/openapi.yaml`:
 *   - `auth_proofs.challenge` stores the LITERAL string
 *     `tensol-verify=<64-char hex>` (data-model.md line 99).
 *   - One row per issuance — data-model.md explicitly says "Multiple rows
 *     may exist for the same target if user retries; only the most recent
 *     matters" → we do NOT invalidate prior rows on re-issue.
 *   - status starts as `pending`, method=null, verified_at=null.
 *   - expires_at = created_at + 24h (constitution invariant FR-013).
 *   - Audit `auth_proof_issued` is emitted after the tx commits, signed and
 *     chained against the existing audit-log (so verifyChain still holds).
 *
 * Setup mirrors `audit/emit.test.ts`: ad-hoc `:memory:` DB through `createDb`,
 * then bundle every migration SQL file through the raw bun:sqlite handle.
 * We seed users/projects/targets directly with INSERT statements so the FK
 * referenced by auth_proofs.target_id resolves.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import { authProofs, auditLog } from "../db/schema.ts";
import { verifyChain } from "../audit/verify-chain.ts";
import { issueChallenge } from "./challenge.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-issueChallenge";
const HEX_64 = /^[0-9a-f]{64}$/;

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

interface Seed {
  readonly userId: string;
  readonly projectId: string;
  readonly targetId: string;
}

/** Seed a user→project→target row via raw SQL so the FK on auth_proofs
 *  resolves. We deliberately avoid going through the higher-level services
 *  (T028/T029) to keep this unit test free of upstream coupling. */
function seedTarget(db: DB, t0: number): Seed {
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
  raw.exec(
    `INSERT INTO targets (id, project_id, url, status, created_at) ` +
      `VALUES ('${targetId}', '${projectId}', 'https://example.com', 'unverified', ${t0})`,
  );
  return { userId, projectId, targetId };
}

// ---------------------------------------------------------------------------
// Test 1 — happy path: instructions shape + format + default 24h TTL.
// ---------------------------------------------------------------------------
test("issueChallenge returns ChallengeInstructions with correct shape and 24h TTL", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const fixedNow = 1_700_000_500_000;
  const result = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => fixedNow },
  );

  // ULID-ish challenge id (26 Crockford chars).
  expect(result.challenge_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

  // raw_token is 64 lowercase hex chars (32 random bytes).
  expect(result.raw_token).toMatch(HEX_64);

  // Full DNS TXT payload is `tensol-verify=<hex>` (data-model.md line 99).
  expect(result.token).toBe(`tensol-verify=${result.raw_token}`);

  // Default TTL = 24h.
  const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;
  expect(result.expires_at).toBe(fixedNow + TWENTY_FOUR_H_MS);

  // Methods payload shape.
  expect(result.methods.dns_txt.record_name).toBe("_tensol-verify.example.com");
  expect(result.methods.dns_txt.record_value).toBe(
    `tensol-verify=${result.raw_token}`,
  );
  expect(result.methods.well_known_file.path).toBe(
    "/.well-known/tensol-verify.txt",
  );
  expect(result.methods.well_known_file.content).toBe(result.raw_token);
  expect(result.methods.meta_tag.name).toBe("tensol-verify");
  expect(result.methods.meta_tag.content).toBe(result.raw_token);
  expect(result.methods.meta_tag.html_snippet).toBe(
    `<meta name="tensol-verify" content="${result.raw_token}">`,
  );
});

// ---------------------------------------------------------------------------
// Test 2 — DB row created with correct shape.
// ---------------------------------------------------------------------------
test("issueChallenge inserts an auth_proofs row in `pending` state", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const fixedNow = 1_700_000_500_000;
  const result = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => fixedNow },
  );

  const rows = db
    .select()
    .from(authProofs)
    .where(eq(authProofs.id, result.challenge_id))
    .all();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.targetId).toBe(targetId);
  expect(row.challenge).toBe(`tensol-verify=${result.raw_token}`);
  expect(row.status).toBe("pending");
  expect(row.method).toBeNull();
  expect(row.verifiedAt).toBeNull();
  expect(row.createdAt).toBe(fixedNow);
  expect(row.expiresAt).toBe(fixedNow + 24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Test 3 — audit `auth_proof_issued` is emitted with target_id + auth_proof_id.
// ---------------------------------------------------------------------------
test("issueChallenge emits auth_proof_issued audit row", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const result = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );

  const rows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "auth_proof_issued"))
    .all();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.event).toBe("auth_proof_issued");
  expect(row.outcome).toBe("success");
  expect(row.targetId).toBe(targetId);
  expect(row.authProofId).toBe(result.challenge_id);
  // metadata is alpha-sorted JSON; hostname is captured for ops.
  expect(row.metadataJson).toContain('"hostname":"example.com"');
});

// ---------------------------------------------------------------------------
// Test 4 — token uniqueness across 100 sequential issuances.
// ---------------------------------------------------------------------------
test("issueChallenge generates unique tokens across 100 issuances", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const tokens = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const r = await issueChallenge(
      db,
      { targetId, hostname: "example.com" },
      { signingKey: KEY, now: () => t0 + i + 1 },
    );
    expect(r.raw_token).toMatch(HEX_64);
    tokens.add(r.raw_token);
  }
  expect(tokens.size).toBe(100);
});

// ---------------------------------------------------------------------------
// Test 5 — injected `now` controls created_at and expires_at deterministically.
// ---------------------------------------------------------------------------
test("issueChallenge honours injected now() for created_at and expires_at", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const fakeNow = 1_000_000;
  const result = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => fakeNow },
  );
  const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;
  expect(result.expires_at).toBe(fakeNow + TWENTY_FOUR_H_MS);

  const row = db
    .select()
    .from(authProofs)
    .where(eq(authProofs.id, result.challenge_id))
    .get()!;
  expect(row.createdAt).toBe(fakeNow);
  expect(row.expiresAt).toBe(fakeNow + TWENTY_FOUR_H_MS);
});

// ---------------------------------------------------------------------------
// Test 6 — custom ttlMs overrides default 24h.
// ---------------------------------------------------------------------------
test("issueChallenge honours custom ttlMs", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const fakeNow = 1_700_000_500_000;
  const ttlMs = 60_000;
  const result = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => fakeNow, ttlMs },
  );
  expect(result.expires_at).toBe(fakeNow + ttlMs);

  const row = db
    .select()
    .from(authProofs)
    .where(eq(authProofs.id, result.challenge_id))
    .get()!;
  expect(row.expiresAt).toBe(fakeNow + ttlMs);
});

// ---------------------------------------------------------------------------
// Test 7 — audit chain integrity is preserved after issueChallenge.
// ---------------------------------------------------------------------------
test("issueChallenge keeps audit chain verifyChain-valid", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  // Issue twice → two chained audit rows.
  await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );
  await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 2 },
  );

  const result = verifyChain(db, KEY);
  expect(result.ok).toBe(true);
  expect(result.rows).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Test 8 — re-issuing on same target keeps prior rows untouched (data-model
//          line 108 explicitly allows multiple rows per target).
// ---------------------------------------------------------------------------
test("issueChallenge does NOT invalidate prior rows on re-issue (multiple rows allowed)", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const a = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );
  const b = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 2 },
  );

  expect(a.challenge_id).not.toBe(b.challenge_id);
  expect(a.raw_token).not.toBe(b.raw_token);

  const rows = db
    .select()
    .from(authProofs)
    .where(eq(authProofs.targetId, targetId))
    .orderBy(asc(authProofs.createdAt))
    .all();
  // Both rows still present, both pending.
  expect(rows).toHaveLength(2);
  expect(rows[0]!.status).toBe("pending");
  expect(rows[1]!.status).toBe("pending");
});

// ---------------------------------------------------------------------------
// Test 9 — signingKey is mandatory: missing/empty key throws.
// ---------------------------------------------------------------------------
test("issueChallenge throws when signingKey is empty (audit cannot be signed)", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  await expect(
    issueChallenge(
      db,
      { targetId, hostname: "example.com" },
      { signingKey: "", now: () => t0 + 1 },
    ),
  ).rejects.toThrow();
});
