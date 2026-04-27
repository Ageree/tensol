import { describe, expect, test } from 'bun:test';
import { name } from './index.ts';

describe('services/cyberstrike-worker :: smoke', () => {
  test('name equals workspace key', () => {
    expect(name).toBe('services/cyberstrike-worker');
  });
});
