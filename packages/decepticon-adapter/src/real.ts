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
    /** 2026-05-12 — needed by HITL state-machine to detect proposal-await state. */
    get(threadId: string): Promise<Thread>;
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
  /** EE-3 HITL fix (2026-05-12): how many times we've fired an auto-approval reply on this thread. */
  autoApprovalsCount: number;
  /** Last LangGraph message index we fed an auto-approval to — prevents double-approval of same proposal. */
  lastApprovedMessageIndex: number;
}

// ============================================================================
// HITL state-machine constants (2026-05-12)
// ============================================================================

const MAX_AUTO_APPROVALS = 5;
const APPROVAL_REPLY_CONTENT =
  'approved — proceed with full execution per the OPPLAN. ' +
  'Do not present further proposals; run all phases sequentially (recon → ' +
  'initial-access if foothold:true → post-exploit if postExploit:true) and ' +
  'emit confirmed findings via the report_finding tool.';

/**
 * Heuristic — does the thread state look like the agent is waiting for a human reply?
 *
 * 2026-05-12 update: dropped the content-keyword regex. Decepticon's
 * `decepticon` orchestrator surfaced a Korean proposal during scan #6
 * («OPPLAN이 준비되었습니다. 검토 및 승인을 부탁드립니다») which the
 * English-only regex missed → state-machine bailed early. New rule is purely
 * structural and language-independent: thread.status === 'idle' AND last
 * message is from `ai` agent AND has no pending tool_calls → it is waiting.
 * Genuine "task done" final messages get an unwanted approval reply, but cap
 * at MAX_AUTO_APPROVALS bounds the cost; in practice Decepticon responds
 * with «task already complete» and the next iteration exits.
 */
