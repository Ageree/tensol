// Sprint 9 — handleReconBrowser unit tests.
//
// Includes the A-BR-NavBeforeFetch probe (deny → 0 fetch calls + audit row)
// and the A-BR-RetryPolicy probes (BrowserTimeoutError → non-terminal nack;
// storage failure → non-terminal nack; ScopeDenyError → terminal nack).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalObjectStorage } from '@cyberstrike/object-storage';
import type { ObjectStorage } from '@cyberstrike/object-storage';
import type { JobEnvelope } from '@cyberstrike/queue';
import {
  type Clock,
  DEFAULT_PLATFORM_POLICY,
  type DnsResolver,
  type EffectiveScope,
  type NormalizedRule,
  type RateLimitCounter,
  type ToolPolicy,
  buildEffectiveScope,
} from '@cyberstrike/scope-engine';
import { z } from 'zod';
import { FakeBrowserDriver } from './fake-driver.ts';
import { type BrowserDriver, BrowserTimeoutError } from './types.ts';
import {
  type AuditEmitter,
  type AuditEmitterArgs,
  type BrowserWorkerDeps,
  type ObservationWriter,
  type ObservationWriterInput,
  type ReconBrowserPayload,
  handleReconBrowser,
} from './worker.ts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ASSESSMENT = '22222222-2222-2222-2222-222222222222';
const TARGET = '33333333-3333-3333-3333-333333333333';
const TRACE_ID = 'a'.repeat(32);
const JOB_ID = '44444444-4444-4444-4444-444444444444';

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });
const okRateLimit = (): RateLimitCounter => ({ consume: () => ({ ok: true }) });
const recordingDns = (table: Record<string, string[]>): DnsResolver => ({
  resolveA: async (host) => table[host] ?? [],
  resolveAAAA: async () => [],
});

const baseScope = (overrides: {
  allowRules?: NormalizedRule[];
  denyRules?: NormalizedRule[];
}): EffectiveScope => {
  const built = buildEffectiveScope({
    tenantId: TENANT,
    assessmentId: ASSESSMENT,
    tenantPolicy: { tenantId: TENANT },
    platformPolicy: DEFAULT_PLATFORM_POLICY,
    rawRules: [],
    toolCatalog: new Map<string, ToolPolicy>(),
    assessmentFlags: {
      highImpactCategories: [],
      ownershipVerifiedTargetIds: new Set(),
    },
    timeWindow: null,
  });
  return Object.freeze({
    ...built,
    allowRules: Object.freeze([...(overrides.allowRules ?? [])]) as readonly NormalizedRule[],
    denyRules: Object.freeze([...(overrides.denyRules ?? [])]) as readonly NormalizedRule[],
  });
};

const allowExampleScope = (): EffectiveScope =>
  baseScope({
    allowRules: [
      { id: 'a1', kind: 'domain', effect: 'allow', pattern: 'example.com', matchSubdomains: false },
      { id: 'a2', kind: 'ip', effect: 'allow', ip: '93.184.216.34' },
      { id: 'a3', kind: 'port', effect: 'allow', port: 443 },
      { id: 'a4', kind: 'protocol', effect: 'allow', protocol: 'https' },
      { id: 'a5', kind: 'http_method', effect: 'allow', method: 'GET' },
    ],
  });

const buildEnvelope = (payload: ReconBrowserPayload): JobEnvelope =>
  ({
    jobId: JOB_ID,
    kind: 'recon.browser',
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    assessmentId: payload.assessmentId,
    idempotencyKey: 'idem-1',
    traceId: payload.traceId,
    payload,
    publishedAt: '2026-04-29T12:00:00.000Z',
    correlationId: null,
    parentJobId: null,
  }) as unknown as JobEnvelope;

