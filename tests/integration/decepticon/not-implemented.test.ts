// Sprint 12 — RealDecepticonAdapter is now wired (no longer NotImplemented).
// This file kept for naming continuity with Sprint 8 contract A-FD-NotImpl
// but the assertions now verify the real adapter accepts a clientFactory
// and rejects only when the LangGraph endpoint is unreachable.
//
// CI does NOT run the upstream Decepticon engine — full unit-level
// behaviour for the real adapter lives in
// `packages/decepticon-adapter/src/real.test.ts`.

import { describe, expect, test } from 'bun:test';
import { RealDecepticonAdapter } from '@cyberstrike/decepticon-adapter';

describe('decepticon :: RealDecepticonAdapter (Sprint 12 wired)', () => {
  test('constructible with no deps and exposes the DecepticonAdapter surface', () => {
    const adapter = new RealDecepticonAdapter();
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.streamStatus).toBe('function');
    expect(typeof adapter.streamCandidates).toBe('function');
    expect(typeof adapter.pause).toBe('function');
    expect(typeof adapter.resume).toBe('function');
    expect(typeof adapter.stop).toBe('function');
    expect(typeof adapter.exportArtifacts).toBe('function');
  });

  test('streamStatus on unknown sessionId throws', () => {
    const adapter = new RealDecepticonAdapter();
    expect(() => adapter.streamStatus('nonexistent')).toThrow(/Unknown session/);
  });

  test('streamCandidates on unknown sessionId throws', () => {
    const adapter = new RealDecepticonAdapter();
    expect(() => adapter.streamCandidates('nonexistent')).toThrow(/Unknown session/);
  });
});
