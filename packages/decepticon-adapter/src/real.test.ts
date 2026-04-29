// Sprint 8 — RealDecepticonAdapter must throw NotImplementedError on every method.

import { describe, expect, test } from 'bun:test';
import { RealDecepticonAdapter } from './real.ts';
import { NotImplementedError } from './types.ts';

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

describe('RealDecepticonAdapter (Phase 2 stub)', () => {
  const adapter = new RealDecepticonAdapter();
  const sid = '22222222-2222-2222-2222-222222222222';

  test('start rejects with NotImplementedError', async () => {
    await expect(adapter.start({ tenantId: sid, opplan: buildOpplan() })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  test('streamStatus throws NotImplementedError synchronously', () => {
    expect(() => adapter.streamStatus(sid)).toThrow(NotImplementedError);
  });

  test('streamCandidates throws NotImplementedError synchronously', () => {
    expect(() => adapter.streamCandidates(sid)).toThrow(NotImplementedError);
  });

  test('pause/resume/stop reject with NotImplementedError', async () => {
    await expect(adapter.pause(sid)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.resume(sid)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.stop(sid)).rejects.toBeInstanceOf(NotImplementedError);
  });

  test('exportArtifacts rejects with NotImplementedError', async () => {
    await expect(adapter.exportArtifacts(sid)).rejects.toBeInstanceOf(NotImplementedError);
  });

  test('NotImplementedError name is the typed sentinel', () => {
    const err = new NotImplementedError('start');
    expect(err.name).toBe('NotImplementedError');
    expect(err.method).toBe('start');
    expect(err instanceof Error).toBe(true);
  });
});
