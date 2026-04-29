import { describe, expect, test } from 'bun:test';
import { UrlNormalizationError, normalizeUrl } from './url.ts';

describe('scope-engine :: normalize/url', () => {
  test('lowercases scheme + host', () => {
    const r = normalizeUrl('HTTPS://Example.COM/PATH');
    expect(r.scheme).toBe('https');
    expect(r.host).toBe('example.com');
    expect(r.canonical.startsWith('https://example.com')).toBe(true);
  });

  test('elides default port 443 for https', () => {
    expect(normalizeUrl('https://example.com:443/').canonical).toBe('https://example.com/');
  });

  test('elides default port 80 for http', () => {
    expect(normalizeUrl('http://example.com:80/').canonical).toBe('http://example.com/');
  });

  test('preserves non-default port', () => {
    expect(normalizeUrl('https://example.com:8443/').canonical).toBe('https://example.com:8443/');
  });

  test('IDN→punycode in canonical', () => {
    const r = normalizeUrl('https://президент.рф/');
    expect(r.host).toBe('xn--d1abbgf6aiiy.xn--p1ai');
    expect(r.canonical.startsWith('https://xn--d1abbgf6aiiy.xn--p1ai')).toBe(true);
  });

  test('mixed-script flag surfaces homograph', () => {
    const cyrillicO = 'о';
    const r = normalizeUrl(`https://g${cyrillicO}${cyrillicO}gle.com/`);
    expect(r.hostHasMixedScript).toBe(true);
  });

  test('strips trailing dot from host', () => {
    expect(normalizeUrl('https://example.com./').host).toBe('example.com');
  });

  test('collapses /./ and /../ segments', () => {
    expect(normalizeUrl('https://example.com/a/./b').path).toBe('/a/b');
    expect(normalizeUrl('https://example.com/a/../b').path).toBe('/b');
    expect(normalizeUrl('https://example.com/a/../../b').path).toBe('/b');
    expect(normalizeUrl('https://example.com/a/b/c/../../../').path).toBe('/');
  });

  test('strips fragment', () => {
    expect(normalizeUrl('https://example.com/p?q=1#frag').canonical).toBe(
      'https://example.com/p?q=1',
    );
  });

  test('preserves query as-is (order-sensitive apps)', () => {
    expect(normalizeUrl('https://example.com/?b=2&a=1').canonical).toBe(
      'https://example.com/?b=2&a=1',
    );
  });

  test('idempotent', () => {
    const a = normalizeUrl('HTTPS://Example.COM:443/a/./b?x=1#frag');
    const b = normalizeUrl(a.canonical);
    expect(a.canonical).toBe(b.canonical);
  });

  test('rejects empty', () => {
    expect(() => normalizeUrl('')).toThrow(UrlNormalizationError);
  });

  test('rejects garbage', () => {
    expect(() => normalizeUrl('not-a-url')).toThrow(UrlNormalizationError);
  });

  test('rejects non-string', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
    expect(() => normalizeUrl(null as any)).toThrow(UrlNormalizationError);
  });

  test('http://169.254.169.254/ canonicalizes intact (engine layer applies the metadata block)', () => {
    const r = normalizeUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.host).toBe('169.254.169.254');
    expect(r.canonical).toBe('http://169.254.169.254/latest/meta-data/');
  });

  test('codex iter-4 P1 — userinfo does not fool host extraction', () => {
    // Pre-fix: manual scan stopped at the first colon → host was the userinfo
    // username `allowed.example`. Post-fix: WHATWG URL.hostname → `evil.example`.
    const r = normalizeUrl('https://allowed.example:secretpw@evil.example/');
    expect(r.host).toBe('evil.example');
    expect(r.canonical).toBe('https://evil.example/');
    expect(r.canonical).not.toContain('secretpw');
    expect(r.canonical).not.toContain('allowed.example');
  });

  test('codex iter-4 P1 — userinfo with no password also stripped', () => {
    const r = normalizeUrl('https://user@example.com/');
    expect(r.host).toBe('example.com');
    expect(r.canonical).toBe('https://example.com/');
    expect(r.canonical).not.toContain('user@');
  });

  test('codex iter-4 P1 — effectivePort fills in default for elided https', () => {
    const r = normalizeUrl('https://x.io/');
    expect(r.port).toBeUndefined();
    expect(r.effectivePort).toBe(443);
  });

  test('codex iter-4 P1 — effectivePort fills in default for elided http', () => {
    const r = normalizeUrl('http://x.io/');
    expect(r.port).toBeUndefined();
    expect(r.effectivePort).toBe(80);
  });

  test('codex iter-4 P1 — effectivePort matches explicit port', () => {
    const r = normalizeUrl('https://x.io:8443/');
    expect(r.port).toBe(8443);
    expect(r.effectivePort).toBe(8443);
  });

  test('codex iter-5 P2 — bracketed IPv6 URL parses without LDH rejection', () => {
    const r = normalizeUrl('http://[2001:db8::1]/');
    expect(r.host).toBe('2001:db8::1');
    expect(r.hostIsIp).toBe(true);
    expect(r.canonical).toBe('http://[2001:db8::1]/');
  });

  test('codex iter-5 P2 — bracketed IPv6 with explicit default port elides for canonical', () => {
    const r = normalizeUrl('http://[2001:db8::1]:80/');
    expect(r.host).toBe('2001:db8::1');
    expect(r.hostIsIp).toBe(true);
    expect(r.canonical).toBe('http://[2001:db8::1]/');
    expect(r.effectivePort).toBe(80);
  });

  test('codex iter-5 P2 — IPv4 literal sets hostIsIp', () => {
    const r = normalizeUrl('https://8.8.8.8/');
    expect(r.host).toBe('8.8.8.8');
    expect(r.hostIsIp).toBe(true);
  });
});
