/**
 * T021 — Magic-link issuance + atomic redemption.
 *
 * Two public entry points:
 *   - `issueLink(db, email, opts)` validates `email` with Zod, generates a
 *     256-bit base64url token, stores its HMAC-SHA256 in
 *     `magic_link_tokens.token`, and returns the RAW token + `expires_at`.
 *     The raw token is observable to the caller exactly once — typically
 *     for embedding in the outgoing magic-link email URL.
 *
 *   - `verifyLink(db, token, opts)` performs atomic redemption inside a
 *     single `BEGIN IMMEDIATE` transaction:
 *
 *       SELECT row by token_hash → check unused → check fresh
 *         → UPDATE used_at      → find-or-create user → INSERT session
 *         → emit audit          → COMMIT
 *
 *     Concurrency: two parallel verifies on the same token serialise via
 *     `withTx` (T011). The loser's SELECT sees `used_at != NULL` and
 *     returns `{ ok:false, reason:"used", code:410 }`.
 *
 * Why we hash the token (HMAC, not raw): the DB column is the keying
 * material for redemption — if a DB snapshot leaks, raw tokens stored
 * verbatim would be immediately exploitable. By HMACing with
 * `opts.signingKey` (server-only secret) the row is only useful in
 * combination with the signing key. Matches the same threat model the
 * audit chain uses.
 *
 * The HMAC also doubles as a constant-time lookup key: SQLite's PRIMARY
 * KEY btree gives O(log N) probe by hash, and timing is independent of
 * the user-supplied raw token's content (since we hash first, then probe).
 *
 * Audit events:
 *   - `auth_login_requested` on every issue (outcome=success).
 *   - `auth_login_succeeded` on every verify happy path.
 *   - `auth_login_failed` on used / expired verifies, with metadata.reason.
 *   Invalid (unknown) tokens are NOT audited to avoid log-flooding by
 *   probing attackers; the 404 response is sufficient.
 *
 * Both API surfaces accept `opts.signingKey` explicitly — Constitution VII
 * (deterministic boot, no hidden env reads) forbids reaching into a
 * module-level config singleton from business logic.
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  magicLinkTokens,
  sessions as sessionsTable,
  users as usersTable,
} from "../db/schema.ts";
import { hmacSha256, randomToken } from "../lib/crypto.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";

const DEFAULT_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email());

export interface IssueLinkOpts {
  readonly signingKey: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export interface IssueLinkResult {
  readonly token: string;
  readonly expires_at: number;
}

export interface VerifyLinkOpts {
  readonly signingKey: string;
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
}

export interface VerifyLinkOk {
  readonly ok: true;
  readonly user: { readonly id: string; readonly email: string };
  readonly session: { readonly id: string; readonly expires_at: number };
}

export interface VerifyLinkErr {
  readonly ok: false;
  readonly reason: "expired" | "used" | "invalid";
  readonly code: 410 | 404;
}

export type VerifyLinkResult = VerifyLinkOk | VerifyLinkErr;

/**
 * Issue a fresh magic-link token for `email`.
 *
 * Side effects:
 *   - INSERT into `magic_link_tokens` (token column = HMAC of raw token).
 *   - Emits `auth_login_requested` audit row (outcome=success).
 *
 * @throws z.ZodError if `email` is malformed.
 */
export async function issueLink(
  db: DB,
  email: string,
  opts: IssueLinkOpts,
): Promise<IssueLinkResult> {
  const normalisedEmail = emailSchema.parse(email);
  const clock = opts.now ?? defaultNow;
  const ttl = opts.ttlMs ?? DEFAULT_LINK_TTL_MS;

  const rawToken = randomToken(32);
  const tokenHash = hmacSha256(opts.signingKey, rawToken);
  const issuedAt = clock();
  const expiresAt = issuedAt + ttl;

  await withTx(db, async (tx) => {
    tx.insert(magicLinkTokens)
      .values({
        token: tokenHash,
        email: normalisedEmail,
        expiresAt,
        usedAt: null,
      })
      .run();
  });

  // Emit audit AFTER the insert tx commits — audit emit runs its own
  // BEGIN IMMEDIATE, and nesting BEGIN inside BEGIN would error.
  await emitSignedAudit(
    db,
    {
      event: "auth_login_requested",
      outcome: "success",
      ts: issuedAt,
      metadata: { email: normalisedEmail },
    },
    { key: opts.signingKey },
  );

  return { token: rawToken, expires_at: expiresAt };
}

