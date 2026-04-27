// Internal scaffolder used once during Sprint 1 bootstrap.
// Generates package.json, tsconfig.json, src/index.ts, src/index.test.ts for a workspace.
// Skips packages/config (already authored by hand).

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const workspaces = [
  'apps/api',
  'apps/web',
  'services/coordinator',
  'services/browser-worker',
  'services/validator-worker',
  'services/report-builder',
  'services/http-worker',
  'services/cyberstrike-worker',
  'services/llm-gateway',
  'packages/contracts',
  'packages/db',
  'packages/authz',
  'packages/scope-engine',
  'packages/audit',
  'packages/object-storage',
  'packages/queue',
  'packages/telemetry',
  'packages/validators',
  'packages/reports',
  'packages/skill-library',
] as const;

const packageJson = (key: string) =>
  `${JSON.stringify(
    {
      name: `@cyberstrike/${key.split('/').slice(1).join('-')}`,
      version: '0.1.0',
      private: true,
      type: 'module',
      main: './src/index.ts',
      exports: { '.': './src/index.ts' },
      scripts: { typecheck: 'tsc -b' },
    },
    null,
    2,
  )}\n`;

const tsconfigJson = `${JSON.stringify(
  {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      outDir: './dist',
      rootDir: './src',
      tsBuildInfoFile: './dist/.tsbuildinfo',
    },
    include: ['src/**/*'],
    exclude: ['src/**/*.test.ts', 'dist', 'node_modules'],
  },
  null,
  2,
)}\n`;

const indexTs = (key: string) => `export const name = '${key}' as const;\n`;

const indexTestTs = (key: string) => `import { describe, expect, test } from 'bun:test';
import { name } from './index.ts';

describe('${key} :: smoke', () => {
  test('name equals workspace key', () => {
    expect(name).toBe('${key}');
  });
});
`;

for (const key of workspaces) {
  const dir = join(repoRoot, key);
  const srcDir = join(dir, 'src');
  if (!existsSync(srcDir)) {
    await mkdir(srcDir, { recursive: true });
  }
  await writeFile(join(dir, 'package.json'), packageJson(key));
  await writeFile(join(dir, 'tsconfig.json'), tsconfigJson);
  await writeFile(join(srcDir, 'index.ts'), indexTs(key));
  await writeFile(join(srcDir, 'index.test.ts'), indexTestTs(key));
  console.warn(`scaffolded ${key}`);
}
