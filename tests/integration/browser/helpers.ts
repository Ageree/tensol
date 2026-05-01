// Sprint 9 — shared helpers for tests/integration/browser/.
//
// Wires the in-process browser-worker handler with the real emitAudit +
// observations-browser repo + LocalObjectStorage. Lab fixture lifecycle
// helpers (start/stop/getCounters) round out the harness.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emitAudit } from '@cyberstrike/audit';
import {
  type AuditEmitter,
  type AuditEmitterArgs,
  FakeBrowserDriver,
  type FakeBrowserDriverDeps,
  type ObservationWriter,
  type ReconBrowserPayload,
  reconBrowserPayloadSchema,
} from '@cyberstrike/coordinator/browser';
import type { Database } from '@cyberstrike/db';
import { insertObservationBrowser } from '@cyberstrike/db';
import { LocalObjectStorage } from '@cyberstrike/object-storage';
import type { Kysely } from 'kysely';
import { type XssLabHandle, startXssLab } from '../../lab/xss-fixture/index.ts';

/**
 * Stub scope deps — resolves localhost (lab) to a public IP so the
 * scope-engine's fail-closed loopback guard does not deny legitimate
 * navigations to the lab fixture. The lab listens on a different port
 * than the assessment scope rule references, so we re-map the resolved
 * IP to a non-private value.
 */
export const stubBrowserScopeDeps = {
  dns: {
    resolveA: async (host: string): Promise<string[]> => {
      if (host === 'localhost') return ['203.0.113.7']; // documentation IP
      if (host === 'evil.example') return ['198.51.100.7'];
      return [];
    },
    resolveAAAA: async (): Promise<string[]> => [],
  },
  clock: { now: (): Date => new Date() },
  rateLimit: {
    consume: async (): Promise<{ ok: true; retryAfterMs: number }> => ({
      ok: true,
      retryAfterMs: 0,
    }),
  },
};

export const allowLocalhostLabScopeRules = (port: number): unknown[] => [
  {
    ruleKind: 'domain',
    effect: 'allow' as const,
    payload: { pattern: 'localhost', matchSubdomains: false },
  },
  {
    ruleKind: 'ip',
    effect: 'allow' as const,
    payload: { ip: '203.0.113.7' },
  },
  {
    ruleKind: 'protocol',
    effect: 'allow' as const,
    payload: { protocol: 'http' },
  },
  {
    ruleKind: 'port',
    effect: 'allow' as const,
    payload: { port },
  },
  {
    ruleKind: 'http_method',
    effect: 'allow' as const,
    payload: { method: 'GET' },
  },
];

export const buildLocalStorage = (): {
  storage: LocalObjectStorage;
  baseDir: string;
} => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'cs-bw-it-'));
  return { storage: new LocalObjectStorage({ baseDir }), baseDir };
};

export const buildAuditEmitter = (db: Kysely<Database>): AuditEmitter => {
  return async (args: AuditEmitterArgs): Promise<void> => {
    await emitAudit({ db }, args);
  };
};

export const buildObservationWriter = (db: Kysely<Database>): ObservationWriter => {
  return async (input) => {
    return insertObservationBrowser(db, input);
  };
};

export const buildBrowserHandlerDeps = (input: {
  db: Kysely<Database>;
  storage: LocalObjectStorage;
  buildScope: (assessmentId: string) => Promise<unknown>;
  driverDeps?: FakeBrowserDriverDeps;
  recordingFetch?: typeof globalThis.fetch;
}) => ({
  driver: new FakeBrowserDriver({
    ...(input.driverDeps ?? {}),
    ...(input.recordingFetch ? { fetch: input.recordingFetch } : {}),
  }),
  objectStorage: input.storage,
  buildScope: input.buildScope as (assessmentId: string) => Promise<never>,
  scopeDeps: stubBrowserScopeDeps,
  auditEmitter: buildAuditEmitter(input.db),
  observationWriter: buildObservationWriter(input.db),
  payloadSchema: reconBrowserPayloadSchema,
});

const _validatePayloadShape = (p: unknown): ReconBrowserPayload =>
  reconBrowserPayloadSchema.parse(p);

interface LabHarness {
  readonly handle: XssLabHandle;
  readonly origin: string;
  readonly port: number;
}

export const withLab = async <T>(fn: (lab: LabHarness) => Promise<T>): Promise<T> => {
  const handle = await startXssLab(0);
  try {
    return await fn({ handle, origin: handle.origin, port: handle.port });
  } finally {
    await handle.stop();
  }
};

export const uniqUuid = (): string => crypto.randomUUID();
