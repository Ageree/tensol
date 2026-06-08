import { describe, expect, test } from 'bun:test';
import { normalizeReturnTo } from './auth-routing.ts';

describe('auth routing helpers', () => {
  test('normalizeReturnTo keeps local paths', () => {
    expect(normalizeReturnTo('/repositories?tab=all')).toBe('/repositories?tab=all');
  });

  test('normalizeReturnTo rejects missing or protocol-relative paths', () => {
    expect(normalizeReturnTo(null)).toBe('/dashboard');
    expect(normalizeReturnTo('https://example.com')).toBe('/dashboard');
    expect(normalizeReturnTo('//example.com')).toBe('/dashboard');
  });

  test('normalizeReturnTo rejects auth pages to avoid signed-in redirect loops', () => {
    expect(normalizeReturnTo('/login')).toBe('/dashboard');
    expect(normalizeReturnTo('/login?return_to=/login')).toBe('/dashboard');
    expect(normalizeReturnTo('/signup')).toBe('/dashboard');
    expect(normalizeReturnTo('/signup/sso')).toBe('/dashboard');
  });
});
