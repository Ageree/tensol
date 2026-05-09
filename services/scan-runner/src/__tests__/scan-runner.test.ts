import { describe, expect, it, mock } from 'bun:test';
import { buildCloudInit } from '../cloud-init.ts';
import { createScanRunner } from '../scan-runner.ts';
import { type HetznerClient, ScanError, type ScanRequest } from '../types.ts';
import { buildUserAgent } from '../user-agent.ts';

const baseReq: ScanRequest = {
  scanId: '550e8400-e29b-41d4-a716-446655440000',
  tenantId: 'tenant-abc',
  targetUrl: 'https://example.com',
  serverType: 'cpx21',
  location: 'fsn1',
  imageId: 9876,
  callbackUrl: 'https://tensol.io/callbacks/scans/550e8400',
  callbackToken: 'tok-secret',
  maxRuntimeMs: 1_800_000,
};

const makeServer = (id = 42, status: 'initializing' | 'running' = 'running') => ({
  id,
  status,
  publicNet: { ipv4: { ip: '1.2.3.4' } },
  created: '2026-05-09T00:00:00Z',
});

const makeAction = () => ({
  id: 1,
  command: 'delete_server',
  status: 'success' as const,
});

const noop = () => {};

const makeHetzner = (overrides: Partial<HetznerClient> = {}): HetznerClient => ({
  createServer: mock(async () => ({
    server: makeServer(),
    action: { id: 10, command: 'create_server', status: 'running' as const },
  })),
  getServer: mock(async () => makeServer()),
  deleteServer: mock(async () => makeAction()),
  getActions: mock(async () => []),
  ...overrides,
});

const makeAwaitCallback = (result: { logs: string } = { logs: 'scan done' }) =>
  mock(async (_scanId: string, _signal: AbortSignal) => result);

