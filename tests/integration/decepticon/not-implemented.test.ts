// Sprint 8 §A-FD-NotImpl — RealDecepticonAdapter must reject at runtime.

import { describe, expect, test } from 'bun:test';
import { NotImplementedError, RealDecepticonAdapter } from '@cyberstrike/decepticon-adapter';

describe('decepticon :: RealDecepticonAdapter NotImplemented (A-FD-NotImpl)', () => {
  test('start rejects with typed NotImplementedError sentinel', async () => {
    const adapter = new RealDecepticonAdapter();
    let caught: unknown = null;
    try {
      await adapter.start({
        tenantId: '11111111-1111-1111-1111-111111111111',
        opplan: {
          assessmentId: '22222222-2222-2222-2222-222222222222',
          targets: ['x'],
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
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotImplementedError);
    expect((caught as NotImplementedError).name).toBe('NotImplementedError');
    expect((caught as NotImplementedError).method).toBe('start');
  });

  test('streamCandidates throws NotImplementedError synchronously', () => {
    const adapter = new RealDecepticonAdapter();
    expect(() => adapter.streamCandidates('00000000-0000-0000-0000-000000000000')).toThrow(
      NotImplementedError,
    );
  });
});
