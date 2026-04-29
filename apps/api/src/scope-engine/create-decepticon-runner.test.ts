// Sprint 13 codex P1-B — DECEPTICON_ADAPTER env switch wires the correct
// adapter through createDecepticonRunner.
//
// Asserts:
//   - DECEPTICON_ADAPTER=real  → runner backed by RealDecepticonAdapter
//   - DECEPTICON_ADAPTER=fake (or unset) → runner backed by FakeDecepticonAdapter
//
// This test validates the wiring contract documented in create-decepticon-runner.ts:
//   const adapter = selectAdapter({ fixturesDir, env: process.env });
//   const runner = createDecepticonRunner(adapter, { db, objectStorage, queueAdapter });
//   createCoordinator({ ..., decepticonRunner: runner });

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FakeDecepticonAdapter,
  RealDecepticonAdapter,
  selectAdapter,
} from '@cyberstrike/decepticon-adapter';
import { createDecepticonRunner } from './create-decepticon-runner.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, '..', '..', '..', '..', 'tests', 'fixtures', 'decepticon');

// ============================================================================
// Minimal stubs — no real DB/storage/queue needed for adapter wiring tests
// ============================================================================

// biome-ignore lint/suspicious/noExplicitAny: stub for unit test
const stubDb: any = {};
// biome-ignore lint/suspicious/noExplicitAny: stub for unit test
const stubStorage: any = { put: async () => ({ key: 'k', sha256: 's', sizeBytes: 0 }) };

// biome-ignore lint/suspicious/noExplicitAny: stub for unit test
const stubQueue: any = { publish: async () => ({ deduped: false, jobId: 'j' }) };

describe('createDecepticonRunner — DECEPTICON_ADAPTER env wiring (P1-B)', () => {
  test('DECEPTICON_ADAPTER=fake selects FakeDecepticonAdapter', () => {
    const adapter = selectAdapter({
      env: { DECEPTICON_ADAPTER: 'fake' },
      fixturesDir: FIXTURES_DIR,
    });
    expect(adapter).toBeInstanceOf(FakeDecepticonAdapter);

    // createDecepticonRunner should accept a FakeDecepticonAdapter without error.
    const runner = createDecepticonRunner(adapter, {
      db: stubDb,
      objectStorage: stubStorage,
      queueAdapter: stubQueue,
    });
    expect(typeof runner).toBe('function');
  });

  test('DECEPTICON_ADAPTER unset defaults to FakeDecepticonAdapter', () => {
    const adapter = selectAdapter({
      env: {},
      fixturesDir: FIXTURES_DIR,
    });
    expect(adapter).toBeInstanceOf(FakeDecepticonAdapter);

    const runner = createDecepticonRunner(adapter, {
      db: stubDb,
      objectStorage: stubStorage,
      queueAdapter: stubQueue,
    });
    expect(typeof runner).toBe('function');
  });

  test('DECEPTICON_ADAPTER=real selects RealDecepticonAdapter', () => {
    const adapter = selectAdapter({
      env: { DECEPTICON_ADAPTER: 'real' },
      fixturesDir: FIXTURES_DIR,
    });
    expect(adapter).toBeInstanceOf(RealDecepticonAdapter);

    // createDecepticonRunner should accept a RealDecepticonAdapter without error.
    const runner = createDecepticonRunner(adapter, {
      db: stubDb,
      objectStorage: stubStorage,
      queueAdapter: stubQueue,
    });
    expect(typeof runner).toBe('function');
  });

  test('invalid DECEPTICON_ADAPTER value throws at selectAdapter', () => {
    expect(() =>
      selectAdapter({
        env: { DECEPTICON_ADAPTER: 'unknown_engine' },
        fixturesDir: FIXTURES_DIR,
      }),
    ).toThrow(/invalid_decepticon_adapter_env/);
  });
});
