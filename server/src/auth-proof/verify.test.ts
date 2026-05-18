/**
 * T033 — verifyChallenge tests.
 *
 * verifyChallenge runs three injectable probes against a target hostname
 * (DNS TXT, well-known file, meta tag) and atomically marks the target +
 * auth_proof row as verified on the first successful probe.
 *
 * deps abstraction (the load-bearing decision of T033):
 *   - resolveTxt  : signature matches node:dns/promises.resolveTxt
 *                   (hostname → string[][]; chunked TXT records). We never
 *                   touch the real resolver in tests.
 *   - fetchUrl    : minimal { ok, status, text() } shape — enough to mock
 *                   without forcing tests to construct full Response objects.
 *   - now         : optional clock for expiry checks.
 *
 * Schema reality check (consulted before writing):
 *   - targets has NO `verified_method` column — method is recorded in audit
 *     metadata, NOT mirrored onto the target row.
 *   - auth_proofs has NO `used_at` column — we update status='verified' and
 *     `verified_at = now()` instead.
 *   - auth_proofs.method enum is "dns_txt" | "file" | "meta_tag" — we use
 *     "file" in the DB column even though the public ProbeMethod string is
 *     "well_known_file" (mapping documented in verify.ts).
 *
 * Audit emit happens AFTER the row-update tx commits, matching the
 * documented T021/T028 nested-BEGIN pattern.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import { authProofs, targets as targetsT, auditLog } from "../db/schema.ts";
import { verifyChain } from "../audit/verify-chain.ts";
import { issueChallenge } from "./challenge.ts";
import { verifyChallenge, type VerifyDeps } from "./verify.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-verifyChallenge";

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

function seedTarget(db: DB, t0: number, url = "https://example.com"): Seed {
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
      `VALUES ('${targetId}', '${projectId}', '${url}', 'unverified', ${t0})`,
  );
  return { userId, projectId, targetId };
}

/** Build injectable probe deps from a simple table of canned responses. */
interface DepsFixture {
  /** Map record-name → array of TXT records (each being string[] chunks). */
  readonly dns?: Record<string, string[][]>;
  /** Map URL → { status, body }. Absence ⇒ throws "ENOTFOUND-like". */
  readonly http?: Record<string, { status: number; body: string }>;
  /** Force resolveTxt to throw for everything (timeout simulation). */
  readonly dnsThrows?: Error;
}

function mkDeps(fix: DepsFixture): VerifyDeps {
  return {
    async resolveTxt(hostname: string): Promise<string[][]> {
      if (fix.dnsThrows) throw fix.dnsThrows;
      const records = fix.dns?.[hostname];
      if (!records) {
        const err = new Error(`ENOTFOUND ${hostname}`) as Error & {
          code?: string;
        };
        err.code = "ENOTFOUND";
        throw err;
      }
      return records;
    },
    async fetchUrl(url: string) {
      const r = fix.http?.[url];
      if (!r) {
        throw new Error(`mock fetch: no canned response for ${url}`);
      }
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        async text() {
          return r.body;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1 — DNS TXT happy path.
// ---------------------------------------------------------------------------
test("verifyChallenge marks target verified via dns_txt probe", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const challenge = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );

  const deps = mkDeps({
    dns: {
      "_tensol-verify.example.com": [[`tensol-verify=${challenge.raw_token}`]],
    },
  });

  const result = await verifyChallenge(
    db,
    { targetId },
    deps,
    { signingKey: KEY, now: () => t0 + 100 },
  );

  if (!result.ok) throw new Error("expected ok result");
  expect(result.verified).toBe(true);
  expect(result.method).toBe("dns_txt");
  expect(result.attempted).toHaveLength(1);
  expect(result.attempted[0]!.method).toBe("dns_txt");
  expect(result.attempted[0]!.succeeded).toBe(true);

  // Target row updated.
  const target = db
    .select()
    .from(targetsT)
    .where(eq(targetsT.id, targetId))
    .get()!;
  expect(target.status).toBe("verified");
  expect(target.verifiedAt).toBe(t0 + 100);

  // auth_proofs row updated.
  const proof = db
    .select()
    .from(authProofs)
    .where(eq(authProofs.id, challenge.challenge_id))
    .get()!;
  expect(proof.status).toBe("verified");
  expect(proof.method).toBe("dns_txt");
  expect(proof.verifiedAt).toBe(t0 + 100);

  // Audit row emitted.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "auth_proof_verified"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.targetId).toBe(targetId);
  expect(audits[0]!.authProofId).toBe(challenge.challenge_id);
  expect(audits[0]!.metadataJson).toContain('"method":"dns_txt"');
});

// ---------------------------------------------------------------------------
// Test 2 — well-known file fallback.
// ---------------------------------------------------------------------------
test("verifyChallenge falls back to well_known_file when DNS fails", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const challenge = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );

  const deps = mkDeps({
    // No DNS records → resolveTxt throws ENOTFOUND.
    http: {
      "https://example.com/.well-known/tensol-verify.txt": {
        status: 200,
        body: challenge.raw_token + "\n",
      },
    },
  });

  const result = await verifyChallenge(
    db,
    { targetId },
    deps,
    { signingKey: KEY, now: () => t0 + 100 },
  );

  if (!result.ok) throw new Error("expected ok result");
  expect(result.method).toBe("well_known_file");
  expect(result.attempted).toHaveLength(2);
  expect(result.attempted[0]!.method).toBe("dns_txt");
  expect(result.attempted[0]!.succeeded).toBe(false);
  expect(result.attempted[1]!.method).toBe("well_known_file");
  expect(result.attempted[1]!.succeeded).toBe(true);

  const proof = db
    .select()
    .from(authProofs)
    .where(eq(authProofs.id, challenge.challenge_id))
    .get()!;
  expect(proof.method).toBe("file");
});

