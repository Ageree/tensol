// Sprint 16 — unit tests for spa-observer (no Playwright dep).

import { describe, expect, test } from 'bun:test';
import { SPA_OBSERVER_SCRIPT, parseSpaMaxDepth, parseSpaRoutes } from './spa-observer.ts';

describe('spa-observer :: SPA_OBSERVER_SCRIPT', () => {
  test('is a non-empty string', () => {
    expect(typeof SPA_OBSERVER_SCRIPT).toBe('string');
    expect(SPA_OBSERVER_SCRIPT.length).toBeGreaterThan(0);
  });

  test('contains pushState patch and popstate listener', () => {
    expect(SPA_OBSERVER_SCRIPT).toContain('history.pushState');
    expect(SPA_OBSERVER_SCRIPT).toContain('popstate');
    expect(SPA_OBSERVER_SCRIPT).toContain('__cs_spa_routes');
  });
});

describe('spa-observer :: parseSpaRoutes', () => {
  test('returns empty array for non-array input', () => {
    expect(parseSpaRoutes(null)).toEqual([]);
    expect(parseSpaRoutes(undefined)).toEqual([]);
    expect(parseSpaRoutes('string')).toEqual([]);
    expect(parseSpaRoutes(42)).toEqual([]);
    expect(parseSpaRoutes({})).toEqual([]);
  });

  test('returns empty array for empty array', () => {
    expect(parseSpaRoutes([])).toEqual([]);
  });

  test('parses valid pushstate entry', () => {
    const raw = [
      { url: 'http://localhost/about', sourceUrl: 'http://localhost/', method: 'pushstate' },
    ];
    const result = parseSpaRoutes(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      url: 'http://localhost/about',
      sourceUrl: 'http://localhost/',
      method: 'pushstate',
    });
  });

  test('parses valid popstate entry', () => {
    const raw = [
      { url: 'http://localhost/', sourceUrl: 'http://localhost/about', method: 'popstate' },
    ];
    const result = parseSpaRoutes(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.method).toBe('popstate');
  });

  test('filters out malformed entries (missing url)', () => {
    const raw = [
      { sourceUrl: 'http://localhost/', method: 'pushstate' },
      { url: 'http://localhost/about', sourceUrl: 'http://localhost/', method: 'pushstate' },
    ];
    const result = parseSpaRoutes(raw);
    expect(result).toHaveLength(1);
  });

  test('filters out malformed entries (invalid method)', () => {
    const raw = [
      { url: 'http://localhost/about', sourceUrl: 'http://localhost/', method: 'replacestate' },
    ];
    expect(parseSpaRoutes(raw)).toHaveLength(0);
  });

  test('filters out null entries', () => {
    expect(parseSpaRoutes([null, undefined, 42])).toHaveLength(0);
  });

  test('handles mixed valid and invalid entries', () => {
    const raw = [
      null,
      { url: 'http://localhost/about', sourceUrl: 'http://localhost/', method: 'pushstate' },
      { url: 42, sourceUrl: 'http://localhost/', method: 'pushstate' },
      { url: 'http://localhost/contact', sourceUrl: 'http://localhost/', method: 'pushstate' },
    ];
    const result = parseSpaRoutes(raw);
    expect(result).toHaveLength(2);
  });
});

describe('spa-observer :: parseSpaMaxDepth', () => {
  test.each([
    ['3', 3],
    ['0', 0],
    ['10', 10],
    ['11', 3],
    ['-1', 3],
    ['abc', 3],
    ['10.9', 10], // parseInt('10.9') === 10, not NaN; within [0,10] cap
    ['2147483648', 3],
    [undefined, 3],
  ] as const)('parseSpaMaxDepth(%s) === %d', (input, expected) => {
    expect(parseSpaMaxDepth(input as string | undefined)).toBe(expected);
  });
});
