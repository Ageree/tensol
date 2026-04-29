import { describe, expect, test } from 'bun:test';
import {
  NONCE_REGEX,
  buildXssPayload,
  generateNonce,
  nonceMatchesEcho,
  taggedConsoleMessage,
} from './nonce.ts';

describe('validators :: nonce', () => {
  test('generateNonce produces 1000 distinct 32-lowercase-alphanumeric strings', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const n = generateNonce();
      expect(NONCE_REGEX.test(n)).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(1000);
  });

  test('generateNonce honours injected randomBytes', () => {
    const fixed = new Uint8Array(32).fill(0); // → all 'a'
    const out = generateNonce({ randomBytes: (): Uint8Array => fixed });
    expect(out).toBe('a'.repeat(32));
  });

  test('nonceMatchesEcho is a strict substring check', () => {
    const nonce = generateNonce();
    expect(nonceMatchesEcho(nonce, `prefix-${nonce}-suffix`)).toBe(true);
    expect(nonceMatchesEcho(nonce, 'unrelated body without it')).toBe(false);
  });

  test('nonceMatchesEcho rejects malformed nonces (defence in depth)', () => {
    expect(nonceMatchesEcho('not-32-chars', 'not-32-chars-anywhere')).toBe(false);
    expect(nonceMatchesEcho('A'.repeat(32), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });

  test('taggedConsoleMessage formats as [level][nonce]text', () => {
    expect(taggedConsoleMessage('abc', 'log', 'hi')).toBe('[log][abc]hi');
  });

  test('buildXssPayload contains the nonce in DOM + console sinks', () => {
    const nonce = 'a'.repeat(32);
    const payload = buildXssPayload(nonce);
    expect(payload.includes(nonce)).toBe(true);
    expect(payload.includes('data-cs-nonce')).toBe(true);
    expect(payload.includes('console.log')).toBe(true);
  });
});
