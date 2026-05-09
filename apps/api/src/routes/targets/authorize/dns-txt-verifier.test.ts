import { describe, expect, it } from 'bun:test';
import { DNS_TOKEN_PREFIX, generateChallenge, verify } from './dns-txt-verifier.ts';

const TOKEN = `${DNS_TOKEN_PREFIX}${'a'.repeat(64)}`;
const DOMAIN = 'example.com';

const mockResolver = (records: string[][]): { resolveTxt: (h: string) => Promise<string[][]> } => ({
  resolveTxt: async (_h) => records,
});

const throwingResolver = (): { resolveTxt: (h: string) => Promise<string[][]> } => ({
  resolveTxt: async (_h) => {
    throw new Error('NXDOMAIN');
  },
});

const hangingResolver = (): { resolveTxt: (h: string) => Promise<string[][]> } => ({
  resolveTxt: () => new Promise(() => { /* never resolves */ }),
});

describe('generateChallenge', () => {
  it('produces tensol-verify= prefixed token and correct subdomain name', () => {
    const hex = 'b'.repeat(64);
    const result = generateChallenge('target-1', DOMAIN, () => hex);
    expect(result.token).toBe(`${DNS_TOKEN_PREFIX}${hex}`);
    expect(result.txtRecord.name).toBe(`_tensol-verify.${DOMAIN}`);
    expect(result.txtRecord.value).toBe(result.token);
  });

  it('is deterministic with same randomBytes override', () => {
    const hex = 'c'.repeat(64);
    const r1 = generateChallenge('t1', DOMAIN, () => hex);
    const r2 = generateChallenge('t1', DOMAIN, () => hex);
    expect(r1.token).toBe(r2.token);
  });
});

describe('verify', () => {
  it('happy path — exact token match', async () => {
    const result = await verify(DOMAIN, TOKEN, { dnsResolver: mockResolver([[TOKEN]]) });
    expect(result).toEqual({ ok: true });
  });

  it('multi-part records joined before compare', async () => {
    const parts = [`${DNS_TOKEN_PREFIX}`, 'a'.repeat(64)];
    const result = await verify(DOMAIN, TOKEN, { dnsResolver: mockResolver([parts]) });
    expect(result).toEqual({ ok: true });
  });

  it('multiple records — one matches', async () => {
    const result = await verify(DOMAIN, TOKEN, {
      dnsResolver: mockResolver([['noise'], [TOKEN]]),
    });
    expect(result).toEqual({ ok: true });
  });

  it('wrong token — mismatch', async () => {
    const result = await verify(DOMAIN, TOKEN, {
      dnsResolver: mockResolver([[`${DNS_TOKEN_PREFIX}${'z'.repeat(64)}`]]),
    });
    expect(result).toEqual({ ok: false, reason: 'token_mismatch' });
  });

  it('no records — mismatch', async () => {
    const result = await verify(DOMAIN, TOKEN, { dnsResolver: mockResolver([]) });
    expect(result).toEqual({ ok: false, reason: 'token_mismatch' });
  });

  it('resolver throws (NXDOMAIN) → dns_lookup_error', async () => {
    const result = await verify(DOMAIN, TOKEN, { dnsResolver: throwingResolver() });
    expect(result).toEqual({ ok: false, reason: 'dns_lookup_error' });
  });

  it('resolver hangs → timeout (50ms injected)', async () => {
    const result = await verify(DOMAIN, TOKEN, { dnsResolver: hangingResolver(), timeoutMs: 50 });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });
});
