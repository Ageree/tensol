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
      get(_threadId) {
        // 2026-05-12 — HITL state-machine reads thread state to detect proposal-await.
        // Tests use a stream-end heuristic; return idle thread w/ empty messages so the
        // auto-approval loop short-circuits (no awaiting → exit).
        return Promise.resolve({
          thread_id: 'mock-thread-1',
          status: 'idle',
          values: { messages: [] },
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
        get() {
          return Promise.resolve({
            thread_id: 'mock-thread-stop',
            status: 'idle',
            values: { messages: [] },
          } as unknown as Thread);
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

// ============================================================================
// EE-3 HITL state-machine (2026-05-12) — auto-approve fires when Decepticon
// returns an "OPPLAN Proposal" AI message and stops; loop sends an approval
// reply via runs.stream on the same thread, then drains the second stream.
// ============================================================================

describe('RealDecepticonAdapter :: HITL auto-approval state-machine', () => {
  test('detects OPPLAN Proposal in thread.values, fires approval reply on second turn', async () => {
    const streamCalls: Array<{ input: unknown }> = [];
    const threadGetCallCount = { n: 0 };
    let proposalDelivered = false;

    const client: DecepticonClient = {
      threads: {
        create() {
          return Promise.resolve({ thread_id: 'thread-hitl' } as unknown as Thread);
        },
        get(_id) {
          threadGetCallCount.n += 1;
          // First poll (after turn 1): proposal pending, awaiting human reply.
          if (!proposalDelivered) {
            proposalDelivered = true;
            return Promise.resolve({
              thread_id: 'thread-hitl',
              status: 'idle',
              values: {
                messages: [
                  { type: 'human', content: 'OPPLAN ...' },
                  {
                    type: 'ai',
                    name: 'decepticon',
                    content:
                      '## OPPLAN Proposal — review the plan and approve to proceed with execution.',
                    tool_calls: [],
                  },
                ],
              },
            } as unknown as Thread);
          }
          // Second poll (after turn 2 / approval reply): no further proposal,
          // last message is a tool result so loop exits.
          return Promise.resolve({
            thread_id: 'thread-hitl',
            status: 'idle',
            values: {
              messages: [
                { type: 'human', content: 'OPPLAN ...' },
                { type: 'ai', name: 'decepticon', content: 'proposal', tool_calls: [] },
                { type: 'human', content: 'approved — proceed' },
                { type: 'tool', name: 'report_finding', content: 'done' },
              ],
            },
          } as unknown as Thread);
        },
      },
      runs: {
        stream(_threadId, _assistantId, args) {
          streamCalls.push({ input: args.input });
          // Each turn yields just one metadata chunk and ends. The interesting
          // assertion is whether two streams happen, not what they emit.
          const generator = async function* (): AsyncGenerator<StreamChunk> {
            yield { event: 'metadata', data: { run_id: `run-${streamCalls.length}` } };
          };
          return generator();
        },
        cancel() {
          return Promise.resolve();
        },
      },
    };

    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });

    // Drain status stream so we can assert the auto-approval marker.
    const events: StatusEvent[] = [];
    for await (const ev of adapter.streamStatus(handle.sessionId)) events.push(ev);

    // Two runs.stream calls = initial OPPLAN + one approval reply.
    expect(streamCalls.length).toBe(2);
    // First call carries the OPPLAN payload (whatever shape the SUT built).
    expect(streamCalls[0]?.input).toBeDefined();
    // Second call is an explicit approval-reply messages array.
    const secondInput = streamCalls[1]?.input as { messages?: Array<{ content?: string }> };
    expect(Array.isArray(secondInput.messages)).toBe(true);
    expect(secondInput.messages?.[0]?.content).toMatch(/approved/i);

    // Auto-approval status event landed mid-stream.
    const approvalEvent = events.find((e) => e.detail?.['reason'] === 'auto_approval_fired');
    expect(approvalEvent).toBeDefined();
    expect(approvalEvent?.detail?.['approvalNumber']).toBe(1);
  });

  test('does NOT fire approval when last AI msg has tool_calls (still working)', async () => {
    const streamCalls: Array<{ input: unknown }> = [];

    const client: DecepticonClient = {
      threads: {
        create() {
          return Promise.resolve({ thread_id: 'thread-busy' } as unknown as Thread);
        },
        get(_id) {
          return Promise.resolve({
            thread_id: 'thread-busy',
            status: 'idle',
            values: {
              messages: [
                { type: 'human', content: 'OPPLAN ...' },
                {
                  type: 'ai',
                  name: 'decepticon',
                  content: 'thinking',
                  // tool_calls present → agent isn't waiting, has more work.
                  tool_calls: [{ name: 'bash', args: {} }],
                },
              ],
            },
          } as unknown as Thread);
        },
      },
      runs: {
        stream(_t, _a, args) {
          streamCalls.push({ input: args.input });
          const generator = async function* (): AsyncGenerator<StreamChunk> {
            yield { event: 'metadata', data: {} };
          };
          return generator();
        },
        cancel() {
          return Promise.resolve();
        },
      },
    };

    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });
    for await (const _ of adapter.streamStatus(handle.sessionId)) {
      /* drain */
    }

    // Only one runs.stream call — auto-approval did NOT fire.
    expect(streamCalls.length).toBe(1);
  });

  test('respects MAX_AUTO_APPROVALS cap when proposal keeps recurring', async () => {
    const streamCalls: Array<{ input: unknown }> = [];
    let getCount = 0;

    const client: DecepticonClient = {
      threads: {
        create() {
          return Promise.resolve({ thread_id: 'thread-loop' } as unknown as Thread);
        },
        get(_id) {
          // Always return a NEW proposal — different message index each time.
          getCount += 1;
          const messages: unknown[] = [];
          for (let i = 0; i < getCount * 2; i++) {
            messages.push({ type: i % 2 === 0 ? 'human' : 'ai', content: 'x', tool_calls: [] });
          }
          // Last message is always an AI with proposal text.
          messages.push({
            type: 'ai',
            name: 'decepticon',
            content: '## OPPLAN Proposal — review and approve',
            tool_calls: [],
          });
          return Promise.resolve({
            thread_id: 'thread-loop',
            status: 'idle',
            values: { messages },
          } as unknown as Thread);
        },
      },
      runs: {
        stream(_t, _a, args) {
          streamCalls.push({ input: args.input });
          const generator = async function* (): AsyncGenerator<StreamChunk> {
            yield { event: 'metadata', data: {} };
          };
          return generator();
        },
        cancel() {
          return Promise.resolve();
        },
      },
    };

    const adapter = new RealDecepticonAdapter({ clientFactory: () => client });
    const handle = await adapter.start({ tenantId: 'tenant-a', opplan: buildOpplan() });
    const events: StatusEvent[] = [];
    for await (const ev of adapter.streamStatus(handle.sessionId)) events.push(ev);

    // 1 initial + MAX_AUTO_APPROVALS replies = 6 total stream calls (cap=5).
    expect(streamCalls.length).toBe(6);
    // Final completed event should signal auto_approvals_capped.
    const completedEv = events.find((e) => e.status === 'completed');
    expect(completedEv?.detail?.['reason']).toBe('auto_approvals_capped');
  });
});
