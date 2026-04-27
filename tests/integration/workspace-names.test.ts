import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const groups = ['apps', 'services', 'packages'] as const;

const collectWorkspaces = async (): Promise<ReadonlyArray<string>> => {
  const all: string[] = [];
  for (const group of groups) {
    const entries = await readdir(join(repoRoot, group), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        all.push(`${group}/${entry.name}`);
      }
    }
  }
  return all.sort();
};

describe('workspace-names :: aggregator (A18, R9)', () => {
  test('every workspace exports name = "<group>/<dir>"', async () => {
    const keys = await collectWorkspaces();
    expect(keys.length).toBeGreaterThanOrEqual(20);

    const seen: string[] = [];
    for (const key of keys) {
      const mod = (await import(join(repoRoot, key, 'src/index.ts'))) as {
        name?: unknown;
      };
      expect(typeof mod.name).toBe('string');
      expect(mod.name).toBe(key);
      seen.push(mod.name as string);
    }

    const unique = new Set(seen);
    expect(unique.size).toBe(seen.length);
  });
});
