/**
 * T101 — seed-golden-db: deterministically generates the integration-test
 * fixture database used by the audit-chain verifier smoke check.
 *
 * Run via:
 *   cd server && bun run scripts/seed-golden-db.ts
 *
 * Output:
 *   server/tests/fixtures/golden.db — a SQLite file with the canonical
 *   schema (from `migrations/0000_init.sql`) populated with ~11 signed
 *   audit rows covering the full scan-lifecycle event vocabulary.
 *
 * Determinism contract:
 *   - `SIGN_KEY` is a fixed string — DO NOT rotate without regenerating
 *     the fixture. The verifier smoke check in tasks.md T101 passes this
 *     same key on the CLI; rotating either side breaks acceptance.
 *   - `ts` values are fixed integers (not `Date.now()`) so re-running the
 *     seed produces byte-identical signatures, keeping the fixture
 *     diff-clean across machines and check-in time.
 *   - Events are emitted in a fixed order; the autoincrement `id` column
 *     therefore matches across runs.
 *
 * Why we apply the migration directly via `db.$client.exec(sqlText)`
 * instead of going through drizzle-kit:
 *   - `drizzle-kit migrate` reads `drizzle.config.ts` and writes to the
 *     dev database (`server/data/dev.db`) by default. We need to point
 *     at an arbitrary on-disk path.
 *   - The migration file uses Drizzle's `--> statement-breakpoint`
 *     marker; SQLite's `exec` accepts the whole script if we strip those
 *     markers (they're comments + semicolons that bun:sqlite already
 *     handles as statement terminators, but the explicit `-->` syntax
 *     is non-standard SQL and would error). See `verify-chain.ts`
 *     `ensureAuditTable` for the same trick.
 */
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createDb } from "../src/db/client.ts";
import { emitSignedAudit, type EmitArgs } from "../src/audit/emit.ts";

/** Path is relative to the server/ working directory (where `bun run` is
 *  invoked from). Matches the tasks.md T101 acceptance command exactly. */
const DB_PATH = "tests/fixtures/golden.db";

/** Deterministic signing key — MUST match the value passed to verify-chain
 *  in the T101 smoke check. Length is irrelevant to HMAC security here
 *  because this is a test fixture, not a production secret. */
const SIGN_KEY = "test-golden-fixture-key-do-not-rotate-deterministic-vector";

/** Fixed base timestamp (2026-05-19 00:00:00 UTC in ms). Each event adds
 *  a 1-minute offset so they sort naturally by ts as well as by id. */
const BASE_TS = 1_779_321_600_000;

/** Canonical event sequence covering a full scan lifecycle, chosen to
 *  exercise every nullable field on `audit_log` at least once:
 *    auth_login_* → project/target creation → auth-proof flow → scan
 *    lifecycle → VPS lifecycle → reconcile sweep.
 *  This is the same vocabulary referenced in data-model.md. */
const EVENTS: ReadonlyArray<EmitArgs> = [
  {
    event: "auth_login_requested",
    outcome: "success",
    user_id: "u-golden-1",
    metadata: { email: "alice@example.com" },
  },
  {
    event: "auth_login_succeeded",
    outcome: "success",
    user_id: "u-golden-1",
    metadata: { session_id: "s-golden-1" },
  },
  {
    event: "project_created",
    outcome: "success",
    user_id: "u-golden-1",
    project_id: "p-golden-1",
    metadata: { name: "Golden Fixture Project" },
  },
  {
    event: "target_created",
    outcome: "success",
    user_id: "u-golden-1",
    project_id: "p-golden-1",
    target_id: "t-golden-1",
    metadata: { url: "https://example.com" },
  },
  {
    event: "auth_proof_issued",
    outcome: "success",
    user_id: "u-golden-1",
    target_id: "t-golden-1",
    auth_proof_id: "ap-golden-1",
    metadata: { hostname: "example.com", method: "dns_txt" },
  },
  {
    event: "auth_proof_verified",
    outcome: "success",
    user_id: "u-golden-1",
    target_id: "t-golden-1",
    auth_proof_id: "ap-golden-1",
    metadata: { method: "dns_txt" },
  },
  {
    event: "scan_started",
    outcome: "success",
    user_id: "u-golden-1",
    project_id: "p-golden-1",
    target_id: "t-golden-1",
    scan_id: "sc-golden-1",
    metadata: { profile: "recon" },
  },
  {
    event: "vps_provisioned",
    outcome: "success",
    user_id: "u-golden-1",
    scan_id: "sc-golden-1",
    vps_instance_id: "v-golden-1",
    metadata: { ipv4: "1.2.3.4", provider_server_id: "srv-12345" },
  },
  {
    event: "decepticon_invoked",
    outcome: "success",
    user_id: "u-golden-1",
    scan_id: "sc-golden-1",
    vps_instance_id: "v-golden-1",
    metadata: { orchestrator: "recon" },
  },
  {
    event: "scan_completed",
    outcome: "success",
    user_id: "u-golden-1",
    scan_id: "sc-golden-1",
    metadata: { inserted_findings: 3, skipped_findings: 0 },
  },
  {
    event: "vps_destroyed",
    outcome: "success",
    user_id: "u-golden-1",
    vps_instance_id: "v-golden-1",
    metadata: { reason: "scan_completed" },
  },
];

async function main(): Promise<void> {
  // Recreate the fixture from scratch so the seed is idempotent.
  await mkdir(dirname(DB_PATH), { recursive: true });
  if (existsSync(DB_PATH)) {
    await unlink(DB_PATH);
  }

  const db = createDb(DB_PATH);

  try {
    // Apply the initial migration. Strip Drizzle's `--> statement-breakpoint`
    // sentinels since they are not valid SQL — same shape as
    // `ensureAuditTable` in verify-chain.ts.
    const sqlText = readFileSync("migrations/0000_init.sql", "utf-8").replace(
      /-->\s*statement-breakpoint/g,
      "",
    );
    (db.$client as Database).exec(sqlText);

    // Emit each event with a fixed timestamp offset for determinism.
    for (let i = 0; i < EVENTS.length; i++) {
      const e = EVENTS[i]!;
      await emitSignedAudit(
        db,
        { ...e, ts: BASE_TS + i * 60_000 },
        { key: SIGN_KEY },
      );
    }

    process.stdout.write(
      `seeded ${EVENTS.length} audit rows -> ${DB_PATH}\n`,
    );
  } finally {
    (db.$client as Database).close();
  }
}

main().catch((err) => {
  process.stderr.write(`seed-golden-db: ${String(err)}\n`);
  process.exit(1);
});
