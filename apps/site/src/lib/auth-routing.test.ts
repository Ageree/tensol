import { describe, expect, test } from 'bun:test';
import { githubSsoCallbackUrl, normalizeReturnTo } from './auth-routing.ts';

describe('auth routing helpers', () => {
  test('normalizeReturnTo keeps local paths', () => {
    expect(normalizeReturnTo('/repositories?tab=all')).toBe('/repositories?tab=all');
  });

  test('normalizeReturnTo rejects missing or protocol-relative paths', () => {
    expect(normalizeReturnTo(null)).toBe('/dashboard');
    expect(normalizeReturnTo('https://example.com')).toBe('/dashboard');
    expect(normalizeReturnTo('//example.com')).toBe('/dashboard');
  });

  test('githubSsoCallbackUrl preserves return target in callback query', () => {
    expect(githubSsoCallbackUrl('/reviews/rv_1?tab=findings')).toBe(
      '/sso-callback?return_to=%2Freviews%2Frv_1%3Ftab%3Dfindings',
    );
  });
});
