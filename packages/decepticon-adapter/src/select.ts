// Sprint 8 — adapter selector keyed off env DECEPTICON_ADAPTER.
//
// Default: fake. Unknown values throw (fail-fast — better than silent fall-
// back to real and a rejection storm).

import { type FakeAdapterDeps, FakeDecepticonAdapter } from './fake.ts';
import { createFsFixtureLoader } from './fixture-loader.ts';
import { RealDecepticonAdapter } from './real.ts';
import { ADAPTER_KINDS, type AdapterKind, type DecepticonAdapter } from './types.ts';

export interface SelectAdapterDeps {
  readonly env?: Record<string, string | undefined>;
  readonly fixturesDir: string;
  /** Test seam — overrides for FakeAdapterDeps. */
  readonly fakeOverrides?: Partial<FakeAdapterDeps>;
}

export const resolveAdapterKind = (
  env: Record<string, string | undefined> | undefined,
): AdapterKind => {
  // Property access on Record<string, unknown> hits both
  // tsc/noPropertyAccessFromIndexSignature and biome/useLiteralKeys; cast to
  // a typed alias before reading.
  const e = (env ?? {}) as { DECEPTICON_ADAPTER?: string };
  const raw = e.DECEPTICON_ADAPTER;
  if (raw === undefined || raw === '') return 'fake';
  if ((ADAPTER_KINDS as readonly string[]).includes(raw)) {
    return raw as AdapterKind;
  }
  throw new Error(`invalid_decepticon_adapter_env:${raw}`);
};

export const selectAdapter = (deps: SelectAdapterDeps): DecepticonAdapter => {
  const kind = resolveAdapterKind(deps.env ?? globalProcessEnv());
  if (kind === 'real') return new RealDecepticonAdapter();
  const loader = createFsFixtureLoader({ fixturesDir: deps.fixturesDir });
  return new FakeDecepticonAdapter({
    loader,
    ...(deps.fakeOverrides ?? {}),
  });
};

const globalProcessEnv = (): Record<string, string | undefined> => {
  // Bun + Node both expose process.env; guard for unusual environments.
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
};