// ---------------------------------------------------------------------------
// Test 3 — meta-tag fallback (last resort).
// ---------------------------------------------------------------------------
test("verifyChallenge falls back to meta_tag when DNS and file fail", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const challenge = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );

  const deps = mkDeps({
    http: {
      "https://example.com/.well-known/tensol-verify.txt": {
        status: 404,
        body: "not found",
      },
      "https://example.com/": {
        status: 200,
        body:
          `<!doctype html><html><head>` +
          `<meta name="tensol-verify" content="${challenge.raw_token}">` +
          `</head><body>hi</body></html>`,
      },
    },
  });

  const result = await verifyChallenge(
    db,
    { targetId },
    deps,
    { signingKey: KEY, now: () => t0 + 100 },
  );

  if (!result.ok) throw new Error("expected ok result");
  expect(result.method).toBe("meta_tag");
  expect(result.attempted).toHaveLength(3);
  expect(result.attempted.map((a) => a.method)).toEqual([
    "dns_txt",
    "well_known_file",
    "meta_tag",
  ]);
  expect(result.attempted[2]!.succeeded).toBe(true);

  const proof = db
    .select()
    .from(authProofs)
    .where(eq(authProofs.id, challenge.challenge_id))
    .get()!;
  expect(proof.method).toBe("meta_tag");
});

// ---------------------------------------------------------------------------
// Test 4 — no challenge at all → 410.
// ---------------------------------------------------------------------------
test("verifyChallenge returns 410 no_challenge when no auth_proofs row exists", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const deps = mkDeps({});
  const result = await verifyChallenge(
    db,
    { targetId },
    deps,
    { signingKey: KEY, now: () => t0 + 100 },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe(410);
  expect(result.reason).toBe("no_challenge");
  expect(result.attempted).toEqual([]);
});

// ---------------------------------------------------------------------------
// Test 5 — expired challenge → 410, audit failure recorded.
// ---------------------------------------------------------------------------
test("verifyChallenge returns 410 expired and emits auth_proof_failed", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const challenge = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1, ttlMs: 60_000 },
  );

  // Fast-forward past expiry.
  const result = await verifyChallenge(
    db,
    { targetId },
    mkDeps({}),
    { signingKey: KEY, now: () => challenge.expires_at + 1 },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe(410);
  expect(result.reason).toBe("expired");

  // Target remains unverified.
  const target = db
    .select()
    .from(targetsT)
    .where(eq(targetsT.id, targetId))
    .get()!;
  expect(target.status).toBe("unverified");

  // Audit row recorded with reason=expired.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "auth_proof_failed"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.outcome).toBe("failure");
  expect(audits[0]!.metadataJson).toContain('"reason":"expired"');
});

// ---------------------------------------------------------------------------
// Test 6 — all probes fail → 422 with three attempted entries.
// ---------------------------------------------------------------------------
test("verifyChallenge returns 422 all_failed with all probes attempted", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );

  const deps = mkDeps({
    dns: {
      "_tensol-verify.example.com": [[`tensol-verify=garbage`]],
    },
    http: {
      "https://example.com/.well-known/tensol-verify.txt": {
        status: 200,
        body: "not-the-token",
      },
      "https://example.com/": {
        status: 200,
        body: "<html><head></head><body>no meta tag here</body></html>",
      },
    },
  });

  const result = await verifyChallenge(
    db,
    { targetId },
    deps,
    { signingKey: KEY, now: () => t0 + 100 },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe(422);
  expect(result.reason).toBe("all_failed");
  expect(result.attempted).toHaveLength(3);
  for (const a of result.attempted) {
    expect(a.succeeded).toBe(false);
  }

  // Target unchanged.
  const target = db
    .select()
    .from(targetsT)
    .where(eq(targetsT.id, targetId))
    .get()!;
  expect(target.status).toBe("unverified");

  // Audit failure recorded.
  const audits = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.event, "auth_proof_failed"))
    .all();
  expect(audits).toHaveLength(1);
  expect(audits[0]!.metadataJson).toContain('"reason":"all_failed"');
});

