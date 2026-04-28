import { describe, expect, test } from 'bun:test';
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  mintSessionTokenPlaintext,
  readSessionCookie,
} from './cookies.ts';

describe('apps/api :: cookies — Set-Cookie shape (C19/C20)', () => {
  test('non-local: includes Secure + HttpOnly + SameSite=Lax + Path=/', () => {
    const header = buildSetCookieHeader(
      { name: '__Host-cs_session', secure: true },
      'abc',
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(header).toContain('__Host-cs_session=abc');
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    expect(header).toContain('Expires=');
  });

  test('local: drops Secure, drops __Host- prefix from caller-provided name', () => {
    const header = buildSetCookieHeader(
      { name: 'cs_session', secure: false },
      'xyz',
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(header).toContain('cs_session=xyz');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Secure');
  });

  test('clear cookie sets Max-Age=0 and Expires=epoch', () => {
    const header = buildClearCookieHeader({ name: '__Host-cs_session', secure: true });
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });
});

describe('apps/api :: cookies — readSessionCookie', () => {
  test('returns the value when the cookie is present', () => {
    expect(readSessionCookie('cs_session=token123; foo=bar', 'cs_session')).toBe('token123');
  });

  test('returns null on miss', () => {
    expect(readSessionCookie('foo=bar', 'cs_session')).toBeNull();
    expect(readSessionCookie(null, 'cs_session')).toBeNull();
    expect(readSessionCookie(undefined, 'cs_session')).toBeNull();
    expect(readSessionCookie('', 'cs_session')).toBeNull();
  });

  test('finds the right cookie when multiple are present', () => {
    expect(readSessionCookie('a=1; __Host-cs_session=tk; other=2', '__Host-cs_session')).toBe('tk');
  });
});

describe('apps/api :: cookies — mintSessionTokenPlaintext (C20)', () => {
  test('returns a 64-character hex string (32 random bytes)', () => {
    const t = mintSessionTokenPlaintext();
    expect(t.plaintext).toMatch(/^[0-9a-f]{64}$/);
  });

  test('produces distinct tokens', () => {
    const a = mintSessionTokenPlaintext();
    const b = mintSessionTokenPlaintext();
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});
