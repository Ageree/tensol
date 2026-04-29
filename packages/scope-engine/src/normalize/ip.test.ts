import { describe, expect, test } from 'bun:test';
import { IpNormalizationError, normalizeIp } from './ip.ts';

describe('scope-engine :: normalize/ip — IPv4 oracle', () => {
  test('canonical dotted decimal', () => {
    const r = normalizeIp('192.168.1.1');
    expect(r.family).toBe('ipv4');
    expect(r.canonical).toBe('192.168.1.1');
    expect(r.classification).toBe('private');
  });

  test('leading zeros canonicalize', () => {
    expect(normalizeIp('192.168.001.001').canonical).toBe('192.168.1.1');
  });

  test('octal canonicalizes', () => {
    expect(normalizeIp('0177.0.0.1').canonical).toBe('127.0.0.1');
  });

  test('hex canonicalizes', () => {
    expect(normalizeIp('0xc0.0xa8.0x01.0x01').canonical).toBe('192.168.1.1');
  });

  test('integer form canonicalizes', () => {
    expect(normalizeIp('3232235777').canonical).toBe('192.168.1.1');
  });

  test('classification: 127.0.0.1 → loopback', () => {
    expect(normalizeIp('127.0.0.1').classification).toBe('loopback');
  });

  test('classification: 169.254.169.254 → metadata (AWS/GCP)', () => {
    expect(normalizeIp('169.254.169.254').classification).toBe('metadata');
  });

  test('classification: 100.100.100.200 → metadata (Yandex Cloud)', () => {
    expect(normalizeIp('100.100.100.200').classification).toBe('metadata');
  });

  test('classification: 169.254.x.y (non-metadata) → link_local', () => {
    expect(normalizeIp('169.254.0.1').classification).toBe('link_local');
  });

  test('classification: 10/8, 172.16/12, 192.168/16 → private', () => {
    expect(normalizeIp('10.0.0.0').classification).toBe('private');
    expect(normalizeIp('172.16.0.1').classification).toBe('private');
    expect(normalizeIp('172.31.255.255').classification).toBe('private');
    expect(normalizeIp('192.168.255.255').classification).toBe('private');
  });

  test('classification: 8.8.8.8 → public', () => {
    expect(normalizeIp('8.8.8.8').classification).toBe('public');
  });

  test('rejects invalid', () => {
    expect(() => normalizeIp('999.999.999.999')).toThrow(IpNormalizationError);
    expect(() => normalizeIp('not.an.ip.address')).toThrow(IpNormalizationError);
    expect(() => normalizeIp('')).toThrow(IpNormalizationError);
  });

  test('idempotent', () => {
    const a = normalizeIp('192.168.001.001');
    const b = normalizeIp(a.canonical);
    expect(a.canonical).toBe(b.canonical);
  });
});

describe('scope-engine :: normalize/ip — IPv6 oracle', () => {
  test('full form', () => {
    const r = normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(r.family).toBe('ipv6');
    expect(r.canonical).toBe('2001:db8::1');
  });

  test('compressed', () => {
    expect(normalizeIp('::1').canonical).toBe('::1');
    expect(normalizeIp('::1').classification).toBe('loopback');
  });

  test('fe80::/10 → link_local', () => {
    expect(normalizeIp('fe80::1').classification).toBe('link_local');
  });

  test('fc00::/7 → private', () => {
    expect(normalizeIp('fc00::1').classification).toBe('private');
    expect(normalizeIp('fd12:3456::1').classification).toBe('private');
  });

  test('mapped IPv4 → classifies via embedded v4', () => {
    expect(normalizeIp('::ffff:127.0.0.1').classification).toBe('loopback');
    expect(normalizeIp('::ffff:8.8.8.8').classification).toBe('public');
    expect(normalizeIp('::ffff:192.168.1.1').classification).toBe('private');
  });

  test('R4 — zone-id stripped from canonical, retained on side', () => {
    const r = normalizeIp('fe80::1%eth0');
    expect(r.canonical).toBe('fe80::1');
    expect(r.zoneId).toBe('eth0');
    expect(r.classification).toBe('link_local');
  });

  test('R4 — fe80::1%eth0 produces SAME canonical as fe80::1', () => {
    const a = normalizeIp('fe80::1%eth0');
    const b = normalizeIp('fe80::1');
    expect(a.canonical).toBe(b.canonical);
  });

  test('rejects malformed', () => {
    expect(() => normalizeIp('::g')).toThrow(IpNormalizationError);
    expect(() => normalizeIp(':::')).toThrow(IpNormalizationError);
    expect(() => normalizeIp('1::2::3')).toThrow(IpNormalizationError);
  });

  test('idempotent', () => {
    const a = normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001');
    const b = normalizeIp(a.canonical);
    expect(a.canonical).toBe(b.canonical);
  });

  test('codex iter-7 P2 — junk-suffix in IPv6 short-form group rejected', () => {
    // Pre-fix: `Number.parseInt('1zz', 16)` yields 1 → silently accepts.
    // Post-fix: HEX_GROUP_RE rejects the whole input.
    expect(() => normalizeIp('2001:db8::1zz')).toThrow(IpNormalizationError);
  });

  test('codex iter-7 P2 — junk in 8-group IPv6 form rejected', () => {
    expect(() => normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001zz')).toThrow(
      IpNormalizationError,
    );
  });

  test('codex iter-7 P2 — 5-hex-digit group rejected (too long)', () => {
    expect(() => normalizeIp('2001:db8::12345')).toThrow(IpNormalizationError);
  });

  test('codex iter-7 P2 — well-formed IPv6 still accepted', () => {
    expect(() => normalizeIp('2001:db8::1')).not.toThrow();
    expect(() => normalizeIp('::1')).not.toThrow();
    expect(() => normalizeIp('fe80::abcd')).not.toThrow();
  });
});
