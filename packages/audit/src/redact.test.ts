import { describe, expect, test } from 'bun:test';
import { CIRCULAR, DEFAULT_SECRET_KEYS, REDACTED, redact } from './redact.ts';

describe('packages/audit :: redact (A16)', () => {
  test('strips top-level secret keys (case-insensitive)', () => {
    const out = redact({
      Password: 'p',
      PASSWD: 'p',
      Secret: 's',
      Token: 't',
      Cookie: 'c',
      Authorization: 'a',
      'Set-Cookie': 'sc',
      mfa_secret: 'm',
      totp_secret: 't',
      private_key: 'pk',
      api_key: 'ak',
      bearer: 'b',
      jwt: 'j',
      session_token: 'st',
      kept: 'kept',
    });
    expect(out).toEqual({
      Password: REDACTED,
      PASSWD: REDACTED,
      Secret: REDACTED,
      Token: REDACTED,
      Cookie: REDACTED,
      Authorization: REDACTED,
      'Set-Cookie': REDACTED,
      mfa_secret: REDACTED,
      totp_secret: REDACTED,
      private_key: REDACTED,
      api_key: REDACTED,
      bearer: REDACTED,
      jwt: REDACTED,
      session_token: REDACTED,
      kept: 'kept',
    });
  });

  test('NQ-B: bearer / jwt / session_token are in the default list', () => {
    expect(DEFAULT_SECRET_KEYS).toContain('bearer');
    expect(DEFAULT_SECRET_KEYS).toContain('jwt');
    expect(DEFAULT_SECRET_KEYS).toContain('session_token');
  });

  test('strips nested secret keys at arbitrary depth', () => {
    const out = redact({
      a: { b: { c: { password: 'leak', kept: 1 } } },
    });
    expect(out).toEqual({
      a: { b: { c: { password: REDACTED, kept: 1 } } },
    });
  });

  test('walks into arrays of objects', () => {
    const out = redact([{ token: 't', kept: 1 }, { kept: 2 }]);
    expect(out).toEqual([{ token: REDACTED, kept: 1 }, { kept: 2 }]);
  });

  test('handles cycles without recursing — replaces with [circular]', () => {
    type Node = { name: string; child?: Node };
    const a: Node = { name: 'a' };
    const b: Node = { name: 'b' };
    a.child = b;
    b.child = a;
    const out = redact(a) as { name: string; child: { name: string; child: string } };
    expect(out.name).toBe('a');
    expect(out.child.name).toBe('b');
    expect(out.child.child).toBe(CIRCULAR);
  });

  test('preserves non-object primitives verbatim', () => {
    expect(redact(0)).toBe(0);
    expect(redact('hi')).toBe('hi');
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(true)).toBe(true);
  });

  test('does not mutate the input', () => {
    const input = { password: 'leak', nested: { token: 't' } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redact(input);
    expect(input).toEqual(snapshot);
  });

  test('additionalKeys extends the default list', () => {
    const out = redact({ custom_secret: 'leak', kept: 1 }, { additionalKeys: ['custom_secret'] });
    expect(out).toEqual({ custom_secret: REDACTED, kept: 1 });
  });

  test('additionalKeys does not disable the defaults', () => {
    const out = redact({ password: 'leak', custom: 'c' }, { additionalKeys: ['custom'] });
    expect(out).toEqual({ password: REDACTED, custom: REDACTED });
  });

  test('Symbol keys are preserved verbatim (cannot match string secret list)', () => {
    const sym = Symbol('opaque');
    const input: Record<string | symbol, unknown> = {
      kept: 1,
      [sym]: { password: 'not-stripped' },
    };
    const out = redact(input) as Record<string | symbol, unknown>;
    expect(out.kept).toBe(1);
    expect(out[sym]).toEqual({ password: 'not-stripped' });
  });

  test('mixed-type arrays', () => {
    const out = redact([1, 'a', null, { token: 't' }, [2, { secret: 's' }]]);
    expect(out).toEqual([1, 'a', null, { token: REDACTED }, [2, { secret: REDACTED }]]);
  });
});
