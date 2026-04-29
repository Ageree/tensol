import { describe, expect, test } from 'bun:test';
import { collectEvidence, evidenceObjectKey } from './evidence-collector.ts';
import type { XssReplayResult } from './xss-replay-driver.ts';

const fakeRun = (screenshot: Uint8Array, trace: Uint8Array): XssReplayResult => ({
  finalUrl: 'http://x',
  httpStatus: 200,
  domContainsNonce: true,
  consoleNonceHits: [],
  alertDispatched: false,
  networkRequestsFromScript: [],
  screenshot,
  trace,
  capturedAt: '2026-04-29T00:00:00.000Z',
});

describe('validators :: evidence-collector', () => {
  test('produces 2 blobs per run (screenshot + trace) with sha256 + size', () => {
    const out = collectEvidence([
      fakeRun(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])),
      fakeRun(new Uint8Array([6]), new Uint8Array([7, 8, 9, 10])),
    ]);
    expect(out.length).toBe(4);
    expect(out[0]?.kind).toBe('screenshot');
    expect(out[0]?.attempt).toBe(1);
    expect(out[0]?.sizeBytes).toBe(3);
    expect(out[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out[1]?.kind).toBe('trace');
    expect(out[1]?.attempt).toBe(1);
    expect(out[2]?.attempt).toBe(2);
    expect(out[3]?.attempt).toBe(2);
  });

  test('sha256 deterministic for identical bytes', () => {
    const a = collectEvidence([fakeRun(new Uint8Array([1]), new Uint8Array([2]))]);
    const b = collectEvidence([fakeRun(new Uint8Array([1]), new Uint8Array([2]))]);
    expect(a[0]?.sha256).toBe(b[0]?.sha256);
  });

  test('evidenceObjectKey shape includes tenant/finding/kind/attempt/sha + ext', () => {
    const key = evidenceObjectKey({
      tenantId: '11111111-1111-1111-1111-111111111111',
      findingId: '22222222-2222-2222-2222-222222222222',
      kind: 'screenshot',
      attempt: 1,
      sha256: 'a'.repeat(64),
    });
    expect(key).toMatch(/^tenant\/.+\/finding\/.+\/screenshot-1-a{64}\.png$/);
  });

  test('evidenceObjectKey produces .zip for trace', () => {
    const key = evidenceObjectKey({
      tenantId: 't',
      findingId: 'f',
      kind: 'trace',
      attempt: 2,
      sha256: 'b'.repeat(64),
    });
    expect(key).toMatch(/trace-2-b{64}\.zip$/);
  });
});
