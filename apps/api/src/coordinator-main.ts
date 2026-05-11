// EE-1 (2026-05-12) — coordinator process entrypoint (Bug A fix).
//
// Sister process to `serve.ts`. While `serve.ts` runs the HTTP API,
// this process subscribes to the `assessment.start` queue topic and
// drives Decepticon sessions end-to-end:
//
//   API  (serve.ts)         →  writes jobs row, returns 200 quickly
//   Coord (this process)    →  picks job → runs scope.decide → invokes
//                               Decepticon runner → updates assessment
//                               state to 'completed' or 'failed'
//
// Why a separate process: real Decepticon sessions can run minutes-to-tens-
// of-minutes per scan with non-trivial CPU/memory. Inline in serve.ts the
// HTTP latency would suffer. LocalQueueAdapter uses `FOR UPDATE SKIP LOCKED`
// so multiple coordinator processes can safely share work without dupes.
//
// Usage:
//   DATABASE_URL=postgres://... bun apps/api/src/coordinator-main.ts
//
// Env vars:
//   DATABASE_URL         — required, same as serve.ts
//   DECEPTICON_ADAPTER   — 'fake' (default) | 'real'
//   DECEPTICON_API_URL   — only used when DECEPTICON_ADAPTER=real
//   COORDINATOR_QUEUE_DIR — base dir for queue metadata JSONL files
//                          (default: ./.queue-local)
//   COORDINATOR_STORAGE_DIR — base dir for object storage (OPPLAN artifacts)
//                          (default: ./.object-storage)
//   COORDINATOR_POLL_MS  — queue poll interval, default 1000ms
//   COORDINATOR_FIXTURES_DIR — fixture root for FakeDecepticonAdapter
//                          (default: ./tests/fixtures/decepticon)

import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { createDatabase } from '@cyberstrike/db';
import { selectAdapter } from '@cyberstrike/decepticon-adapter';
import { LocalObjectStorage } from '@cyberstrike/object-storage';
import { LocalQueueAdapter } from '@cyberstrike/queue';
import { createCoordinator } from '@cyberstrike/coordinator';
import { loadAuthApiConfig } from './config.ts';
import { buildScopeForAssessment } from './scope-engine/build-scope.ts';
import { createDecepticonRunner } from './scope-engine/create-decepticon-runner.ts';
import { nodeDnsResolver } from './scope-engine/dns-resolver.ts';
import { inProcessRateLimitCounter } from './scope-engine/rate-limit.ts';

const envStr = (name: string, fallback: string): string => {
  const v = (process.env as Record<string, string | undefined>)[name];
  return v && v.length > 0 ? v : fallback;
};

const envNum = (name: string, fallback: number): number => {
  const v = (process.env as Record<string, string | undefined>)[name];
  const n = v ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const ensureDir = (p: string): string => {
  mkdirSync(p, { recursive: true });
  return p;
};

const main = async (): Promise<void> => {
  const config = loadAuthApiConfig();
  const db = createDatabase({ url: config.databaseUrl });

  const queueDir = ensureDir(envStr('COORDINATOR_QUEUE_DIR', './.queue-local'));
  const storageDir = ensureDir(envStr('COORDINATOR_STORAGE_DIR', './.object-storage'));
  const fixturesDir = path.resolve(
    envStr('COORDINATOR_FIXTURES_DIR', './tests/fixtures/decepticon'),
  );
  const pollMs = envNum('COORDINATOR_POLL_MS', 1000);

  const queueAdapter = new LocalQueueAdapter({ db, baseDir: queueDir });
  const objectStorage = new LocalObjectStorage({ baseDir: storageDir });
  const decepticonAdapter = selectAdapter({
    fixturesDir,
    env: process.env as Record<string, string | undefined>,
  });

  const scopeDeps = {
    dns: nodeDnsResolver,
    clock: { now: (): Date => new Date() },
    rateLimit: inProcessRateLimitCounter,
  };

  const runner = createDecepticonRunner(decepticonAdapter, {
    db,
    objectStorage,
    queueAdapter,
    scopeDeps,
  });

  const coordinator = createCoordinator({
    db,
    adapter: queueAdapter,
    scopeDeps,
    buildScope: (id) => buildScopeForAssessment(db, id),
    decepticonRunner: runner,
    pollIntervalMs: pollMs,
  });

  coordinator.start();

  // biome-ignore lint/suspicious/noConsole: dev-runner stdout is intentional.
  console.log(
    `coordinator started — env=${config.appEnv} adapter=${envStr('DECEPTICON_ADAPTER', 'fake')} poll=${pollMs}ms`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    // biome-ignore lint/suspicious/noConsole: dev-runner stdout is intentional.
    console.log(`coordinator shutting down on ${signal}`);
    await coordinator.stop({ timeoutMs: 30_000 });
    await db.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

void main();
