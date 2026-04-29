// A-SE-Pure-1 — engine purity grep test.
//
// Walks every .ts file under packages/scope-engine/src/ and asserts that none
// of them imports a forbidden I/O module. The engine MUST stay pure; DNS/Clock/
// RateLimitCounter all flow in via injected interfaces.

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE_SRC = 'packages/scope-engine/src';

const FORBIDDEN_IMPORT_PATTERNS: readonly RegExp[] = [
  /from ['"]dns['"]/,
  /from ['"]node:dns(\/promises)?['"]/,
  /from ['"]fs['"]/,
  /from ['"]node:fs(\/promises)?['"]/,
  /from ['"]net['"]/,
  /from ['"]node:net['"]/,
  /from ['"]http['"]/,
  /from ['"]node:http['"]/,
  /from ['"]https['"]/,
  /from ['"]node:https['"]/,
  /from ['"]tls['"]/,
  /from ['"]node:tls['"]/,
  /from ['"]child_process['"]/,
  /from ['"]node:child_process['"]/,
  /from ['"]os['"]/,
  /from ['"]node:os['"]/,
  /from ['"]cluster['"]/,
  /from ['"]node:cluster['"]/,
  /from ['"]dgram['"]/,
  /from ['"]node:dgram['"]/,
  /from ['"]inspector['"]/,
  /from ['"]node:inspector['"]/,
  /from ['"]repl['"]/,
  /from ['"]node:repl['"]/,
];

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
};

describe('A-SE-Pure-1 — engine has zero I/O imports', () => {
  test('no forbidden import statements anywhere under packages/scope-engine/src', () => {
    const files = walk(ENGINE_SRC);
    expect(files.length).toBeGreaterThan(0);
    const violations: Array<{ file: string; line: number; text: string; pattern: string }> = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        for (const pat of FORBIDDEN_IMPORT_PATTERNS) {
          if (pat.test(line)) {
            violations.push({
              file,
              line: i + 1,
              text: line.trim(),
              pattern: pat.source,
            });
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('A-SE-Pure-2 — package.json deps manifest', () => {
  test('packages/scope-engine has no I/O-bearing runtime deps', () => {
    const pkg = JSON.parse(readFileSync('packages/scope-engine/package.json', 'utf8'));
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const forbidden = ['kysely', 'pg', 'hono', 'express', 'ws', 'node-fetch'];
    for (const f of forbidden) {
      expect(deps[f]).toBeUndefined();
    }
    // Allowed deps: contracts (workspace) + zod.
    expect(deps['@cyberstrike/contracts']).toBe('workspace:*');
    expect(deps.zod).toBeDefined();
  });
});
