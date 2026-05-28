// T084 — Unit test for the phase-derivation helper in Live.tsx.
//
// Pure logic only; renders nothing.

import { describe, expect, it } from 'bun:test';
import { derivePhaseIndex } from './Live.tsx';
import type { ScanEvent, ScanEventType } from '../lib/api-client.ts';

function evt(type: ScanEventType, ts = 1): ScanEvent {
  return {
    id: `${type}-${ts}`,
    scan_id: 'scan_test',
    event_type: type,
    payload: null,
    created_at: ts,
  };
}

describe('derivePhaseIndex', () => {
  it('returns 4 (terminal) when status=completed', () => {
    expect(derivePhaseIndex('completed', [])).toBe(4);
  });
  it('returns 4 when status=failed', () => {
    expect(derivePhaseIndex('failed', [])).toBe(4);
  });
  it('returns 4 when status=cancelled', () => {
    expect(derivePhaseIndex('cancelled', [])).toBe(4);
  });
  it('returns 3 when status=running', () => {
    expect(derivePhaseIndex('running', [])).toBe(3);
  });
  it('returns 3 when agent_started event present (status still queued)', () => {
    expect(derivePhaseIndex('queued', [evt('agent_started')])).toBe(3);
  });
  it('returns 3 when vm_ready event present', () => {
    expect(derivePhaseIndex('queued', [evt('vm_ready')])).toBe(3);
  });
  it('returns 2 when vm_provisioning event present', () => {
    expect(derivePhaseIndex('queued', [evt('vm_provisioning')])).toBe(2);
  });
  it('returns 1 for newly queued scan with no events', () => {
    expect(derivePhaseIndex('queued', [])).toBe(1);
  });
  it('returns 1 when status undefined (initial load)', () => {
    expect(derivePhaseIndex(undefined, [])).toBe(1);
  });
});
