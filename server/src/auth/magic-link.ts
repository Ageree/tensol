/**
 * T002/T054/T055 — Telegram deep-link auth (pivot 2026-05-19).
 *
 * Replaces the previous email + magic-link implementation. The auth flow now
 * runs through Telegram's `@tensol_leadsbot`:
 *
 *   1. `issueLink({ telegramUsername })` — frontend posts the user's Telegram
 *      handle. We persist a `pending_signups` row keyed by a 26-char ULID
 *      token and return a deep-link of the form
 *      `https://t.me/<bot>?start=<token>`.
 *
 *   2. Operator's bot receives `/start <token>` from Telegram via the
 *      webhook handler (`routes/webhooks-telegram.ts`). That handler calls
 *      `consumeLink({ token, telegramUserId, telegramUsername })` here:
 *      we find or create the `users` row, INSERT a `sessions` row, mark the
 *      `pending_signups` row as `resolved`, and emit an audit row.
 *
 *   3. While the user is in Telegram completing step 2, the frontend polls
 *      `pollLink({ token })` every couple of seconds. On `resolved`, the
 *      response includes the session id so the browser can set the cookie
 *      and redirect to `/dashboard`.
 *
 * Public types (`IssueLinkResult`, `ConsumeLinkResult`, `PollLinkResult`)
 * are the contract consumed by `routes/auth.ts` + `routes/webhooks-
 * telegram.ts`. Keep the result shapes stable across future schema tweaks.
 *
 * Constitution invariants honoured here:
 *   - VI (Red→Green): tests in `auth/magic-link.test.ts` exercise every
 *     branch — happy issue, happy consume, expired-token consume, replay,
 *     and pollLink statuses.
 *   - VII (≤800 LOC): this file is ~300 LOC.
 *   - IX (Zod at boundary): `TelegramUsernameSchema` validates the only
 *     external input we accept here; the webhook handler validates the
 *     Telegram Update envelope itself.
 *   - X (audit emit AFTER commit): `auth_login_succeeded` is emitted after
 *     the session row is INSERTed and the pending_signups row is flipped
 *     to `resolved` inside one transaction.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  pendingSignups as pendingSignupsTable,
  sessions as sessionsTable,
  users as usersTable,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic-token TTL: 15 minutes per pivot doc §"Auth flow". */
export const PENDING_SIGNUP_TTL_MS = 15 * 60 * 1_000;

/** Session lifetime: 30 days. Matches the old DEFAULT_SESSION_TTL_MS so the
 *  cookie helper's max-age stays in lock-step. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** Default bot username for the deep-link prefix. Overridable via DI. */
export const DEFAULT_BOT_USERNAME = "tensol_leadsbot";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IssueLinkArgs {
  readonly telegramUsername: string;
}

export interface IssueLinkResult {
  readonly token: string;
  readonly deepLink: string;
  readonly expiresAt: number;
  readonly telegramUsername: string;
}

export interface ConsumeLinkArgs {
  readonly token: string;
  readonly telegramUserId: number;
  readonly telegramUsername?: string | undefined;
}

export interface ConsumeLinkOk {
  readonly ok: true;
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionExpiresAt: number;
  readonly telegramUsername: string;
}

export interface ConsumeLinkErr {
  readonly ok: false;
  readonly reason: "expired" | "used" | "invalid" | "username_mismatch";
}

export type ConsumeLinkResult = ConsumeLinkOk | ConsumeLinkErr;

export interface PollLinkArgs {
  readonly token: string;
}

export type PollLinkResult =
  | { readonly status: "pending"; readonly expiresAt: number }
  | { readonly status: "resolved"; readonly sessionId: string }
  | { readonly status: "expired" }
  | { readonly status: "invalid" };

// ---------------------------------------------------------------------------
// Shared deps shape — every entry-point takes the same `deps` object so the
// caller can wire DB + clock + ULID factory + signing key in one place.
// ---------------------------------------------------------------------------

export interface MagicLinkDeps {
  readonly db: DB;
  readonly signingKey: string;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly botUsername?: string;
}

// ---------------------------------------------------------------------------
// Zod — telegram username validator
// ---------------------------------------------------------------------------

/**
 * Telegram usernames per https://core.telegram.org/method/account.checkUsername:
 *   - 5–32 chars
 *   - alphanumeric + underscore
 *   - optionally prefixed with `@`
 *
 * We strip a leading `@`, lower-case, and re-validate the inner shape so the
 * stored form is canonical (case-insensitive match with `users.telegram_username`).
 */
export const TelegramUsernameSchema = z
  .string({ required_error: "telegram_username required" })
  .trim()
  .transform((s) => (s.startsWith("@") ? s.slice(1) : s))
  .pipe(
    z
      .string()
      .min(5, { message: "telegram_username must be ≥5 chars" })
      .max(32, { message: "telegram_username must be ≤32 chars" })
      .regex(/^[a-zA-Z0-9_]+$/, {
        message: "telegram_username may only contain a-z, 0-9 and _",
      })
      .transform((s) => s.toLowerCase()),
  );

