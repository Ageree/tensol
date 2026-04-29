// Sprint 8 — fixture loader validation tests.

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsFixtureLoader } from './fixture-loader.ts';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'decepticon',
);

describe('createFsFixtureLoader', () => {
  const loader = createFsFixtureLoader({ fixturesDir: FIXTURES_DIR });

  test('loads xss-reflected fixture', async () => {
    const fixture = await loader.load('xss-reflected');
    expect(fixture.scenario).toBe('xss-reflected');
    expect(fixture.statusTimeline.length).toBe(6);
    expect(fixture.candidates.length).toBe(1);
    expect(fixture.candidates[0]?.type).toBe('xss_reflected');
  });

  test('rejects unsafe scenario names (path-traversal guard)', async () => {
    await expect(loader.load('../etc/passwd')).rejects.toThrow(/unsafe_fixture_name/);
    await expect(loader.load('foo/bar')).rejects.toThrow(/unsafe_fixture_name/);
    await expect(loader.load('FOO')).rejects.toThrow(/unsafe_fixture_name/);
  });

  test('rejects malformed JSON via test-seam reader', async () => {
    const bad = createFsFixtureLoader({
      fixturesDir: FIXTURES_DIR,
      readFile: async () => 'not-json',
    });
    await expect(bad.load('xss-reflected')).rejects.toThrow(/fixture_json_parse_failed/);
  });

  test('rejects schema-invalid JSON', async () => {
    const bad = createFsFixtureLoader({
      fixturesDir: FIXTURES_DIR,
      readFile: async () => JSON.stringify({ scenario: 'x' }),
    });
    await expect(bad.load('xss-reflected')).rejects.toThrow(/fixture_schema_invalid/);
  });

  test('crash fixture parses with simulateCrashAt', async () => {
    const fixture = await loader.load('xss-reflected-crash');
    expect(fixture.simulateCrashAt).toBe('recon');
  });
});
