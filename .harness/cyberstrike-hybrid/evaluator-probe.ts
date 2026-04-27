/**
 * Evaluator-authored verification probes for Sprint 1.
 * Independent of Generator's tests. Run with `bun .harness/cyberstrike-hybrid/evaluator-probe.ts`.
 */
import {
  type AppConfig,
  ConfigValidationError,
  baseConfigSchema,
  loadConfig,
} from '../../packages/config/src/index.ts';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
const results: string[] = [];

const ok = (label: string, detail?: string) => {
  results.push(`PASS  ${label}${detail ? ' — ' + detail : ''}`);
};
const fail = (label: string, detail: string) => {
  failures++;
  results.push(`FAIL  ${label} — ${detail}`);
};

const expectThrow = (
  label: string,
  fn: () => unknown,
  predicate?: (e: unknown) => boolean,
) => {
  try {
    fn();
    fail(label, 'expected throw, got success');
  } catch (e) {
    if (predicate && !predicate(e)) {
      fail(label, `threw but failed predicate: ${(e as Error).message}`);
    } else {
      ok(label, e instanceof Error ? e.message.slice(0, 80) : String(e));
    }
  }
};

// =====================================================
// PROBE 1 — A14: Deep-freeze NESTED mutation must throw in strict mode.
// =====================================================
const validProdEnv = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://x@y/z',
  OBJECT_STORAGE_ENDPOINT: 'http://e',
  OBJECT_STORAGE_ACCESS_KEY: 'a',
  OBJECT_STORAGE_SECRET_KEY: 's',
  OBJECT_STORAGE_BUCKET: 'b',
  QUEUE_ADAPTER: 'local',
  DECEPTICON_ADAPTER: 'fake',
  SESSION_SECRET: 'x'.repeat(32),
};

const cfg = loadConfig(baseConfigSchema, validProdEnv) as AppConfig;

// A14 — root frozen
if (Object.isFrozen(cfg)) ok('A14 root deep-frozen');
else fail('A14 root deep-frozen', 'cfg is not frozen at root');

// A14 — nested objectStorage frozen
if (Object.isFrozen(cfg.objectStorage)) ok('A14 nested.objectStorage frozen');
else fail('A14 nested.objectStorage frozen', 'cfg.objectStorage is not frozen');

// A14 — nested queue frozen
if (Object.isFrozen(cfg.queue)) ok('A14 nested.queue frozen');
else fail('A14 nested.queue frozen', 'cfg.queue is not frozen');

// A14 — strict-mode mutation at root throws
expectThrow(
  'A14 strict mutation at root throws',
  () => {
    'use strict';
    (cfg as unknown as { appEnv: string }).appEnv = 'local';
  },
  (e) => e instanceof TypeError,
);

// A14 — strict-mode mutation at nested level throws
expectThrow(
  'A14 strict mutation nested.objectStorage.bucket throws',
  () => {
    'use strict';
    (cfg.objectStorage as unknown as { bucket: string }).bucket = 'pwned';
  },
  (e) => e instanceof TypeError,
);

// =====================================================
// PROBE 2 — A14b: SESSION_SECRET length boundary (31 fail / 32 pass).
// =====================================================
for (const env of ['dev', 'staging', 'production', 'internal-lab']) {
  // Length 31 should throw with session_secret issue.
  expectThrow(
    `A14b SESSION_SECRET=31 chars in ${env} fails`,
    () =>
      loadConfig(baseConfigSchema, {
        ...validProdEnv,
        APP_ENV: env,
        SESSION_SECRET: 'x'.repeat(31),
      }),
    (e) =>
      e instanceof ConfigValidationError &&
      e.issues.some((i) => i.path.join('.').toLowerCase().includes('session')),
  );

  // Length 32 should succeed.
  try {
    const c = loadConfig(baseConfigSchema, {
      ...validProdEnv,
      APP_ENV: env,
      SESSION_SECRET: 'x'.repeat(32),
    }) as AppConfig;
    if (c.appEnv === env) ok(`A14b SESSION_SECRET=32 chars in ${env} passes`);
    else fail(`A14b SESSION_SECRET=32 chars in ${env} passes`, `appEnv mismatch: ${c.appEnv}`);
  } catch (e) {
    fail(
      `A14b SESSION_SECRET=32 chars in ${env} passes`,
      `unexpected throw: ${(e as Error).message}`,
    );
  }
}

// =====================================================
// PROBE 3 — A13: Missing DATABASE_URL in staging must throw.
// =====================================================
expectThrow(
  'A13 missing DATABASE_URL in staging fails',
  () => {
    const partial = { ...validProdEnv, APP_ENV: 'staging' };
    delete (partial as Record<string, unknown>).DATABASE_URL;
    loadConfig(baseConfigSchema, partial);
  },
  (e) =>
    e instanceof ConfigValidationError &&
    e.issues.some((i) =>
      i.path.join('.').toLowerCase().includes('database'),
    ),
);

// =====================================================
// PROBE 4 — A15: Invalid APP_ENV.
// =====================================================
expectThrow(
  'A15 invalid APP_ENV (dev2) fails',
  () => loadConfig(baseConfigSchema, { ...validProdEnv, APP_ENV: 'dev2' }),
  (e) => e instanceof ConfigValidationError,
);

// =====================================================
// PROBE 5 — A12: APP_ENV=local with no extras succeeds (defaults applied).
// =====================================================
try {
  const c = loadConfig(baseConfigSchema, { APP_ENV: 'local' }) as AppConfig;
  if (c.appEnv === 'local' && c.database.url.length > 0) {
    ok('A12 APP_ENV=local with no extras applies defaults');
  } else {
    fail('A12 APP_ENV=local with no extras applies defaults', 'no defaults populated');
  }
} catch (e) {
  fail(
    'A12 APP_ENV=local with no extras applies defaults',
    `unexpected throw: ${(e as Error).message}`,
  );
}

// =====================================================
// PROBE 6 — A18: Workspace name uniqueness + directory-key match.
// =====================================================
const repoRoot = join(import.meta.dir, '..', '..');
const workspaceRoots = ['apps', 'services', 'packages'] as const;
const seenNames = new Map<string, string>();

for (const root of workspaceRoots) {
  const rootPath = join(repoRoot, root);
  let entries: string[];
  try {
    entries = readdirSync(rootPath);
  } catch {
    continue;
  }
  for (const dir of entries) {
    const indexPath = join(rootPath, dir, 'src', 'index.ts');
    try {
      const mod = (await import(indexPath)) as { name?: string };
      const expectedKey = `${root}/${dir}`;
      if (mod.name === expectedKey) {
        if (seenNames.has(mod.name)) {
          fail(
            `A18 ${expectedKey} unique`,
            `duplicate name: also in ${seenNames.get(mod.name)}`,
          );
        } else {
          seenNames.set(mod.name, expectedKey);
          ok(`A18 ${expectedKey} name matches dir-key`);
        }
      } else {
        fail(
          `A18 ${expectedKey} name matches dir-key`,
          `expected '${expectedKey}', got '${mod.name}'`,
        );
      }
    } catch (e) {
      fail(`A18 ${root}/${dir} importable`, (e as Error).message.slice(0, 80));
    }
  }
}

// =====================================================
// Print results.
// =====================================================
console.log('=== Evaluator probe results ===');
for (const r of results) console.log(r);
console.log(`=== ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