const makeRunner = (
  hetzner: HetznerClient,
  overrides: {
    callbackTimeoutMs?: number;
    readyTimeoutMs?: number;
    pollIntervalMs?: number;
    awaitCallback?: (scanId: string, signal: AbortSignal) => Promise<{ logs: string }>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
) =>
  createScanRunner({
    hetzner,
    buildCloudInit,
    buildUserAgent,
    awaitCallback: overrides.awaitCallback ?? makeAwaitCallback(),
    callbackTimeoutMs: overrides.callbackTimeoutMs ?? 5_000,
    readyTimeoutMs: overrides.readyTimeoutMs ?? 5_000,
    pollIntervalMs: overrides.pollIntervalMs ?? 10,
    sleep: overrides.sleep ?? (async () => {}),
    now: overrides.now,
    logger: { info: noop, warn: noop, error: noop },
  });

describe('createScanRunner', () => {
  it('T1 — happy path: full lifecycle completes, deleteServer called once', async () => {
    const hetzner = makeHetzner();
    const runner = makeRunner(hetzner);
    const result = await runner.runScan(baseReq);

    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
    expect(hetzner.getServer).toHaveBeenCalledTimes(1);
    expect(hetzner.deleteServer).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('completed');
    expect(result.scanId).toBe(baseReq.scanId);
    expect(result.logs).toBe('scan done');
  });

  it('T2 — createServer rejects (4xx): throws ScanError{code:create_failed}, deleteServer NEVER called', async () => {
    const hetzner = makeHetzner({
      createServer: mock(async () => {
        throw new ScanError({ code: 'invalid_request', message: '422' });
      }),
    });
    const runner = makeRunner(hetzner);

    await expect(runner.runScan(baseReq)).rejects.toMatchObject({ code: 'create_failed' });
    expect(hetzner.deleteServer).toHaveBeenCalledTimes(0);
  });

  it('T3 — server stuck initializing past readyTimeoutMs: throws ready_timeout, deleteServer called once', async () => {
    let tick = 0;
    const hetzner = makeHetzner({
      getServer: mock(async () => makeServer(42, 'initializing')),
    });
    const runner = makeRunner(hetzner, {
      readyTimeoutMs: 10,
      pollIntervalMs: 1,
      now: () => {
        tick += 100;
        return tick;
      },
    });

    await expect(runner.runScan(baseReq)).rejects.toMatchObject({ code: 'ready_timeout' });
    expect(hetzner.deleteServer).toHaveBeenCalledTimes(1);
    expect(hetzner.deleteServer).toHaveBeenCalledWith(42);
  });

  it('T4 — awaitCallback never resolves before callbackTimeoutMs: throws callback_timeout, deleteServer called once', async () => {
    const hetzner = makeHetzner();
    const awaitCallback = mock(
      (_scanId: string, signal: AbortSignal) =>
        new Promise<{ logs: string }>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const runner = makeRunner(hetzner, { awaitCallback, callbackTimeoutMs: 10 });

    await expect(runner.runScan(baseReq)).rejects.toMatchObject({ code: 'callback_timeout' });
    expect(hetzner.deleteServer).toHaveBeenCalledTimes(1);
    expect(hetzner.deleteServer).toHaveBeenCalledWith(42);
  });

  it('T5 — awaitCallback resolves, deleteServer rejects: returns outcome:destroy_failed (NOT throws)', async () => {
    const hetzner = makeHetzner({
      deleteServer: mock(async () => {
        throw new Error('cannot delete');
      }),
    });
    const runner = makeRunner(hetzner);

    const result = await runner.runScan(baseReq);
    expect(result.outcome).toBe('destroy_failed');
    expect(hetzner.deleteServer).toHaveBeenCalledTimes(1);
  });

  it('T6 — maxRuntimeMs=0 rejected by zod, no Hetzner calls made', async () => {
    const hetzner = makeHetzner();
    const runner = makeRunner(hetzner);

    await expect(runner.runScan({ ...baseReq, maxRuntimeMs: 0 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(hetzner.createServer).toHaveBeenCalledTimes(0);
  });

  it('T7 — two concurrent runScan() calls with different scanIds: no shared state leak', async () => {
    const hetzner1 = makeHetzner({
      createServer: mock(async () => ({
        server: makeServer(1),
        action: { id: 10, command: 'create_server', status: 'running' as const },
      })),
    });
    const hetzner2 = makeHetzner({
      createServer: mock(async () => ({
        server: makeServer(2),
        action: { id: 11, command: 'create_server', status: 'running' as const },
      })),
    });

    const runner1 = makeRunner(hetzner1);
    const runner2 = makeRunner(hetzner2);

    const [r1, r2] = await Promise.all([
      runner1.runScan({ ...baseReq, scanId: 'scan-aaa' }),
      runner2.runScan({ ...baseReq, scanId: 'scan-bbb' }),
    ]);

    expect(r1.scanId).toBe('scan-aaa');
    expect(r2.scanId).toBe('scan-bbb');
    expect(hetzner1.deleteServer).toHaveBeenCalledWith(1);
    expect(hetzner2.deleteServer).toHaveBeenCalledWith(2);
  });

  it('T8 — Hetzner 5xx on createServer: propagates raw Error, deleteServer NOT called', async () => {
    const hetzner = makeHetzner({
      createServer: mock(async () => {
        throw new Error('Service unavailable');
      }),
    });
    const runner = makeRunner(hetzner);

    const err = await runner.runScan(baseReq).catch((e: unknown) => e);
    // create_failed wraps the raw error
    expect(err).toBeInstanceOf(ScanError);
    expect((err as ScanError).code).toBe('create_failed');
    expect(hetzner.deleteServer).toHaveBeenCalledTimes(0);
  });

  it('T9 — User-Agent propagation: createServer payload userData contains scanId-derived UA', async () => {
    let capturedUserData: string | undefined;
    const hetzner = makeHetzner({
      createServer: mock(async (opts) => {
        capturedUserData = opts.userData;
        return {
          server: makeServer(),
          action: { id: 10, command: 'create_server', status: 'running' as const },
        };
      }),
    });
    const runner = makeRunner(hetzner);
    await runner.runScan(baseReq);

    expect(capturedUserData).toBeDefined();
    expect(capturedUserData).toContain(`Tensol-Scan/${baseReq.scanId}`);
  });
});
