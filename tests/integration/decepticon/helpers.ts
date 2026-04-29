// Sprint 8 — shared helpers for tests/integration/decepticon/.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type FakeAdapterDeps,
  FakeDecepticonAdapter,
  createFsFixtureLoader,
} from '@cyberstrike/decepticon-adapter';
import { LocalObjectStorage } from '@cyberstrike/object-storage';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, '..', '..', 'fixtures', 'decepticon');

/**
 * Stub scope deps for IT. Resolves `example.com` to a public IP so the
 * scope-engine's private-IP / loopback fail-closed guard does not deny
 * legitimate test allow-rules. Use `example.com` as the assessment target
 * value in fixtures rather than `localhost` (Sprint 9 lab will pin
 * `localhost:9999` once the lab fixture exists).
 */
export const stubScopeDeps = {
  dns: {
    resolveA: async (host: string) => {
      if (host === 'example.com') return ['93.184.216.34'];
      return [];
    },
    resolveAAAA: async () => [],
  },
  clock: { now: (): Date => new Date() },
  rateLimit: {
    consume: async () => ({ ok: true, retryAfterMs: 0 }),
  },
};

/** Helper: scope-rule set that allows `https://example.com/` end-to-end. */
export const allowExampleComScopeRules = [
  {
    ruleKind: 'domain',
    effect: 'allow' as const,
    payload: { pattern: 'example.com', matchSubdomains: false },
  },
  {
    ruleKind: 'ip',
    effect: 'allow' as const,
    payload: { ip: '93.184.216.34' },
  },
  {
    ruleKind: 'protocol',
    effect: 'allow' as const,
    payload: { protocol: 'https' },
  },
  {
    ruleKind: 'port',
    effect: 'allow' as const,
    payload: { port: 443 },
  },
  {
    ruleKind: 'http_method',
    effect: 'allow' as const,
    payload: { method: 'GET' },
  },
];

export const buildFakeAdapter = (overrides?: Partial<FakeAdapterDeps>): FakeDecepticonAdapter => {
  const loader = createFsFixtureLoader({ fixturesDir: FIXTURES_DIR });
  return new FakeDecepticonAdapter({
    loader,
    sleep: (): Promise<void> => Promise.resolve(),
    ...(overrides ?? {}),
  });
};

export const buildLocalObjectStorage = (): {
  storage: LocalObjectStorage;
  baseDir: string;
} => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'cs-objstore-it-'));
  return { storage: new LocalObjectStorage({ baseDir }), baseDir };
};

export const uniqUuid = (): string => crypto.randomUUID();
