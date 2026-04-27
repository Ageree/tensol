import { describe, expect, test } from 'bun:test';
import { name } from './index.ts';

describe('apps/api :: smoke', () => {
  test('name equals workspace key', () => {
    expect(name).toBe('apps/api');
  });
});
