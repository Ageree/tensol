// Sprint 7 §5.4 A-Q-Coord-1 (F2) — createCoordinator factory unit test.
//
// Verifies that start() subscribes to `assessment.start` queue,
// and that stop() drains cleanly.

import { describe, expect, test } from 'bun:test';
import type {
  EnvelopeKind,
  Handler,
  PublishResult,
  QueueAdapter,
  Subscription,
} from '@cyberstrike/queue';
import type { EffectiveScope } from '@cyberstrike/scope-engine';
import { createCoordinator } from './index.ts';

interface SubscribeCall {
  readonly queue: EnvelopeKind;
  readonly handler: Handler;
}

const stubAdapter = (): {
  adapter: QueueAdapter;
  calls: SubscribeCall[];
  stopped: number;
} => {
  const calls: SubscribeCall[] = [];
  let stopped = 0;
  const adapter: QueueAdapter = {
    publish: async (): Promise<PublishResult> => ({ deduped: false, jobId: 'stub' }),
    subscribe: (queueName, handler): Subscription => {
      calls.push({ queue: queueName, handler });
      return {
        stop: async (): Promise<void> => {
          stopped += 1;
        },
      };
    },
    ack: async (): Promise<void> => {},
    nack: async (): Promise<void> => {},
  };
  return {
    adapter,
    calls,
    get stopped() {
      return stopped;
    },
  };
};

const stubScopeDeps = {
  dns: {
    resolveA: async (): Promise<string[]> => [],
    resolveAAAA: async (): Promise<string[]> => [],
  },
  clock: { now: (): Date => new Date() },
  rateLimit: {
    consume: async (): Promise<{ ok: boolean; retryAfterMs: number }> => ({
      ok: true,
      retryAfterMs: 0,
    }),
  },
};

describe('createCoordinator factory (A-Q-Coord-1)', () => {
  test('start() subscribes to assessment.start queue; stop() drains cleanly', async () => {
    const { adapter, calls } = stubAdapter();
    const coord = createCoordinator({
      // biome-ignore lint/suspicious/noExplicitAny: stub DB for unit test
      db: {} as any,
      adapter,
      scopeDeps: stubScopeDeps,
      buildScope: async (): Promise<EffectiveScope | null> => null,
      pollIntervalMs: 100,
    });

    coord.start();

    const queueNames = calls.map((c) => c.queue).sort();
    expect(queueNames).toEqual(['assessment.start']);
    expect(calls.length).toBe(1);

    await coord.stop({ timeoutMs: 50 });
  });

  test('start() can run twice without throwing; stop() resolves either way', async () => {
    const { adapter } = stubAdapter();
    const coord = createCoordinator({
      // biome-ignore lint/suspicious/noExplicitAny: stub DB for unit test
      db: {} as any,
      adapter,
      scopeDeps: stubScopeDeps,
      buildScope: async (): Promise<EffectiveScope | null> => null,
    });

    coord.start();
    coord.start(); // second start replaces subs (last-writer-wins is OK for tests)
    await coord.stop({ timeoutMs: 10 });
    // The first call should not throw; the second start replaces handles, and
    // stop() awaits whichever pair is current.
    expect(true).toBe(true);
  });

  test('stop() before start() is a safe no-op', async () => {
    const { adapter } = stubAdapter();
    const coord = createCoordinator({
      // biome-ignore lint/suspicious/noExplicitAny: stub DB for unit test
      db: {} as any,
      adapter,
      scopeDeps: stubScopeDeps,
      buildScope: async (): Promise<EffectiveScope | null> => null,
    });

    await coord.stop();
    expect(true).toBe(true);
  });

  test('passes pollIntervalMs and tenantFilter through to adapter.subscribe', async () => {
    const { adapter, calls } = stubAdapter();
    let capturedOpts: Record<string, unknown> | undefined;
    const captured = {
      ...adapter,
      subscribe: (queueName: EnvelopeKind, handler: Handler, opts?: unknown): Subscription => {
        capturedOpts = (opts as Record<string, unknown>) ?? {};
        calls.push({ queue: queueName, handler });
        return { stop: async (): Promise<void> => {} };
      },
    };
    const coord = createCoordinator({
      // biome-ignore lint/suspicious/noExplicitAny: stub DB for unit test
      db: {} as any,
      adapter: captured,
      scopeDeps: stubScopeDeps,
      buildScope: async (): Promise<EffectiveScope | null> => null,
      pollIntervalMs: 250,
      tenantFilter: '11111111-1111-1111-1111-111111111111',
    });
    coord.start();
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts?.pollIntervalMs).toBe(250);
    expect(capturedOpts?.tenantId).toBe('11111111-1111-1111-1111-111111111111');
    await coord.stop({ timeoutMs: 10 });
  });
});
