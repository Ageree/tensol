// Sprint 8 — FakeDecepticonAdapter. Deterministic in-process stand-in.
//
// Drives a fixture timeline through the DecepticonAdapter interface so the
// coordinator + downstream sprints can exercise the full pipeline without
// the real engine. Per-session in-memory state map keeps two parallel
// assessments isolated (A-FD-Tenant-Iso).

import type { FixtureDefinition, FixtureLoader } from './fixture-loader.ts';
import {
  type Artifact,
  type CandidateFinding,
  type DecepticonAdapter,
  NotImplementedError,
  type SessionHandle,
  type SessionStatus,
  type StartSessionInput,
  type StatusEvent,
} from './types.ts';

interface SessionState {
  readonly handle: SessionHandle;
  readonly fixture: FixtureDefinition;
  readonly statusBuffer: StatusEvent[];
  readonly candidateBuffer: CandidateFinding[];
  finalised: boolean;
  failed: boolean;
}

export interface FakeAdapterDeps {
  readonly loader: FixtureLoader;
  /** Test seam — fixture name override. Defaults to env or `xss-reflected`. */
  readonly defaultScenario?: string;
  /** Test seam — defaults to `crypto.randomUUID()`. */
  readonly randomUUID?: () => string;
  /** Test seam — defaults to `() => new Date().toISOString()`. */
  readonly clockIso?: () => string;
  /** Test seam — defaults to `setTimeout(0)`. Tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Map an assessmentId to a fixture scenario. Fallback `defaultScenario`. */
  readonly scenarioForAssessment?: (assessmentId: string) => string | null;
}

const DEFAULT_SCENARIO = 'xss-reflected';

export class FakeDecepticonAdapter implements DecepticonAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly loader: FixtureLoader;
  private readonly randomUUID: () => string;
  private readonly clockIso: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultScenario: string;
  private readonly scenarioForAssessment: ((id: string) => string | null) | undefined;

  constructor(deps: FakeAdapterDeps) {
    this.loader = deps.loader;
    this.randomUUID = deps.randomUUID ?? ((): string => crypto.randomUUID());
    this.clockIso = deps.clockIso ?? ((): string => new Date().toISOString());
    this.sleep = deps.sleep ?? defaultSleep;
    this.defaultScenario = deps.defaultScenario ?? DEFAULT_SCENARIO;
    this.scenarioForAssessment = deps.scenarioForAssessment;
  }

  async start(input: StartSessionInput): Promise<SessionHandle> {
    const scenario =
      this.scenarioForAssessment?.(input.opplan.assessmentId) ?? this.defaultScenario;
    const fixture = await this.loader.load(scenario);
    const sessionId = this.randomUUID();
    const startedAt = this.clockIso();
    const handle: SessionHandle = {
      sessionId,
      assessmentId: input.opplan.assessmentId,
      tenantId: input.tenantId,
      startedAt,
    };
    const state: SessionState = {
      handle,
      fixture,
      statusBuffer: [],
      candidateBuffer: [],
      finalised: false,
      failed: false,
    };
    this.sessions.set(sessionId, state);
    await this.playFixture(state);
    return handle;
  }

  // Drive every status event + every candidate into in-memory buffers
  // synchronously; the streamStatus/streamCandidates iterators read them out
  // afterward. This keeps the fake fully deterministic — the await chain
  // resolves before start() returns.
  private async playFixture(state: SessionState): Promise<void> {
    for (const step of state.fixture.statusTimeline) {
      const delayMs = step.delayMs * state.fixture.timeScale;
      if (delayMs > 0) await this.sleep(delayMs);
      const event: StatusEvent = {
        sessionId: state.handle.sessionId,
        status: step.status,
        occurredAt: this.clockIso(),
        ...(step.detail !== undefined ? { detail: step.detail } : {}),
      };
      state.statusBuffer.push(event);
      if (state.fixture.simulateCrashAt && step.status === state.fixture.simulateCrashAt) {
        state.failed = true;
        const failedEvent: StatusEvent = {
          sessionId: state.handle.sessionId,
          status: 'failed',
          occurredAt: this.clockIso(),
          detail: { reason: 'simulated_crash', stage: step.status },
        };
        state.statusBuffer.push(failedEvent);
        state.finalised = true;
        return;
      }
      // Emit the candidates that are gated by this status step.
      for (const c of state.fixture.candidates) {
        if (c.afterStatus !== step.status) continue;
        state.candidateBuffer.push({
          candidateId: this.randomUUID(),
          sessionId: state.handle.sessionId,
          type: c.type,
          severity: c.severity,
          affectedUrl: c.affectedUrl,
          source: c.source,
          payload: c.payload,
          observedAt: this.clockIso(),
        });
      }
    }
    state.finalised = true;
  }

  streamStatus(sessionId: string): AsyncIterable<StatusEvent> {
    const state = this.requireSession(sessionId);
    return drainBuffer(state.statusBuffer);
  }

  streamCandidates(sessionId: string): AsyncIterable<CandidateFinding> {
    const state = this.requireSession(sessionId);
    return drainBuffer(state.candidateBuffer);
  }

  async pause(sessionId: string): Promise<void> {
    this.requireSession(sessionId);
  }

  async resume(sessionId: string): Promise<void> {
    this.requireSession(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    state.finalised = true;
  }

  async exportArtifacts(sessionId: string): Promise<readonly Artifact[]> {
    this.requireSession(sessionId);
    // OPPLAN is materialised by the coordinator (it owns the bytes + sha256).
    // Fake adapter has no artifacts of its own beyond what the coordinator
    // writes; Sprint 8 returns an empty list here.
    return [];
  }

  /** Test-only: introspect terminal state of a session. */
  hasFailed(sessionId: string): boolean {
    return this.requireSession(sessionId).failed;
  }

  /** Test-only: return the recorded final status (last in buffer). */
  finalStatus(sessionId: string): SessionStatus {
    const state = this.requireSession(sessionId);
    const last = state.statusBuffer[state.statusBuffer.length - 1];
    if (!last) throw new Error('session_has_no_status_events');
    return last.status;
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new NotImplementedError(`session_not_found:${sessionId}`);
    return state;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function* drainBuffer<T>(buf: readonly T[]): AsyncGenerator<T, void, void> {
  for (const item of buf) {
    yield item;
  }
}
