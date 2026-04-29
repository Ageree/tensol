// Sprint 9 — HAR cookie redaction unit tests (A-BR-Cookie).

import { describe, expect, test } from 'bun:test';
import { type Har, REDACTED, redactCookies } from './har-redactor.ts';

const baseHar: Har = {
  log: {
    version: '1.2',
    entries: [
      {
        request: {
          headers: [
            { name: 'Cookie', value: 'sid=super-secret-token' },
            { name: 'User-Agent', value: 'Test/1.0' },
          ],
          cookies: [{ name: 'sid', value: 'super-secret-token' }],
        },
        response: {
          headers: [
            { name: 'Set-Cookie', value: 'session=top-secret; Path=/' },
            { name: 'Content-Type', value: 'text/html' },
          ],
          cookies: [{ name: 'session', value: 'top-secret' }],
        },
      },
    ],
  },
};

describe('redactCookies', () => {
  test('strips Cookie request header value', () => {
    const out = redactCookies(baseHar);
    const reqHeaders = out.log?.entries?.[0]?.request?.headers ?? [];
    const cookieHeader = reqHeaders.find((h) => h.name.toLowerCase() === 'cookie');
    expect(cookieHeader?.value).toBe(REDACTED);
  });

  test('strips Set-Cookie response header value', () => {
    const out = redactCookies(baseHar);
    const respHeaders = out.log?.entries?.[0]?.response?.headers ?? [];
    const setCookie = respHeaders.find((h) => h.name.toLowerCase() === 'set-cookie');
    expect(setCookie?.value).toBe(REDACTED);
  });

  test('strips request cookies[].value', () => {
    const out = redactCookies(baseHar);
    const cookies = out.log?.entries?.[0]?.request?.cookies ?? [];
    expect(cookies[0]?.value).toBe(REDACTED);
  });

  test('strips response cookies[].value', () => {
    const out = redactCookies(baseHar);
    const cookies = out.log?.entries?.[0]?.response?.cookies ?? [];
    expect(cookies[0]?.value).toBe(REDACTED);
  });

  test('preserves non-cookie headers', () => {
    const out = redactCookies(baseHar);
    const reqHeaders = out.log?.entries?.[0]?.request?.headers ?? [];
    const ua = reqHeaders.find((h) => h.name === 'User-Agent');
    expect(ua?.value).toBe('Test/1.0');
  });

  test('idempotent — running twice yields same output', () => {
    const once = redactCookies(baseHar);
    const twice = redactCookies(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  test('does not mutate input', () => {
    const inputBefore = JSON.stringify(baseHar);
    redactCookies(baseHar);
    expect(JSON.stringify(baseHar)).toBe(inputBefore);
  });

  test('handles missing log gracefully', () => {
    const out = redactCookies({});
    expect(out).toEqual({});
  });

  test('handles entries with no headers/cookies', () => {
    const minimal: Har = {
      log: {
        version: '1.2',
        entries: [{ request: {}, response: {} }],
      },
    };
    const out = redactCookies(minimal);
    expect(out.log?.entries?.[0]?.request).toEqual({});
  });

  test('case-insensitive header match — lowercase cookie/set-cookie', () => {
    const lower: Har = {
      log: {
        version: '1.2',
        entries: [
          {
            request: { headers: [{ name: 'cookie', value: 'leak=1' }] },
            response: { headers: [{ name: 'set-cookie', value: 'leak2=1' }] },
          },
        ],
      },
    };
    const out = redactCookies(lower);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('leak=1');
    expect(serialized).not.toContain('leak2=1');
    expect(serialized).toContain(REDACTED);
  });
});
