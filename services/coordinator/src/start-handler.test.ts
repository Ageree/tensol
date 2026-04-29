// Sprint 13 codex P2 — targetUrlForChild IPv6 bracket fix unit tests.
//
// targetUrlForChild converts an AssessmentTargetRow into a URL string for
// child job envelopes. IPv6 IP-kind targets require square brackets:
//   http://[2001:db8::1]/   (RFC 2732)
// Previously the function emitted http://2001:db8::1/ which is not a valid URL.

import { describe, expect, test } from 'bun:test';
import { targetUrlForChild } from './start-handler.ts';

describe('targetUrlForChild (P2 IPv6 bracket fix)', () => {
  test('url-kind target passes through unchanged', () => {
    expect(
      targetUrlForChild({ target_id: 't1', kind: 'url', value: 'https://example.com/path' }),
    ).toBe('https://example.com/path');
  });

  test('domain-kind target gets https:// prefix', () => {
    expect(targetUrlForChild({ target_id: 't2', kind: 'domain', value: 'example.com' })).toBe(
      'https://example.com',
    );
  });

  test('ip-kind IPv4 target gets http://<ip>/ wrapper', () => {
    expect(targetUrlForChild({ target_id: 't3', kind: 'ip', value: '192.0.2.1' })).toBe(
      'http://192.0.2.1/',
    );
  });

  test('ip-kind IPv6 target gets http://[<ip>]/ with brackets (P2)', () => {
    expect(targetUrlForChild({ target_id: 't4', kind: 'ip', value: '2001:db8::1' })).toBe(
      'http://[2001:db8::1]/',
    );
  });

  test('ip-kind full IPv6 address is bracketed', () => {
    expect(
      targetUrlForChild({
        target_id: 't5',
        kind: 'ip',
        value: '2001:0db8:0000:0000:0000:0000:0000:0001',
      }),
    ).toBe('http://[2001:0db8:0000:0000:0000:0000:0000:0001]/');
  });

  test('ip-kind loopback IPv6 (::1) is bracketed', () => {
    expect(targetUrlForChild({ target_id: 't6', kind: 'ip', value: '::1' })).toBe('http://[::1]/');
  });

  test('ip-kind IPv4-mapped IPv6 address is bracketed', () => {
    // ::ffff:192.0.2.1 is IPv6 (isIP returns 6)
    expect(targetUrlForChild({ target_id: 't7', kind: 'ip', value: '::ffff:192.0.2.1' })).toBe(
      'http://[::ffff:192.0.2.1]/',
    );
  });
});