/**
 * Atomically redeem a magic-link token.
 *
 * On success creates (or re-uses) a user row and creates a new session.
 * On failure returns a typed `VerifyLinkErr` — callers translate `code`
 * into the HTTP response status.
 *
 * The entire flow runs inside a single `withTx` so the
 * SELECT-then-UPDATE-then-INSERT cannot race with a parallel verifier of
 * the same token.
 */
export async function verifyLink(
  db: DB,
  token: string,
  opts: VerifyLinkOpts,
): Promise<VerifyLinkResult> {
  const clock = opts.now ?? defaultNow;
  const sessionTtl = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const tokenHash = hmacSha256(opts.signingKey, token);

  // The redemption side-effect set we want from the transaction.
  type TxOutcome =
    | { kind: "ok"; userId: string; email: string; sessionId: string; sessionExpiresAt: number }
    | { kind: "invalid" }
    | { kind: "used" }
    | { kind: "expired" };

  const outcome = await withTx<TxOutcome>(db, async (tx) => {
    const row = tx
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.token, tokenHash))
      .get();
    if (!row) return { kind: "invalid" };

    if (row.usedAt !== null) return { kind: "used" };

    const ts = clock();
    if (ts > row.expiresAt) return { kind: "expired" };

    // Atomic burn: condition the UPDATE on `used_at IS NULL` so a
    // hypothetical concurrent transaction that somehow squeezed past
    // BEGIN IMMEDIATE (it cannot, but belt-and-braces) still sees a
    // no-op rowcount.
    tx.update(magicLinkTokens)
      .set({ usedAt: ts })
      .where(
        and(eq(magicLinkTokens.token, tokenHash), isNull(magicLinkTokens.usedAt)),
      )
      .run();

    // Find-or-create user. Email is normalised at issue time so we can
    // compare verbatim here.
    let userRow = tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, row.email))
      .get();
    if (!userRow) {
      const userId = ulid(ts);
      tx.insert(usersTable)
        .values({ id: userId, email: row.email, createdAt: ts })
        .run();
      userRow = { id: userId, email: row.email, createdAt: ts };
    }

    // Create a fresh session.
    const sessionId = ulid(ts);
    const sessionExpiresAt = ts + sessionTtl;
    tx.insert(sessionsTable)
      .values({
        id: sessionId,
        userId: userRow.id,
        createdAt: ts,
        expiresAt: sessionExpiresAt,
      })
      .run();

    return {
      kind: "ok",
      userId: userRow.id,
      email: userRow.email,
      sessionId,
      sessionExpiresAt,
    };
  });

  // Emit audit AFTER the redemption tx commits (see issueLink rationale).
  if (outcome.kind === "ok") {
    await emitSignedAudit(
      db,
      {
        event: "auth_login_succeeded",
        outcome: "success",
        user_id: outcome.userId,
        metadata: {
          session_id: outcome.sessionId,
          user_id: outcome.userId,
        },
      },
      { key: opts.signingKey },
    );
    return {
      ok: true,
      user: { id: outcome.userId, email: outcome.email },
      session: { id: outcome.sessionId, expires_at: outcome.sessionExpiresAt },
    };
  }

  if (outcome.kind === "invalid") {
    // Intentionally NO audit — invalid tokens are probe noise.
    return { ok: false, reason: "invalid", code: 404 };
  }

  // used / expired both emit auth_login_failed with reason metadata.
  await emitSignedAudit(
    db,
    {
      event: "auth_login_failed",
      outcome: "failure",
      metadata: { reason: outcome.kind },
    },
    { key: opts.signingKey },
  );
  return { ok: false, reason: outcome.kind, code: 410 };
}
