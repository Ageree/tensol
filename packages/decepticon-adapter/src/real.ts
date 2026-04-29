// Sprint 12 — RealDecepticonAdapter wired to LangGraph Platform.
//
// Maps our DecepticonAdapter interface to the upstream Decepticon engine
// (PurpleAILAB/Decepticon, Apache-2.0). Decepticon runs on its own
// docker-compose stack with two isolated networks; we only talk to its
// LangGraph HTTP endpoint at `DECEPTICON_API_URL` (default
// http://localhost:2024).
//
// What we send:
// - One thread per assessment.start. We track our own sessionId (uuid)
//   and the upstream thread_id separately.
// - Initial human message carries the OPPLAN payload as JSON, prefixed by
//   "OPPLAN" so Decepticon's orchestrator picks it up.
//
// What we receive:
// - `subagent_*` custom events (subagent_streaming.py contract) → mapped
//   into StatusEvent (recon/exploit/reporting/completed) by phase.
// - `subagent_tool_result` events with tool=`report_finding` and a JSON
//   content payload → CandidateFinding.
//
// What still goes through OUR engine:
// - scope-engine.decide on every emitted candidate's affectedUrl BEFORE
//   it lands in our queue (caller responsibility — adapter just yields).
// - validator-worker (Sprint 10) gates confirmation; Decepticon-emitted
//   findings stay candidate until our XSS validator confirms.
// - tenant isolation, audit emission, persistence — all on our side.

import { randomUUID } from 'node:crypto';
import { Client, type Thread } from '@langchain/langgraph-sdk';
import type {
  Artifact,
  CandidateFinding,
  DecepticonAdapter,
  SessionHandle,
  StartSessionInput,
  StatusEvent,
} from './types.ts';

// ============================================================================
// Config + DI
// ============================================================================

export interface RealDecepticonAdapterDeps {
  /** LangGraph Platform endpoint. Defaults to env DECEPTICON_API_URL or localhost:2024. */
  readonly apiUrl?: string;
  /** Initial assistant id. "decepticon" runs the orchestrator directly; "soundwave" planning interview first. */
  readonly assistantId?: string;
  /** Override for tests — lets us swap a recording mock in for IT without spinning up a real LangGraph server. */
  readonly clientFactory?: (opts: { apiUrl: string }) => DecepticonClient;
}

/**
 * Subset of the LangGraph SDK Client we actually use. Lets us swap a
 * recording mock in for IT.
 */
export interface DecepticonClient {
  threads: {
    create(args: { metadata?: Record<string, unknown> }): Promise<Thread>;
  };
  runs: {
    stream(
      threadId: string,
      assistantId: string,
      args: {
        input: unknown;
        streamMode: ReadonlyArray<'values' | 'updates' | 'messages' | 'custom'>;
        signal?: AbortSignal;
      },
    ): AsyncGenerator<StreamChunk>;
    cancel(threadId: string, runId: string, args?: { wait?: boolean }): Promise<void>;
  };
}

/** Minimal stream chunk shape from `runs.stream`. */
export interface StreamChunk {
  readonly event: 'values' | 'updates' | 'messages' | 'custom' | 'metadata' | 'error' | 'end';
  readonly data: unknown;
}

// ============================================================================
// Internal session state
// ============================================================================

interface SessionState {
  readonly sessionId: string;
  readonly threadId: string;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly startedAt: string;
  readonly assistantId: string;
  readonly statusQueue: AsyncQueue<StatusEvent>;
  readonly candidateQueue: AsyncQueue<CandidateFinding>;
  readonly abortController: AbortController;
  streamPromise: Promise<void>;
  runId: string | null;
  finalStatus: 'completed' | 'failed' | 'cancelled' | null;
}

// ============================================================================
// AsyncQueue — single-producer/single-consumer for streamStatus/streamCandidates
// ============================================================================

interface AsyncQueue<T> {
  push(item: T): void;
  close(): void;
  iter(): AsyncIterable<T>;
}

const createAsyncQueue = <T>(): AsyncQueue<T> => {
  const items: T[] = [];
  const waiters: Array<(v: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(item: T): void {
      if (closed) return;
      const w = waiters.shift();
      if (w) {
        w({ value: item, done: false });
        return;
      }
      items.push(item);
    },
    close(): void {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w({ value: undefined, done: true });
      }
    },
    iter(): AsyncIterable<T> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
          return {
            next(): Promise<IteratorResult<T>> {
              if (items.length > 0) {
                const value = items.shift() as T;
                return Promise.resolve({ value, done: false });
              }
              if (closed) {
                return Promise.resolve({ value: undefined, done: true });
              }
              return new Promise<IteratorResult<T>>((resolve) => {
                waiters.push(resolve);
              });
            },
          };
        },
      };
    },
  };
};