// ---------------------------------------------------------------------------
// issueLink
// ---------------------------------------------------------------------------

/**
 * Persist a pending_signups row and return the deep-link + expiry. Idempotent
 * per call (each invocation mints a fresh token); the route layer is the only
 * place that should enforce per-IP rate-limiting.
 *
 * Throws `z.ZodError` on malformed username. The caller (route handler) maps
 * Zod failures to HTTP 400.
 */
export async function issueLink(
  args: IssueLinkArgs,
  deps: MagicLinkDeps,
): Promise<IssueLinkResult> {
  const username = TelegramUsernameSchema.parse(args.telegramUsername);
  const clock = deps.now ?? defaultNow;
  const newId = deps.newId ?? (() => ulid(clock()));
  const botUsername = deps.botUsername ?? DEFAULT_BOT_USERNAME;

  const nowMs = clock();
  const expiresAt = nowMs + PENDING_SIGNUP_TTL_MS;
  const token = newId();

  deps.db
    .insert(pendingSignupsTable)
    .values({
      id: newId(),
      token,
      telegramUsername: username,
      chatId: null,
      status: "pending",
      createdAt: nowMs,
      expiresAt,
    })
    .run();

  await emitSignedAudit(
    deps.db,
    {
      event: "auth_login_requested",
      outcome: "success",
      ts: nowMs,
      metadata: { telegram_username: username, token_id: token },
    },
    { key: deps.signingKey },
  );

  return {
    token,
    deepLink: `https://t.me/${botUsername}?start=${token}`,
    expiresAt,
    telegramUsername: username,
  };
}

// ---------------------------------------------------------------------------
// consumeLink — invoked by the telegram-webhook handler after `/start <token>`
// ---------------------------------------------------------------------------

/**
 * Resolve a pending_signups token against the Telegram identity reported by
 * the bot webhook. Returns the user_id + session_id on success.
 *
 * Returned `ConsumeLinkErr.reason` values:
 *   - `invalid`            — token never existed.
 *   - `expired`            — token TTL elapsed (now ≥ expires_at).
 *   - `used`               — token already resolved (replay attempt).
 *   - `username_mismatch`  — Telegram-reported username doesn't match the
 *     handle the user typed on the signup form. (We compare case-insensitively
 *     and tolerate an absent Telegram username — Telegram allows accounts with
 *     no public handle; we then trust the numeric user_id.)
 */
