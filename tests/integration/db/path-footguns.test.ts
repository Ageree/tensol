// Sprint 2 contract B25 — Cyrillic path / fileURLToPath rule.
// Wraps the grep guard in a `bun test` so violations fail the suite, not
// just the CI grep step.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('path footguns (B25)', () => {
  test('no .pathname / path.dirname(import.meta.url) / __dirname in db, integration tests, or scripts', () => {
    const result = spawnSync(
      'grep',
      [
        '-RIn',
        '-E',
        String.raw`(import\.meta\.url\)?\.pathname|path\.dirname\(import\.meta\.url|^.*\b__dirname\b)`,
        'packages/db/',
        'tests/integration/db/',
        'scripts/',
        '--include=*.ts',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        // Exclude this file itself — it legitimately mentions the patterns
        // inside a string literal as the search target.
        '--exclude=path-footguns.test.ts',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    // grep exits 1 when no matches found — that's the success state.
    if (result.status === 0) {
      throw new Error(`B25 footgun violation:\n${result.stdout}`);
    }
    expect(result.status).toBe(1);
  });
});