// ============================================================================
// Phase mapping — Decepticon agent name → our SessionStatus
// ============================================================================

const phaseForAgent: Record<string, StatusEvent['status']> = {
  soundwave: 'planning',
  recon: 'recon',
  scanner: 'recon',
  exploit: 'exploit',
  exploiter: 'exploit',
  detector: 'exploit',
  verifier: 'exploit',
  patcher: 'exploit',
  postexploit: 'exploit',
  ad_operator: 'exploit',
  cloud_hunter: 'exploit',
  reverser: 'exploit',
  contract_auditor: 'exploit',
  analyst: 'reporting',
  defender: 'reporting',
  decepticon: 'planning',
};

const inferStatusFromAgent = (agent: string): StatusEvent['status'] | null => {
  return phaseForAgent[agent.toLowerCase()] ?? null;
};

// ============================================================================
// SubagentCustomEvent shape (mirrors @decepticon/streaming/src/types.ts)
// ============================================================================

interface SubagentCustomEvent {
  type:
    | 'subagent_start'
    | 'subagent_end'
    | 'subagent_tool_call'
    | 'subagent_tool_result'
    | 'subagent_message'
    | 'ask_user_question'
    | 'engagement_ready';
  agent: string;
  tool?: string;
  args?: Record<string, unknown>;
  content?: string;
  status?: string;
  cancelled?: boolean;
  error?: boolean;
}

// ============================================================================
// RealDecepticonAdapter
// ============================================================================