export async function consumeLink(
  args: ConsumeLinkArgs,
  deps: MagicLinkDeps,
): Promise<ConsumeLinkResult> {
  const clock = deps.now ?? defaultNow;
  const newId = deps.newId ?? (() => ulid(clock()));
  const nowMs = clock();

  const pending = deps.db
    .select()
    .from(pendingSignupsTable)
    .where(eq(pendingSignupsTable.token, args.token))
    .get();

  if (!pending) {
    return { ok: false, reason: "invalid" };
  }
  if (pending.status === "resolved") {
    return { ok: false, reason: "used" };
  }
  if (pending.status === "expired" || nowMs >= pending.expiresAt) {
    // Flip the row to `expired` opportunistically so subsequent polls see
    // the same terminal state. We don't await an audit here — the failure
    // path is observable via the missing `auth_login_succeeded` and the
    // `pollLink → expired` response.
    deps.db
      .update(pendingSignupsTable)
      .set({ status: "expired" })
      .where(eq(pendingSignupsTable.token, args.token))
      .run();
    return { ok: false, reason: "expired" };
  }

  // Username sanity: when Telegram reports a username, it MUST match the one
  // the user typed on the form. Numeric user_id is the unforgeable anchor;
  // the username check defends against an attacker tricking another logged-in
  // Telegram user into clicking the same deep-link.
  const reportedUsername = args.telegramUsername?.trim().toLowerCase();
  if (
    reportedUsername !== undefined &&
    reportedUsername !== "" &&
    reportedUsername !== pending.telegramUsername
  ) {
    return { ok: false, reason: "username_mismatch" };
  }

  // Find-or-create user. We try by `telegram_user_id` first (the unforgeable
  // identifier); if not found we fall back to the username row (covers the
  // edge case where the user previously signed in before changing handle).
  let user = deps.db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramUserId, args.telegramUserId))
    .get();
  if (!user) {
    user = deps.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.telegramUsername, pending.telegramUsername))
      .get();
  }

  const sessionId = newId();
  const sessionExpiresAt = nowMs + SESSION_TTL_MS;
  // Migration 0010 left `users.email` as NOT NULL, so we synthesize a
  // placeholder when minting a new user. The service layer treats anything
  // ending in `@telegram.local` as semantically absent (matches the pivot
  // doc §"users table additions" rationale).
  const placeholderEmail = `${pending.telegramUsername}@telegram.local`;

  await withTx(deps.db, async (tx) => {
    if (!user) {
      const newUserId = newId();
      tx.insert(usersTable)
        .values({
          id: newUserId,
          email: placeholderEmail,
          createdAt: nowMs,
          freeQuickConsumedCount: 0,
          telegramUserId: args.telegramUserId,
          telegramUsername: pending.telegramUsername,
        })
        .run();
      user = {
        id: newUserId,
        email: placeholderEmail,
        createdAt: nowMs,
        freeQuickConsumedAt: null,
        freeQuickConsumedCount: 0,
        telegramUserId: args.telegramUserId,
        telegramUsername: pending.telegramUsername,
      };
    } else if (
      user.telegramUserId !== args.telegramUserId ||
      user.telegramUsername !== pending.telegramUsername
    ) {
      // Backfill the telegram columns if the user predates the pivot (e.g.
      // was created via the legacy email path) or changed handle.
      tx.update(usersTable)
        .set({
          telegramUserId: args.telegramUserId,
          telegramUsername: pending.telegramUsername,
        })
        .where(eq(usersTable.id, user.id))
        .run();
    }

    tx.insert(sessionsTable)
      .values({
        id: sessionId,
        userId: user.id,
        createdAt: nowMs,
        expiresAt: sessionExpiresAt,
      })
      .run();

    tx.update(pendingSignupsTable)
      .set({
        status: "resolved",
        chatId: args.telegramUserId,
      })
      .where(
        and(
          eq(pendingSignupsTable.token, args.token),
          eq(pendingSignupsTable.status, "pending"),
        ),
      )
      .run();
  });

  // Audit AFTER commit (Constitution X). `user` is guaranteed non-null here
  // because the tx body assigns it before returning.
  await emitSignedAudit(
    deps.db,
    {
      event: "auth_login_succeeded",
      outcome: "success",
      ts: nowMs,
      user_id: user!.id,
      metadata: {
        session_id: sessionId,
        telegram_user_id: args.telegramUserId,
        telegram_username: pending.telegramUsername,
      },
    },
    { key: deps.signingKey },
  );

  return {
    ok: true,
    userId: user!.id,
    sessionId,
    sessionExpiresAt,
    telegramUsername: pending.telegramUsername,
  };
}

// ---------------------------------------------------------------------------
// pollLink — frontend long-poll target
// ---------------------------------------------------------------------------

/**
 * Read-only lookup: tells the browser whether the deep-link has been
 * consumed yet. We never reveal the `chat_id` or numeric Telegram user id;
 * only the session id once the row is resolved.
 *
 * For `resolved`, we materialise the session id by querying the most recent
 * session belonging to the user inferred from `pending.chat_id` (set by
 * `consumeLink`). When pending_signups is `resolved` AND chat_id is set,
 * there is exactly one corresponding session — the one we just minted.
 */
export async function pollLink(
  args: PollLinkArgs,
  deps: MagicLinkDeps,
): Promise<PollLinkResult> {
  const clock = deps.now ?? defaultNow;
  const nowMs = clock();

  const pending = deps.db
    .select()
    .from(pendingSignupsTable)
    .where(eq(pendingSignupsTable.token, args.token))
    .get();

  if (!pending) {
    return { status: "invalid" };
  }

  if (pending.status === "resolved") {
    // Resolve the session via telegram_user_id -> users.id -> sessions row.
    // `chat_id` is populated to the Telegram user_id by `consumeLink`.
    if (pending.chatId === null) {
      // Shouldn't happen — consumeLink always sets chat_id when flipping the
      // row to resolved. Treat as invalid so the frontend retries on next
      // poll rather than getting stuck.
      return { status: "invalid" };
    }
    const user = deps.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.telegramUserId, pending.chatId))
      .get();
    if (!user) {
      return { status: "invalid" };
    }
    const session = deps.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.userId, user.id))
      .orderBy(sessionsTable.createdAt)
      .all();
    // Pick the most recently-created session (we mint a fresh one on every
    // `/start <token>`; ordering ascending then taking the last keeps the
    // codepath dialect-portable across SQLite versions that don't support
    // `desc()` ergonomically).
    const latest = session.length > 0 ? session[session.length - 1] : null;
    if (!latest || nowMs >= latest.expiresAt) {
      return { status: "invalid" };
    }
    return { status: "resolved", sessionId: latest.id };
  }

  if (pending.status === "expired" || nowMs >= pending.expiresAt) {
    return { status: "expired" };
  }

  return { status: "pending", expiresAt: pending.expiresAt };
}
