// Sprint 12 — RealDecepticonAdapter exercised via injected mock LangGraph client.
//
// Real Decepticon engine isn't running in CI. We feed a recorded SSE stream
// through the clientFactory injection point and assert that:
//   - threads.create is called with our metadata
//   - subagent_start events map to phase StatusEvents
//   - subagent_tool_result with tool='report_finding' becomes a CandidateFinding
//   - end-of-stream emits 'completed'
//   - stop() cancels the run and closes streams

import { describe, expect, test } from 'bun:test';
import type { Thread } from '@langchain/langgraph-sdk';
import { type DecepticonClient, RealDecepticonAdapter, type StreamChunk } from './real.ts';
import type { CandidateFinding, StatusEvent } from './types.ts';

const buildOpplan = () => ({
  assessmentId: '11111111-1111-1111-1111-111111111111',
  targets: ['http://example.com/'],
  authorizedScope: [],
  exclusions: [],
  testingWindow: { start: null, end: null },
  allowedTools: [],
  unavailableTools: [],
  engagementProfile: 'recon-only',
  foothold: false,
  postExploit: false,
  c2: false,
  ad: false,
});

const buildClient = (chunks: StreamChunk[]): DecepticonClient => {
  const cancelCalls: Array<{ threadId: string; runId: string }> = [];
  const createCalls: Array<{ metadata?: Record<string, unknown> }> = [];

  const client: DecepticonClient & {
    _cancelCalls: typeof cancelCalls;
    _createCalls: typeof createCalls;
  } = {
    threads: {
      create(args) {
        createCalls.push(args);
        return Promise.resolve({
          thread_id: 'mock-thread-1',
        } as unknown as Thread);
      },
    },
    runs: {
      stream(_threadId, _assistantId) {
        const generator = async function* (): AsyncGenerator<StreamChunk> {
          for (const c of chunks) {
            await Promise.resolve();
            yield c;
          }
        };
        return generator();
      },
      cancel(threadId, runId) {
        cancelCalls.push({ threadId, runId });
        return Promise.resolve();
      },
    },
    _cancelCalls: cancelCalls,
    _createCalls: createCalls,
  };
  return client;
};

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
};