export class RealDecepticonAdapter implements DecepticonAdapter {
  private readonly apiUrl: string;
  private readonly assistantId: string;
  private readonly client: DecepticonClient;
  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: RealDecepticonAdapterDeps = {}) {
    // Biome's useLiteralKeys conflicts with TS noPropertyAccessFromIndexSignature
    // for process.env. Destructure to satisfy both.
    const { DECEPTICON_API_URL, DECEPTICON_ASSISTANT_ID } = process.env;
    this.apiUrl = deps.apiUrl ?? DECEPTICON_API_URL ?? 'http://localhost:2024';
    this.assistantId = deps.assistantId ?? DECEPTICON_ASSISTANT_ID ?? 'decepticon';
    this.client = deps.clientFactory
      ? deps.clientFactory({ apiUrl: this.apiUrl })
      : (new Client({ apiUrl: this.apiUrl }) as unknown as DecepticonClient);
  }

  async start(input: StartSessionInput): Promise<SessionHandle> {
    const thread = await this.client.threads.create({
      metadata: {
        cyberstrike_assessment_id: input.opplan.assessmentId,
        cyberstrike_tenant_id: input.tenantId,
      },
    });

    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();

    const statusQueue = createAsyncQueue<StatusEvent>();
    const candidateQueue = createAsyncQueue<CandidateFinding>();
    const abortController = new AbortController();

    const initialMessage = {
      messages: [
        {
          type: 'human',
          content: `OPPLAN\n\n${JSON.stringify(input.opplan, null, 2)}`,
        },
      ],
    };

    const state: SessionState = {
      sessionId,
      threadId: thread.thread_id,
      tenantId: input.tenantId,
      assessmentId: input.opplan.assessmentId,
      startedAt,
      assistantId: this.assistantId,
      statusQueue,
      candidateQueue,
      abortController,
      runId: null,
      finalStatus: null,
      streamPromise: Promise.resolve(),
    };

    statusQueue.push({
      sessionId,
      status: 'started',
      occurredAt: startedAt,
      detail: { threadId: thread.thread_id },
    });

    state.streamPromise = this.consumeStream(state, initialMessage);
    state.streamPromise.catch((err) => {
      this.handleFailure(state, err instanceof Error ? err.message : String(err));
    });

    this.sessions.set(sessionId, state);

    return {
      sessionId,
      assessmentId: input.opplan.assessmentId,
      tenantId: input.tenantId,
      startedAt,
      langgraphThreadId: thread.thread_id,
    };
  }

  streamStatus(sessionId: string): AsyncIterable<StatusEvent> {
    return this.requireSession(sessionId).statusQueue.iter();
  }

  streamCandidates(sessionId: string): AsyncIterable<CandidateFinding> {
    return this.requireSession(sessionId).candidateQueue.iter();
  }

  async pause(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    if (state.runId) {
      await this.client.runs.cancel(state.threadId, state.runId, { wait: false });
    }
  }

  async resume(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    state.statusQueue.push({
      sessionId,
      status: 'started',
      occurredAt: new Date().toISOString(),
      detail: { resume: 'placeholder' },
    });
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    state.abortController.abort();
    if (state.runId) {
      try {
        await this.client.runs.cancel(state.threadId, state.runId, { wait: true });
      } catch {
        // Already cancelled or thread gone.
      }
    }
    if (!state.finalStatus) {
      state.finalStatus = 'cancelled';
      state.statusQueue.push({
        sessionId,
        status: 'failed',
        occurredAt: new Date().toISOString(),
        detail: { reason: 'cancelled_by_caller' },
      });
    }
    state.statusQueue.close();
    state.candidateQueue.close();
  }

  async exportArtifacts(sessionId: string): Promise<readonly Artifact[]> {
    this.requireSession(sessionId);
    return [];
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown session ${sessionId}`);
    return state;
  }

  private async consumeStream(state: SessionState, input: unknown): Promise<void> {
    try {
      const stream = this.client.runs.stream(state.threadId, state.assistantId, {
        input,
        streamMode: ['values', 'custom'] as const,
        signal: state.abortController.signal,
      });

      for await (const chunk of stream) {
        if (state.abortController.signal.aborted) break;
        this.dispatchChunk(state, chunk);
      }

      if (!state.finalStatus) {
        state.finalStatus = 'completed';
        state.statusQueue.push({
          sessionId: state.sessionId,
          status: 'completed',
          occurredAt: new Date().toISOString(),
        });
      }
    } finally {
      state.statusQueue.close();
      state.candidateQueue.close();
    }
  }

  private dispatchChunk(state: SessionState, chunk: StreamChunk): void {
    if (chunk.event === 'metadata') {
      const meta = chunk.data as { run_id?: string };
      if (meta.run_id) state.runId = meta.run_id;
      return;
    }
    if (chunk.event === 'custom') {
      this.handleCustomEvent(state, chunk.data as SubagentCustomEvent);
      return;
    }
    if (chunk.event === 'error') {
      this.handleFailure(state, JSON.stringify(chunk.data));
    }
  }

  private handleCustomEvent(state: SessionState, evt: SubagentCustomEvent): void {
    if (evt.type === 'subagent_start') {
      const status = inferStatusFromAgent(evt.agent);
      if (status) {
        state.statusQueue.push({
          sessionId: state.sessionId,
          status,
          occurredAt: new Date().toISOString(),
          detail: { agent: evt.agent },
        });
      }
      return;
    }

    if (evt.type === 'subagent_tool_result' && evt.tool === 'report_finding') {
      const finding = this.tryParseFinding(state, evt);
      if (finding) state.candidateQueue.push(finding);
      return;
    }

    if (evt.type === 'subagent_end' && evt.error) {
      this.handleFailure(state, evt.content ?? 'agent_error');
    }
  }

  private tryParseFinding(state: SessionState, evt: SubagentCustomEvent): CandidateFinding | null {
    const content = evt.content;
    if (!content || typeof content !== 'string') return null;

    let parsed: { type?: unknown; severity?: unknown; affectedUrl?: unknown } & Record<
      string,
      unknown
    >;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    const { type, severity, affectedUrl } = parsed;
    if (
      typeof type !== 'string' ||
      typeof severity !== 'string' ||
      typeof affectedUrl !== 'string'
    ) {
      return null;
    }

    return {
      candidateId: randomUUID(),
      sessionId: state.sessionId,
      type: type as CandidateFinding['type'],
      severity: severity as CandidateFinding['severity'],
      affectedUrl,
      source: `decepticon.${evt.agent}`,
      payload: parsed,
      observedAt: new Date().toISOString(),
    };
  }

  private handleFailure(state: SessionState, reason: string): void {
    if (state.finalStatus) return;
    state.finalStatus = 'failed';
    state.statusQueue.push({
      sessionId: state.sessionId,
      status: 'failed',
      occurredAt: new Date().toISOString(),
      detail: { reason },
    });
  }
}
