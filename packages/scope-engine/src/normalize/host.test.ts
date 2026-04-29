import { describe, expect, test } from 'bun:test';
import { HostNormalizationError, normalizeHost } from './host.ts';

describe('scope-engine :: normalize/host', () => {
  test('lowercases', () => {
    expect(normalizeHost('Example.COM').canonical).toBe('example.com');
  });

  test('strips trailing dot', () => {
    expect(normalizeHost('example.com.').canonical).toBe('example.com');
  });

  test('IDN — Cyrillic-only label converts to punycode', () => {
    const result = normalizeHost('президент.рф');
    expect(result.canonical).toBe('xn--d1abbgf6aiiy.xn--p1ai');
    expect(result.hasMixedScript).toBe(false);
  });

  test('OQ-8 — flags mixed-script (Latin + Cyrillic homograph)', () => {
    // 'gооgle' with Cyrillic 'о' (U+043E) instead of Latin 'o' (U+006F).
    const cyrillicO = 'о';
    const homograph = `g${cyrillicO}${cyrillicO}gle.com`;
    const result = normalizeHost(homograph);
    expect(result.hasMixedScript).toBe(true);
  });

  test('preserves punycode round-trip', () => {
    const r1 = normalizeHost('xn--d1abbgf6aiiy.xn--p1ai');
    const r2 = normalizeHost('президент.рф');
    expect(r1.canonical).toBe(r2.canonical);
  });

  test('throws on empty', () => {
    expect(() => normalizeHost('')).toThrow(HostNormalizationError);
    expect(() => normalizeHost('   ')).toThrow(HostNormalizationError);
  });

  test('throws on whitespace embedded', () => {
    expect(() => normalizeHost('foo bar.com')).toThrow(HostNormalizationError);
  });

  test('idempotent', () => {
    const a = normalizeHost('Example.COM.');
    const b = normalizeHost(a.canonical);
    expect(a.canonical).toBe(b.canonical);
  });

  test('rejects non-string input', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
    expect(() => normalizeHost(123 as any)).toThrow(HostNormalizationError);
  });

  test('does not flag pure ASCII Latin', () => {
    expect(normalizeHost('example.com').hasMixedScript).toBe(false);
  });

  test('does not flag pure non-Latin', () => {
    expect(normalizeHost('президент.рф').hasMixedScript).toBe(false);
  });

  test('throws on multi-dot empty label', () => {
    expect(() => normalizeHost('foo..com')).toThrow(HostNormalizationError);
  });
});
