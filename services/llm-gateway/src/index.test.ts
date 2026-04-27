import { describe, expect, test } from 'bun:test';
import { name } from './index.ts';

describe('services/llm-gateway :: smoke', () => {
  test('name equals workspace key', () => {
    expect(name).toBe('services/llm-gateway');
  });
});
