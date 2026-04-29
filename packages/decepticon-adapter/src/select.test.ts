// Sprint 8 — adapter selector behaviour.

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeDecepticonAdapter } from './fake.ts';
import { RealDecepticonAdapter } from './real.ts';
import { resolveAdapterKind, selectAdapter } from './select.ts';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'decepticon',
);

describe('resolveAdapterKind', () => {
  test('default → fake', () => {
    expect(resolveAdapterKind(undefined)).toBe('fake');
    expect(resolveAdapterKind({})).toBe('fake');
    expect(resolveAdapterKind({ DECEPTICON_ADAPTER: '' })).toBe('fake');
  });
  test('explicit fake/real', () => {
    expect(resolveAdapterKind({ DECEPTICON_ADAPTER: 'fake' })).toBe('fake');
    expect(resolveAdapterKind({ DECEPTICON_ADAPTER: 'real' })).toBe('real');
  });
  test('unknown values throw', () => {
    expect(() => resolveAdapterKind({ DECEPTICON_ADAPTER: 'redis' })).toThrow(
      /invalid_decepticon_adapter_env/,
    );
  });
});

describe('selectAdapter', () => {
  test('fake env returns FakeDecepticonAdapter', () => {
    const a = selectAdapter({ env: { DECEPTICON_ADAPTER: 'fake' }, fixturesDir: FIXTURES_DIR });
    expect(a).toBeInstanceOf(FakeDecepticonAdapter);
  });
  test('real env returns RealDecepticonAdapter', () => {
    const a = selectAdapter({ env: { DECEPTICON_ADAPTER: 'real' }, fixturesDir: FIXTURES_DIR });
    expect(a).toBeInstanceOf(RealDecepticonAdapter);
  });
  test('default (no env override) returns FakeDecepticonAdapter', () => {
    const a = selectAdapter({ env: {}, fixturesDir: FIXTURES_DIR });
    expect(a).toBeInstanceOf(FakeDecepticonAdapter);
  });
});
