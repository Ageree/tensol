/**
 * T015 — verify-chain: out-of-band audit chain verifier.
 *
 * Exposed as BOTH a function (`verifyChain`) and a CLI entrypoint
 * (`bun run src/audit/verify-chain.ts --db <path> --key <hex>`). The split
 * exists so the same recompute-the-chain logic can be:
 *   1. Unit-tested deterministically against an in-process DB handle, and
 *   2. Invoked as a standalone diagnostic / cron job against a production
 *      SQLite file without writing to it.
 *
 * Recompute algorithm (single pass, O(N) over `audit_log`):
 *   - SELECT * FROM audit_log ORDER BY id ASC
 *   - For each row in order:
 *       prevSig = i === 0 ? null : rows[i-1].signature
 *       entry   = rowToEntry(row)         // strip id+sig columns, JSON.parse metadata
 *       expected = signEntry(key, entry, prevSig)
 *       if expected !== row.signature → BROKEN at row.id, stop
 *   - If loop finishes → OK with N rows.
 *
 * Why `prevSig` is read from the in-memory previous row (not from
 * `row.prevSignature`): the chain invariant being verified IS that
 * `row.prevSignature === rows[i-1].signature`. If we trusted the column we
 * would only check signature-vs-its-own-row, missing chain-link tampering.
 * By feeding the previous row's *actual* `signature` column into
 * `signEntry`, the recomputed signature of row N depends transitively on
 * row N-1's signature, which depends on row N-2, and so on — any mutation
 * earlier in the chain propagates to a mismatch at the first downstream
 * row where the verifier diverges from the stored value.
 *
 * SURPRISE: `metadata_json` is stored as a string in SQLite. We MUST
 * `JSON.parse` it before feeding into `AuditEntry.metadataJson`, because
 * `canonicalMessage` re-canonicalises (alpha-sort + stringify) and a
 * pre-stringified value would be JSON.stringify'd a second time (escaping
 * all the quotes) producing a totally different canonical message.
 *
 * SURPRISE: `prevSig === null` vs `prevSig === ""` are equivalent for the
 * signer (both render to the empty 13th field) but we pass `null` for the
 * first row to match how `emitSignedAudit` itself signs it. This keeps the
 * verifier byte-equivalent to the writer's pre-INSERT computation.
 */
import { asc } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDb, type DB } from "../db/client.ts";
import { auditLog, type AuditLog } from "../db/schema.ts";
import { signEntry, type AuditEntry } from "./sign.ts";

/** Result of a chain verification pass. */
export interface VerifyChainResult {
  /** True iff every row recomputed to its stored signature. */
  readonly ok: boolean;
  /** Total rows considered (even on failure — useful for ops dashboards). */
  readonly rows: number;
  /** The `audit_log.id` of the first row whose signature mismatched, or
   *  `undefined` when `ok === true`. */
  readonly brokenAt?: number;
  /** The signature we recomputed at `brokenAt`. Only present on failure.
   *  Used by the CLI's `--verbose` mode. */
  readonly expected?: string;
  /** The signature stored in the DB at `brokenAt`. Only present on failure. */
  readonly actual?: string;
}

/** Build an `AuditEntry` from a stored row by stripping `id`, `prevSignature`,
 *  and `signature` and JSON-parsing the canonicalised metadata column. */
function rowToEntry(row: AuditLog): AuditEntry {
  return {
    event: row.event,
    ts: row.ts,
    userId: row.userId,
    projectId: row.projectId,
    targetId: row.targetId,
    scanId: row.scanId,
    vpsInstanceId: row.vpsInstanceId,
    authProofId: row.authProofId,
    findingId: row.findingId,
    severity: row.severity,
    outcome: row.outcome,
    // `metadataJson` is stored as a canonicalised string; re-parse so
    // `signEntry` can canonicalise it again identically. See module-level
    // SURPRISE note.
    metadataJson: JSON.parse(row.metadataJson) as Record<string, unknown>,
  };
}