const payloadSchema: z.ZodType<ReconBrowserPayload> = z.object({
  tenantId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  assessmentId: z.string().uuid(),
  targetId: z.string().uuid(),
  startUrl: z.string().url(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
});

const buildBaseDeps = (
  overrides: Partial<BrowserWorkerDeps> = {},
): {
  deps: BrowserWorkerDeps;
  audits: AuditEmitterArgs[];
  observations: ObservationWriterInput[];
  storage: ObjectStorage;
} => {
  const audits: AuditEmitterArgs[] = [];
  const observations: ObservationWriterInput[] = [];
  const auditEmitter: AuditEmitter = async (args) => {
    audits.push(args);
  };
  const observationWriter: ObservationWriter = async (input) => {
    observations.push(input);
    return { id: `obs-${observations.length}` };
  };
  const baseDir = mkdtempSync(path.join(tmpdir(), 'cs-bw-test-'));
  const storage = new LocalObjectStorage({ baseDir });
  const deps: BrowserWorkerDeps = {
    driver: new FakeBrowserDriver({
      fetch: (async () =>
        new Response('<html><body><a href="/x">x</a></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })) as unknown as typeof globalThis.fetch,
    }),
    objectStorage: storage,
    buildScope: async () => allowExampleScope(),
    scopeDeps: {
      dns: recordingDns({ 'example.com': ['93.184.216.34'] }),
      clock: fixedClock('2026-04-29T12:00:00.000Z'),
      rateLimit: okRateLimit(),
    },
    auditEmitter,
    observationWriter,
    payloadSchema,
    ...overrides,
  };
  return { deps, audits, observations, storage };
};

const validPayload: ReconBrowserPayload = {
  tenantId: TENANT,
  projectId: null,
  assessmentId: ASSESSMENT,
  targetId: TARGET,
  startUrl: 'https://example.com/',
  traceId: TRACE_ID,
};

describe('handleReconBrowser — happy path (allow)', () => {
  test('ack + writes one observation + emits started/persisted/completed audits', async () => {
    const { deps, audits, observations } = buildBaseDeps();
    const out = await handleReconBrowser(deps, buildEnvelope(validPayload));
    expect(out.kind).toBe('ack');
    expect(observations.length).toBe(1);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('recon.browser.job.started');
    expect(actions).toContain('recon.browser.observation.persisted');
    expect(actions).toContain('recon.browser.job.completed');
    expect(actions).not.toContain('recon.browser.navigation.denied');
    expect(actions).not.toContain('recon.browser.job.failed');
  });
});

describe('handleReconBrowser — invalid payload', () => {
  test('payload schema mismatch → terminal nack, no audit', async () => {
    const { deps, audits } = buildBaseDeps();
    const env = buildEnvelope(validPayload);
    const bad = { ...env, payload: { not: 'a payload' } } as unknown as JobEnvelope;
    const out = await handleReconBrowser(deps, bad);
    expect(out.kind).toBe('nack');
    expect(out.kind === 'nack' && (out.error as { __terminal?: boolean }).__terminal).toBe(true);
    expect(audits.length).toBe(0);
  });
});

describe('handleReconBrowser — A-BR-NavBeforeFetch (TOCTOU probe)', () => {
  test('scope-deny on startUrl → 0 fetch calls + denied audit + 0 observations + terminal nack', async () => {
    let fetchCalls = 0;
    const recordingFetch = (async () => {
      fetchCalls += 1;
      return new Response('should not be reached', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const driver = new FakeBrowserDriver({ fetch: recordingFetch });

    // Replace buildScope with a scope that has NO allow rules — denies any URL.
    const denyAllScope = baseScope({
      denyRules: [
        {
          id: 'd1',
          kind: 'domain',
          effect: 'deny',
          pattern: 'example.com',
          matchSubdomains: false,
        },
      ],
      allowRules: [],
    });

    const { deps, audits, observations } = buildBaseDeps({
      driver,
      buildScope: async () => denyAllScope,
    });

    const out = await handleReconBrowser(deps, buildEnvelope(validPayload));

    expect(fetchCalls).toBe(0); // ← THE INVARIANT
    expect(out.kind).toBe('nack');
    expect(out.kind === 'nack' && (out.error as { __terminal?: boolean }).__terminal).toBe(true);
    expect(observations.length).toBe(0);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('recon.browser.navigation.denied');
    expect(actions).not.toContain('recon.browser.observation.persisted');
  });
});

describe('handleReconBrowser — A-BR-RetryPolicy (transient)', () => {
  test('BrowserTimeoutError on launch → non-terminal nack', async () => {
    const driver: BrowserDriver = {
      launch: async () => {
        throw new BrowserTimeoutError('boom');
      },
      navigate: async () => {
        throw new Error('unreachable');
      },
      close: async () => undefined,
    };
    const { deps, audits, observations } = buildBaseDeps({ driver });
    const out = await handleReconBrowser(deps, buildEnvelope(validPayload));
    expect(out.kind).toBe('nack');
    expect(out.kind === 'nack' && (out.error as { __terminal?: boolean }).__terminal).toBeFalsy();
    expect(out.kind === 'nack' && out.error).toBeInstanceOf(BrowserTimeoutError);
    expect(observations.length).toBe(0);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('recon.browser.job.started');
    expect(actions).toContain('recon.browser.job.failed');
  });

  test('objectStorage.put throws → nack with StorageWriteError (queue-classifier transient)', async () => {
    const failingStorage: ObjectStorage = {
      put: async () => {
        throw new Error('disk_full');
      },
      get: async () => Buffer.from(''),
    };
    const { deps, audits, observations } = buildBaseDeps({ objectStorage: failingStorage });
    const out = await handleReconBrowser(deps, buildEnvelope(validPayload));
    expect(out.kind).toBe('nack');
    expect(out.kind === 'nack' && (out.error as { __terminal?: boolean }).__terminal).toBeFalsy();
    // codex iter-2 P1 — error name MUST be the queue-classifier transient
    // sentinel so decideRetry maps it to 'transient' instead of defaulting
    // to terminal.
    expect(out.kind === 'nack' && out.error.name).toBe('StorageWriteError');
    expect(observations.length).toBe(0);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('recon.browser.job.failed');
  });

  test('observationWriter throws → nack with DbTransientError (queue-classifier transient)', async () => {
    const observationWriter: ObservationWriter = async () => {
      throw new Error('db_conn_lost');
    };
    const { deps } = buildBaseDeps({ observationWriter });
    const out = await handleReconBrowser(deps, buildEnvelope(validPayload));
    expect(out.kind).toBe('nack');
    expect(out.kind === 'nack' && (out.error as { __terminal?: boolean }).__terminal).toBeFalsy();
    expect(out.kind === 'nack' && out.error.name).toBe('DbTransientError');
  });
});

describe('handleReconBrowser — assessment scope unavailable', () => {
  test('buildScope returns null → terminal nack with assessment_not_found', async () => {
    const { deps, audits } = buildBaseDeps({ buildScope: async () => null });
    const out = await handleReconBrowser(deps, buildEnvelope(validPayload));
    expect(out.kind).toBe('nack');
    expect(out.kind === 'nack' && (out.error as { __terminal?: boolean }).__terminal).toBe(true);
    expect(audits.length).toBe(0);
  });
});