describe('RealDecepticonAdapter — integration with mock LangGraph client', () => {
  test('start creates thread with cyberstrike metadata + emits started event', async () => {
    const client = buildClient([{ event: 'end', data: {} }]);
    const adapter = new RealDecepticonAdapter({
      clientFactory: () => client,
    });

    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });

    const createCalls = (
      client as DecepticonClient & {
        _createCalls: Array<{ metadata?: Record<string, unknown> }>;
      }
    )._createCalls;
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.metadata).toEqual({
      cyberstrike_assessment_id: '11111111-1111-1111-1111-111111111111',
      cyberstrike_tenant_id: 'tenant-a',
    });
    expect(handle.tenantId).toBe('tenant-a');
    expect(handle.assessmentId).toBe('11111111-1111-1111-1111-111111111111');
    expect(handle.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('subagent_start events map to phase StatusEvents + final completed', async () => {
    const client = buildClient([
      { event: 'metadata', data: { run_id: 'run-1' } },
      { event: 'custom', data: { type: 'subagent_start', agent: 'recon' } },
      { event: 'custom', data: { type: 'subagent_start', agent: 'exploit' } },
      { event: 'custom', data: { type: 'subagent_start', agent: 'analyst' } },
      { event: 'end', data: {} },
    ]);
    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });

    const events: StatusEvent[] = await collect(adapter.streamStatus(handle.sessionId));
    const statuses = events.map((e) => e.status);

    // started (initial) + recon + exploit + reporting (analyst) + completed (end-of-stream).
    expect(statuses).toEqual(['started', 'recon', 'exploit', 'reporting', 'completed']);
  });

  test('subagent_tool_result with report_finding becomes CandidateFinding', async () => {
    const findingPayload = {
      type: 'xss_reflected',
      severity: 'high',
      affectedUrl: 'http://example.com/search?q=test',
      reproduction: { method: 'GET', payload: '<script>alert(1)</script>' },
    };
    const client = buildClient([
      {
        event: 'custom',
        data: {
          type: 'subagent_tool_result',
          agent: 'detector',
          tool: 'report_finding',
          content: JSON.stringify(findingPayload),
        },
      },
      { event: 'end', data: {} },
    ]);
    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });

    const candidates: CandidateFinding[] = await collect(
      adapter.streamCandidates(handle.sessionId),
    );

    expect(candidates).toHaveLength(1);
    const cand = candidates[0];
    if (!cand) throw new Error('candidate missing');
    expect(cand.type).toBe('xss_reflected');
    expect(cand.severity).toBe('high');
    expect(cand.affectedUrl).toBe('http://example.com/search?q=test');
    expect(cand.source).toBe('decepticon.detector');
    expect(cand.payload.reproduction).toEqual({
      method: 'GET',
      payload: '<script>alert(1)</script>',
    });
  });

  test('malformed report_finding content is dropped (not parsed as candidate)', async () => {
    const client = buildClient([
      {
        event: 'custom',
        data: {
          type: 'subagent_tool_result',
          agent: 'detector',
          tool: 'report_finding',
          content: 'not-json',
        },
      },
      {
        event: 'custom',
        data: {
          type: 'subagent_tool_result',
          agent: 'detector',
          tool: 'report_finding',
          content: JSON.stringify({ type: 'xss_reflected' }), // missing severity + url
        },
      },
      { event: 'end', data: {} },
    ]);
    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });

    const candidates = await collect(adapter.streamCandidates(handle.sessionId));
    expect(candidates).toHaveLength(0);
  });

  test('subagent_end with error emits failed status', async () => {
    const client = buildClient([
      {
        event: 'custom',
        data: { type: 'subagent_end', agent: 'recon', error: true, content: 'tool_blew_up' },
      },
      { event: 'end', data: {} },
    ]);
    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });

    const events = await collect(adapter.streamStatus(handle.sessionId));
    const statuses = events.map((e) => e.status);

    // started + failed (no completed because finalStatus pinned to failed).
    expect(statuses).toContain('failed');
    expect(statuses).not.toContain('completed');
    const failed = events.find((e) => e.status === 'failed');
    expect(failed?.detail).toEqual({ reason: 'tool_blew_up' });
  });

  test('error event emits failed status with serialized payload', async () => {
    const client = buildClient([
      { event: 'error', data: { code: 500, message: 'upstream blew up' } },
      { event: 'end', data: {} },
    ]);
    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });

    const events = await collect(adapter.streamStatus(handle.sessionId));
    const failed = events.find((e) => e.status === 'failed');
    expect(failed).toBeDefined();
    expect(typeof failed?.detail?.reason).toBe('string');
  });

  test('stop cancels the run and closes streams', async () => {
    // Hanging stream — emits metadata then awaits an unresolved promise
    // until the abort signal fires.
    const client: DecepticonClient = {
      threads: {
        create() {
          return Promise.resolve({ thread_id: 'mock-thread-stop' } as unknown as Thread);
        },
      },
      runs: {
        async *stream(_threadId, _assistantId, args) {
          yield { event: 'metadata', data: { run_id: 'run-stop' } };
          // Await abort signal — never yields more chunks unless aborted.
          await new Promise<void>((resolve) => {
            args.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        },
        cancel() {
          return Promise.resolve();
        },
      },
    };
    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });

    // Let metadata chunk dispatch so runId is set.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await adapter.stop(handle.sessionId);

    const events = await collect(adapter.streamStatus(handle.sessionId));
    const lastFailed = [...events].reverse().find((e) => e.status === 'failed');
    expect(lastFailed?.detail?.reason).toBe('cancelled_by_caller');
  });

  test('streamStatus on unknown sessionId throws', () => {
    const adapter = new RealDecepticonAdapter({ clientFactory: () => buildClient([]) });
    expect(() => adapter.streamStatus('nope')).toThrow(/Unknown session/);
  });

  test('exportArtifacts returns empty array (Sprint 12 MVP)', async () => {
    const client = buildClient([{ event: 'end', data: {} }]);
    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });

    const artifacts = await adapter.exportArtifacts(handle.sessionId);
    expect(artifacts).toEqual([]);
  });
});
