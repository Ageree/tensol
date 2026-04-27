import { describe, expect, test } from 'bun:test';
import { name } from './index.ts';

describe('packages/validators :: smoke', () => {
  test('name equals workspace key', () => {
    expect(name).toBe('packages/validators');
  });
});