// ---------------------------------------------------------------------------
// Test 7 — preferMethod runs the preferred probe first.
// ---------------------------------------------------------------------------
test("verifyChallenge honours preferMethod ordering", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const challenge = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );

  const deps = mkDeps({
    http: {
      "https://example.com/.well-known/tensol-verify.txt": {
        status: 200,
        body: challenge.raw_token,
      },
    },
  });

  const result = await verifyChallenge(
    db,
    { targetId },
    deps,
    {
      signingKey: KEY,
      now: () => t0 + 100,
      preferMethod: "well_known_file",
    },
  );

  if (!result.ok) throw new Error("expected ok");
  expect(result.method).toBe("well_known_file");
  // file is FIRST in the attempted list when preferMethod is set.
  expect(result.attempted[0]!.method).toBe("well_known_file");
  expect(result.attempted[0]!.succeeded).toBe(true);
  expect(result.attempted).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Test 8 — DNS throws (timeout-like) but file probe succeeds.
// ---------------------------------------------------------------------------
test("verifyChallenge tolerates DNS throw and falls back to file probe", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const challenge = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );

  const deps = mkDeps({
    dnsThrows: new Error("ETIMEDOUT"),
    http: {
      "https://example.com/.well-known/tensol-verify.txt": {
        status: 200,
        body: challenge.raw_token,
      },
    },
  });

  const result = await verifyChallenge(
    db,
    { targetId },
    deps,
    { signingKey: KEY, now: () => t0 + 100 },
  );

  if (!result.ok) throw new Error("expected ok");
  expect(result.method).toBe("well_known_file");
  expect(result.attempted[0]!.method).toBe("dns_txt");
  expect(result.attempted[0]!.succeeded).toBe(false);
  expect(result.attempted[0]!.note).toContain("ETIMEDOUT");
});

// ---------------------------------------------------------------------------
// Test 9 — HTTPS 404 on file probe → succeeded=false, meta-tag attempted.
// ---------------------------------------------------------------------------
test("verifyChallenge marks well_known_file as failed on HTTP 404 and proceeds", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );

  const deps = mkDeps({
    http: {
      "https://example.com/.well-known/tensol-verify.txt": {
        status: 404,
        body: "",
      },
      "https://example.com/": {
        status: 500,
        body: "boom",
      },
    },
  });

  const result = await verifyChallenge(
    db,
    { targetId },
    deps,
    { signingKey: KEY, now: () => t0 + 100 },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe(422);
  expect(result.attempted).toHaveLength(3);
  const file = result.attempted.find((a) => a.method === "well_known_file")!;
  expect(file.succeeded).toBe(false);
  expect(file.note).toContain("404");
});

// ---------------------------------------------------------------------------
// Test 10 — audit chain integrity preserved across issue + verify.
// ---------------------------------------------------------------------------
test("verifyChallenge keeps audit chain verifyChain-valid after success", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const challenge = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );

  const deps = mkDeps({
    dns: {
      "_tensol-verify.example.com": [[`tensol-verify=${challenge.raw_token}`]],
    },
  });

  await verifyChallenge(
    db,
    { targetId },
    deps,
    { signingKey: KEY, now: () => t0 + 100 },
  );

  const chain = verifyChain(db, KEY);
  expect(chain.ok).toBe(true);
  expect(chain.rows).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Test 11 — multi-string TXT records (resolveTxt returns chunked strings)
//            are joined before comparison (RFC 1035 long TXT records).
// ---------------------------------------------------------------------------
test("verifyChallenge joins multi-string TXT chunks before matching", async () => {
  const db = createDb(":memory:");
  applyMigrations(db);
  const t0 = 1_700_000_000_000;
  const { targetId } = seedTarget(db, t0);

  const challenge = await issueChallenge(
    db,
    { targetId, hostname: "example.com" },
    { signingKey: KEY, now: () => t0 + 1 },
  );
  const full = `tensol-verify=${challenge.raw_token}`;
  // Split the value across two strings within one record.
  const head = full.slice(0, 20);
  const tail = full.slice(20);

  const deps = mkDeps({
    dns: {
      "_tensol-verify.example.com": [[head, tail]],
    },
  });

  const result = await verifyChallenge(
    db,
    { targetId },
    deps,
    { signingKey: KEY, now: () => t0 + 100 },
  );

  if (!result.ok) throw new Error("expected ok");
  expect(result.method).toBe("dns_txt");
});
