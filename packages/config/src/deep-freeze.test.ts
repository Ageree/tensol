import { describe, expect, test } from 'bun:test';
import { deepFreeze } from './deep-freeze.ts';

describe('deepFreeze', () => {
  test('returns primitive unchanged', () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze('s')).toBe('s');
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(undefined)).toBe(undefined);
    expect(deepFreeze(true)).toBe(true);
  });

  test('freezes top-level object', () => {
    const obj = { a: 1 };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => {
      (frozen as { a: number }).a = 2;
    }).toThrow(TypeError);
  });

  test('freezes nested objects (deep)', () => {
    const obj = { a: { b: { c: 1 } } };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen.a)).toBe(true);
    expect(Object.isFrozen(frozen.a.b)).toBe(true);
  });

  test('freezes arrays and array elements', () => {
    const arr = [{ a: 1 }, { a: 2 }];
    const frozen = deepFreeze(arr);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen[0])).toBe(true);
    expect(() => {
      (frozen as unknown as { push: (x: unknown) => void }).push({ a: 3 });
    }).toThrow(TypeError);
  });

  test('handles array nested in object', () => {
    const obj = { items: [{ name: 'a' }, { name: 'b' }] };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen.items)).toBe(true);
    expect(Object.isFrozen(frozen.items[0])).toBe(true);
  });

  test('returns already-frozen value as-is (idempotent fast-path)', () => {
    const obj = Object.freeze({ a: 1 });
    const result = deepFreeze(obj);
    expect(result).toBe(obj);
  });

  test('handles empty array', () => {
    const arr: unknown[] = [];
    const frozen = deepFreeze(arr);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  test('handles empty object', () => {
    const obj = {};
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});
