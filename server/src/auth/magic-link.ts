/**
 * T021 — Magic-link issuance + atomic redemption.
 *
 * STATUS (002-blackbox-mvp, 2026-05-20): STUBBED.
 *
 * The `magic_link_tokens` table was dropped in T012 as part of the auth
 * pivot to Telegram-based login. The full implementation will return once
 * the new auth path lands. Until then this module preserves the public
 * type contract (`issueLink` / `verifyLink` + their result types) so that
 * `routes/auth.ts` continues to compile and the rest of the server can
 * boot — but any actual invocation throws `not_implemented`.
 *
 * Why stub rather than delete:
 *   - `routes/auth.ts` is still mounted in `server.ts` and consumed by
 *     integration tests via factory injection. Deleting the module would
 *     require simultaneous edits to the route, the tests, and the test
 *     harness — out of scope for this hot-fix.
 *   - The smoke path uses `/__test/v2/seed-session` to seed sessions
 *     directly (no magic-link involvement), so the stub does not affect
 *     the boot-and-probe smoke run.
 *
 * When the Telegram-auth replacement lands, swap these stubs for the new
 * implementation. The result types (`IssueLinkResult`, `VerifyLinkResult`,
 * `VerifyLinkOk`, `VerifyLinkErr`) are public contract — keep them stable.
 */
import { z } from "zod";
import type { DB } from "../db/client.ts";

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
 * STUB — see file-level header. Throws `not_implemented`.
 *
 * Email validation is still performed up-front so callers see the same
 * `z.ZodError` they would see in the real implementation when the input
 * is malformed; this preserves the only documented exception path.
 */
export async function issueLink(
  _db: DB,
  email: string,
  _opts: IssueLinkOpts,
): Promise<IssueLinkResult> {
  // Preserve original Zod-error semantics for malformed input.
  emailSchema.parse(email);
  throw new Error(
    "magic-link.issueLink: not_implemented — magic-link auth is being " +
      "replaced by Telegram-based login (002-blackbox-mvp pivot, T012)",
  );
}

/**
 * STUB — see file-level header. Throws `not_implemented`.
 */
export async function verifyLink(
  _db: DB,
  _token: string,
  _opts: VerifyLinkOpts,
): Promise<VerifyLinkResult> {
  throw new Error(
    "magic-link.verifyLink: not_implemented — magic-link auth is being " +
      "replaced by Telegram-based login (002-blackbox-mvp pivot, T012)",
  );
}
