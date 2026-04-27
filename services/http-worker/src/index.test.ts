import { describe, expect, test } from 'bun:test';
import { name } from './index.ts';

describe('services/http-worker :: smoke', () => {
  test('name equals workspace key', () => {
    expect(name).toBe('services/http-worker');
  });
});
