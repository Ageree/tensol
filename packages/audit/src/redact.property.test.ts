// A17 — property tests for redact() using fast-check.
//
// Properties asserted:
//  P1. Idempotent — redact(redact(x)) === redact(x).
//  P2. Pure — output of two calls on the same input is structurally equal.
//  P3. No mutation — input is unchanged after redact().
//  P4. No secret value survives — for any object whose path includes a key in
//      the default secret list, the redacted output does not contain the
//      original value at that path.

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { DEFAULT_SECRET_KEYS, REDACTED, redact } from './redact.ts';

const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  json: fc.oneof(
    { maxDepth: 5 },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string(),
    fc.array(tie('json'), { maxLength: 4 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie('json'), { maxKeys: 4 }),
  ),
})).json;

describe('packages/audit :: redact property tests (A17)', () => {
  test('P1: redact is idempotent', () => {
    fc.assert(
      fc.property(jsonValueArb, (x) => {
        const a = redact(x);
        const b = redact(a);
        expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
      }),
      { numRuns: 50 },
    );
  });

  test('P2: redact is pure (structurally equal across calls)', () => {
    fc.assert(
      fc.property(jsonValueArb, (x) => {
        const a = redact(x);
        const b = redact(x);
        expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
      }),
      { numRuns: 50 },
    );
  });

  test('P3: input is not mutated', () => {
    fc.assert(
      fc.property(jsonValueArb, (x) => {
        const before = JSON.stringify(x);
        redact(x);
        expect(JSON.stringify(x)).toEqual(before);
      }),
      { numRuns: 50 },
    );
  });

  test('P4: secret-keyed values are replaced by [redacted] at any depth', () => {
    const secretKey = fc.constantFrom(...DEFAULT_SECRET_KEYS);
    const innerVal = fc.string();
    const wrapped = fc.tuple(secretKey, innerVal).map(([k, v]) => ({ [k]: v }));
    fc.assert(
      fc.property(wrapped, (obj) => {
        const out = redact(obj) as Record<string, unknown>;
        const k = Object.keys(obj)[0];
        if (k === undefined) return;
        expect(out[k]).toBe(REDACTED);
      }),
      { numRuns: 50 },
    );
  });

  test('P4-nested: secret-keyed values at depth 5 are replaced', () => {
    const sk = fc.constantFrom(...DEFAULT_SECRET_KEYS);
    fc.assert(
      fc.property(fc.string(), sk, (val, key) => {
        const input = { a: { b: { c: { d: { [key]: val } } } } };
        // biome-ignore lint/suspicious/noExplicitAny: traversal
        const out = redact(input) as any;
        expect(out.a.b.c.d[key]).toBe(REDACTED);
      }),
      { numRuns: 30 },
    );
  });
});
