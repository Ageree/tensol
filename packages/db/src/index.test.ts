import { describe, expect, test } from 'bun:test';
import { name } from './index.ts';

describe('packages/db :: smoke', () => {
  test('name equals workspace key', () => {
    expect(name).toBe('packages/db');
  });
});
