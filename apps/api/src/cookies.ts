// Sprint 3 contract C19 / C20 — session cookie helpers.
//
// Cookie name per env:
//   non-local (dev|staging|production|internal-lab): `__Host-cs_session`
//     - HttpOnly; Secure; SameSite=Lax; Path=/
//     - The `__Host-` prefix is browser-enforced: Domain attribute forbidden,
//       Path must be `/`, Secure required.
//   local: `cs_session`
//     - HttpOnly; SameSite=Lax; Path=/  (Secure dropped to allow http://localhost)
//
// C20 — the cookie value is opaque random 32-byte hex; the BCRYPT HASH of that
// value is what gets stored in `user_sessions.token_hash`. `mintCookieToken()`
// returns the plaintext for the client and the hash for the DB write.

import { randomBytes } from 'node:crypto';

export interface MintedSessionToken {
  /** Plaintext token written to the Set-Cookie header (NEVER stored). */
  readonly plaintext: string;
}

export const mintSessionTokenPlaintext = (): MintedSessionToken => {
  const buf = randomBytes(32);
  return { plaintext: buf.toString('hex') };
};

export interface CookieAttributes {
  readonly name: string;
  readonly secure: boolean;
}

export const buildSetCookieHeader = (
  attrs: CookieAttributes,
  value: string,
  expiresAt: Date,
): string => {
  const parts: string[] = [
    `${attrs.name}=${value}`,
    'Path=/',
    `Expires=${expiresAt.toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (attrs.secure) parts.push('Secure');
  return parts.join('; ');
};

export const buildClearCookieHeader = (attrs: CookieAttributes): string => {
  const epoch = new Date(0).toUTCString();
  const parts: string[] = [
    `${attrs.name}=`,
    'Path=/',
    `Expires=${epoch}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (attrs.secure) parts.push('Secure');
  return parts.join('; ');
};

/** Parse the cookie value out of a Cookie header (returns null on miss). */
export const readSessionCookie = (
  cookieHeader: string | null | undefined,
  name: string,
): string | null => {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map((p) => p.trim());
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const k = p.slice(0, eq);
    if (k === name) return p.slice(eq + 1);
  }
  return null;
};