const isAwaitingHumanReply = (
  thread: { status?: string; values?: unknown },
  lastApprovedIndex: number,
): { awaiting: boolean; messageIndex: number } => {
  const values = thread.values as { messages?: unknown[] } | undefined;
  const messages = values?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { awaiting: false, messageIndex: -1 };
  }
  const lastIdx = messages.length - 1;
  if (lastIdx <= lastApprovedIndex) return { awaiting: false, messageIndex: lastIdx };
  if (thread.status && thread.status !== 'idle') {
    return { awaiting: false, messageIndex: lastIdx };
  }
  const last = messages[lastIdx] as
    | { type?: string; tool_calls?: unknown[] }
    | undefined;
  if (!last || last.type !== 'ai') return { awaiting: false, messageIndex: lastIdx };
  // tool_calls present → agent is still working, NOT waiting.
  if (Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
    return { awaiting: false, messageIndex: lastIdx };
  }
  // Idle thread + AI message with no pending tool calls = waiting for human.
  return { awaiting: true, messageIndex: lastIdx };
};

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

    // Phase 3.1 (2026-05-12) — per-call assistant_id override. Used by
    // start-decepticon-session.ts step 8.7 to dispatch the Decepticon
    // `verifier` agent after the recon thread completes.
    const effectiveAssistantId = input.assistantId ?? this.assistantId;

    // KNOWN BUG (2026-05-12 second-smoke #4): Decepticon's `decepticon`
    // assistant is HITL — after parsing OPPLAN it presents a Proposal and
    // waits for a human "approve" reply before any exploit phase. Tried
    // appending a pre-approval INSTRUCTION text here in scan-5; result was
    // WORSE — Decepticon hung silently for 15 min (langgraph 0.46% CPU,
    // 0 LLM calls), wallclock fix #3 had to force-close. Reverted that
    // attempt. Proper fix is a state-machine adapter: after sending OPPLAN,
    // poll thread state, detect "OPPLAN Proposal" pattern in last AI msg,
    // fire a second human message via `runs.create` on the same thread.
    // Scoped as a follow-up workstream — see project_tensol_second_smoke.
    //
    // Phase 3.1 (2026-05-12) — `input.initialMessage` overrides the OPPLAN
    // payload for sub-agent dispatches that consume free-form natural
    // language instead (verifier reads the kg, not opplan). When the
    // override is supplied we still wrap it as a `human` message turn so
    // the LangGraph thread sees a normal conversational entry-point.
    const initialMessage = {
      messages: [
        {
          type: 'human',
          content:
            input.initialMessage !== undefined
              ? input.initialMessage
              : `OPPLAN\n\n${JSON.stringify(input.opplan, null, 2)}`,
        },
      ],
    };

    const state: SessionState = {
      sessionId,
      threadId: thread.thread_id,
      tenantId: input.tenantId,
      assessmentId: input.opplan.assessmentId,
      startedAt,
      assistantId: effectiveAssistantId,
      statusQueue,
      candidateQueue,
      abortController,
      runId: null,
      finalStatus: null,
      streamPromise: Promise.resolve(),
      autoApprovalsCount: 0,
      lastApprovedMessageIndex: -1,
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
      // 2026-05-12 second-smoke fix #3 — overall wallclock safeguard around
      // the whole iteration loop (initial run + auto-approval continuations).
      // If the wallclock fires we close the queues even if Decepticon hangs
      // internally. Tunable via DECEPTICON_STREAM_MAX_MS (default 15 min).
      const streamMaxMs =
        Number(
          (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
            'DECEPTICON_STREAM_MAX_MS'
          ],
        ) || 15 * 60 * 1000;

      const consumeAllRuns = async (initial: unknown): Promise<'stream-end' | 'capped'> => {
        // EE-3 HITL state-machine: outer loop iterates one runs.stream per
        // human turn. First iteration is the OPPLAN; subsequent iterations
        // are auto-approval replies fired when Decepticon presents an
        // OPPLAN Proposal and stops. Capped at MAX_AUTO_APPROVALS+1 turns.
        let nextInput: unknown = initial;
        for (let turn = 0; turn <= MAX_AUTO_APPROVALS; turn++) {
          if (state.abortController.signal.aborted) return 'stream-end';
          const stream = this.client.runs.stream(state.threadId, state.assistantId, {
            input: nextInput,
            streamMode: ['values', 'custom'] as const,
            signal: state.abortController.signal,
          });
          for await (const chunk of stream) {
            if (state.abortController.signal.aborted) return 'stream-end';
            this.dispatchChunk(state, chunk);
          }
          // Stream ended for this turn. Check if Decepticon is asking for
          // human approval. If so, fire next turn with approval reply.
          if (state.abortController.signal.aborted) return 'stream-end';
          const thread = await this.client.threads.get(state.threadId).catch(() => null);
          if (!thread) return 'stream-end';
          const check = isAwaitingHumanReply(thread, state.lastApprovedMessageIndex);
          if (!check.awaiting) return 'stream-end';
          if (state.autoApprovalsCount >= MAX_AUTO_APPROVALS) return 'capped';
          state.autoApprovalsCount += 1;
          state.lastApprovedMessageIndex = check.messageIndex;
          state.statusQueue.push({
            sessionId: state.sessionId,
            status: 'planning',
            occurredAt: new Date().toISOString(),
            detail: {
              reason: 'auto_approval_fired',
              approvalNumber: state.autoApprovalsCount,
              proposalAtMessageIndex: check.messageIndex,
            },
          });
          nextInput = {
            messages: [
              {
                type: 'human',
                content: APPROVAL_REPLY_CONTENT,
              },
            ],
          };
        }
        return 'capped';
      };

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const wallclock = new Promise<'wallclock'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('wallclock'), streamMaxMs);
      });

      const result = await Promise.race([consumeAllRuns(input), wallclock]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (result === 'wallclock' && !state.abortController.signal.aborted) {
        try {
          state.abortController.abort();
        } catch {
          /* noop */
        }
      }

      if (!state.finalStatus) {
        state.finalStatus = 'completed';
        const detail: Record<string, unknown> = {
          autoApprovalsCount: state.autoApprovalsCount,
        };
        if (result === 'wallclock') detail['reason'] = 'stream_wallclock_close';
        if (result === 'capped') detail['reason'] = 'auto_approvals_capped';
        state.statusQueue.push({
          sessionId: state.sessionId,
          status: 'completed',
          occurredAt: new Date().toISOString(),
          ...(Object.keys(detail).length > 1 ? { detail } : {}),
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