/**
 * Verify the audit chain in `db` using `key` as the HMAC signing secret.
 *
 * Pure function over the database state — no writes, no logging, no
 * process.exit. The CLI entrypoint at the bottom of this file handles
 * stdout + exit codes.
 */
export function verifyChain(db: DB, key: string): VerifyChainResult {
  const rows = db
    .select()
    .from(auditLog)
    .orderBy(asc(auditLog.id))
    .all();

  if (rows.length === 0) {
    return { ok: true, rows: 0 };
  }

  let prevSig: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const expected = signEntry(key, rowToEntry(row), prevSig);
    if (expected !== row.signature) {
      return {
        ok: false,
        rows: rows.length,
        brokenAt: row.id,
        expected,
        actual: row.signature,
      };
    }
    prevSig = row.signature;
  }

  return { ok: true, rows: rows.length };
}

// ---------------------------------------------------------------------------
// CLI entrypoint.
// ---------------------------------------------------------------------------

/** Minimal arg parser. Pull `--db <path>` and `--key <hex>`; `--verbose`
 *  is a flag. No external dependency to keep the CLI self-contained. */
interface CliArgs {
  readonly db: string;
  readonly key: string;
  readonly verbose: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let db: string | undefined;
  let key: string | undefined;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") {
      db = argv[++i];
    } else if (a === "--key") {
      key = argv[++i];
    } else if (a === "--verbose") {
      verbose = true;
    }
  }

  if (!db) {
    throw new Error(
      "verify-chain: --db <path> is required (or --db :memory: for a fresh check)",
    );
  }
  // Fall back to env so on-host operators do not put the signing key into
  // shell history. Empty string is rejected as "missing".
  const resolvedKey = key ?? process.env.TENSOL_AUDIT_SIGNING_KEY ?? "";
  if (!resolvedKey) {
    throw new Error(
      "verify-chain: --key <hex> required (or set TENSOL_AUDIT_SIGNING_KEY)",
    );
  }

  return { db, key: resolvedKey, verbose };
}

/** When the CLI is pointed at `:memory:` (or any DB without `audit_log`),
 *  apply migrations so the SELECT does not blow up with "no such table".
 *  Migrations are idempotent at the table-create level (CREATE TABLE IF NOT
 *  EXISTS) only if generated with that flag — drizzle-kit does NOT do that
 *  by default, so we only auto-apply when we KNOW the table is missing.
 *
 *  Decision: apply only when the table does NOT exist. This keeps the CLI
 *  safe to run against a populated production DB (no accidental schema
 *  drift) AND on fresh `:memory:` DBs (acceptance criterion from tasks.md
 *  line 38: `bun run src/audit/verify-chain.ts --db :memory:` must exit 0). */
function ensureAuditTable(db: DB): void {
  const raw = db.$client as Database;
  const row = raw
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'")
    .get();
  if (row) return;

  const migrationsDir = join(import.meta.dir, "..", "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sqlText = readFileSync(join(migrationsDir, f), "utf8").replace(
      /-->\s*statement-breakpoint/g,
      "",
    );
    raw.exec(sqlText);
  }
}

/** Bun's `import.meta.main` is true when this file is invoked directly. */
if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const db = createDb(args.db);
  try {
    ensureAuditTable(db);
    const res = verifyChain(db, args.key);
    if (res.ok) {
      // stdout-only success line — keep stable for ops/cron parsers.
      process.stdout.write(`chain ok: ${res.rows} rows\n`);
      process.exit(0);
    } else {
      process.stdout.write(`chain broken at row ${res.brokenAt}\n`);
      if (args.verbose) {
        process.stdout.write(`  expected: ${res.expected}\n`);
        process.stdout.write(`  actual:   ${res.actual}\n`);
      }
      process.exit(1);
    }
  } finally {
    (db.$client as Database).close();
  }
}
