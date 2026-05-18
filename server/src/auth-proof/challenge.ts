/**
 * T032 — Auth-proof challenge issuer.
 *
 * `issueChallenge(db, args, opts)` is the only public entry point. It:
 *   1. Generates a 32-byte cryptographically random token, hex-encoded
 *      (64 lower-case chars) — per spec line 99 of data-model.md
 *      "`tensol-verify=<32-byte-hex>`". 32 bytes ⇒ 64 hex chars.
 *   2. Computes `expires_at = now + ttlMs` (default 24h, FR-013).
 *   3. INSERTs an `auth_proofs` row in `pending` state (status="pending",
 *      method=null, verified_at=null).
 *   4. After the tx commits, emits a chained `auth_proof_issued` audit row
 *      via `emitSignedAudit`. The emit runs AFTER the tx because
 *      `emitSignedAudit` opens its own `BEGIN IMMEDIATE` and bun:sqlite
 *      cannot nest BEGINs (pattern documented in targets/service.ts T029).
 *   5. Returns instructions for the three verification methods (DNS TXT,
 *      `.well-known` file, HTML meta tag) — verifier T033 will probe one of
 *      these and mark the row verified.
 *
 * Re-issuance semantics (data-model.md line 108):
 *   "Multiple rows may exist for the same target if user retries; only the
 *    most recent matters." → we do NOT invalidate previous rows here. The
 *    verifier (T033) and target-status query are responsible for picking
 *    the most recent unexpired challenge.
 *
 * Hostname argument:
 *   The caller (routes layer, T035) parses `targets.url` into a hostname
 *   and passes it in explicitly. This module does NOT re-parse the URL —
 *   keeps the service single-responsibility and easy to test without URL
 *   fixtures.
 *
 * Signing key:
 *   Mandatory. Mirrors `audit/emit.ts` — never silently falls back to
 *   `getConfig()`. Production callers thread
 *   `config.TENSOL_AUDIT_SIGNING_KEY` explicitly; tests pass a fixture key.
 */
import { randomBytes } from "node:crypto";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import { authProofs } from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";

/** 24 hours in ms — default challenge TTL (FR-013). */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Number of random bytes in the challenge token. 32 bytes ⇒ 64 hex chars.
 *  Matches the spec phrase "32-byte-hex" in data-model.md line 99. */
const TOKEN_BYTES = 32;

/** DNS subdomain prefix for the TXT record (e.g. `_tensol-verify.foo.com`). */
const DNS_TXT_PREFIX = "_tensol-verify.";

/** Well-known HTTP path the verifier fetches for the file method. */
const WELL_KNOWN_PATH = "/.well-known/tensol-verify.txt";

/** HTML meta-tag name the verifier looks for in the root page. */
const META_TAG_NAME = "tensol-verify";

/** DNS TXT value prefix; the full value is `tensol-verify=<hex>`. */
const TOKEN_VALUE_PREFIX = "tensol-verify=";

export interface IssueChallengeArgs {
  readonly targetId: string;
  readonly hostname: string;
}

export interface IssueChallengeOptions {
  readonly signingKey: string;
  /** Override clock for deterministic tests. */
  readonly now?: () => number;
  /** Override TTL (defaults to 24h). */
  readonly ttlMs?: number;
}

export interface ChallengeInstructions {
  readonly challenge_id: string;
  /** Full `tensol-verify=<hex>` payload used for the DNS TXT value. */
  readonly token: string;
  /** Raw 64-char hex token (used in well-known file + meta tag content). */
  readonly raw_token: string;
  readonly expires_at: number;
  readonly methods: {
    readonly dns_txt: {
      readonly record_name: string;
      readonly record_value: string;
    };
    readonly well_known_file: {
      readonly path: string;
      readonly content: string;
    };
    readonly meta_tag: {
      readonly name: string;
      readonly content: string;
      readonly html_snippet: string;
    };
  };
}

/**
 * Issue a fresh ownership challenge for `targetId`.
 *
 * Pre-conditions (enforced upstream):
 *   - `targetId` exists in `targets` and is owned by the calling user.
 *   - `hostname` is the lowercased host of `targets.url`.
 *
 * Post-conditions:
 *   - One new `auth_proofs` row in `pending` state.
 *   - One new chained `auth_proof_issued` row in `audit_log`.
 *
 * Throws if `signingKey` is empty (mirrors emitSignedAudit).
 */
export async function issueChallenge(
  db: DB,
  args: IssueChallengeArgs,
  opts: IssueChallengeOptions,
): Promise<ChallengeInstructions> {
  if (!opts.signingKey) {
    throw new Error(
      "issueChallenge: signingKey is required (audit row cannot be signed)",
    );
  }

  const clock = opts.now ?? defaultNow;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const createdAt = clock();
  const expiresAt = createdAt + ttlMs;
  const challengeId = ulid(createdAt);
  const rawToken = randomBytes(TOKEN_BYTES).toString("hex");
  const challengeStr = `${TOKEN_VALUE_PREFIX}${rawToken}`;

  await withTx(db, async (tx) => {
    tx.insert(authProofs)
      .values({
        id: challengeId,
        targetId: args.targetId,
        challenge: challengeStr,
        method: null,
        status: "pending",
        createdAt,
        verifiedAt: null,
        expiresAt,
      })
      .run();
  });

  // Audit AFTER the DB tx commits — emitSignedAudit opens its own
  // BEGIN IMMEDIATE; bun:sqlite cannot nest BEGINs. Trade-off:
  // best-effort tamper-evident audit (per Constitution V, T029 pattern).
  await emitSignedAudit(
    db,
    {
      event: "auth_proof_issued",
      outcome: "success",
      ts: createdAt,
      target_id: args.targetId,
      auth_proof_id: challengeId,
      metadata: { hostname: args.hostname },
    },
    { key: opts.signingKey },
  );

  return {
    challenge_id: challengeId,
    token: challengeStr,
    raw_token: rawToken,
    expires_at: expiresAt,
    methods: {
      dns_txt: {
        record_name: `${DNS_TXT_PREFIX}${args.hostname}`,
        record_value: challengeStr,
      },
      well_known_file: {
        path: WELL_KNOWN_PATH,
        content: rawToken,
      },
      meta_tag: {
        name: META_TAG_NAME,
        content: rawToken,
        html_snippet: `<meta name="${META_TAG_NAME}" content="${rawToken}">`,
      },
    },
  };
}
