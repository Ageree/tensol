// Sprint 8 — RealDecepticonAdapter. Phase 2 stub.
//
// Every method throws NotImplementedError. The class compiles and is
// importable so coordinator wiring can pick it up via DECEPTICON_ADAPTER=real
// (and immediately blow up at runtime — fail-fast).

import {
  type Artifact,
  type CandidateFinding,
  type DecepticonAdapter,
  NotImplementedError,
  type SessionHandle,
  type StartSessionInput,
  type StatusEvent,
} from './types.ts';

export class RealDecepticonAdapter implements DecepticonAdapter {
  start(_input: StartSessionInput): Promise<SessionHandle> {
    return Promise.reject(new NotImplementedError('start'));
  }

  streamStatus(_sessionId: string): AsyncIterable<StatusEvent> {
    throw new NotImplementedError('streamStatus');
  }

  streamCandidates(_sessionId: string): AsyncIterable<CandidateFinding> {
    throw new NotImplementedError('streamCandidates');
  }

  pause(_sessionId: string): Promise<void> {
    return Promise.reject(new NotImplementedError('pause'));
  }

  resume(_sessionId: string): Promise<void> {
    return Promise.reject(new NotImplementedError('resume'));
  }

  stop(_sessionId: string): Promise<void> {
    return Promise.reject(new NotImplementedError('stop'));
  }

  exportArtifacts(_sessionId: string): Promise<readonly Artifact[]> {
    return Promise.reject(new NotImplementedError('exportArtifacts'));
  }
}
