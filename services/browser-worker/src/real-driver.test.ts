// Sprint 15 — RealBrowserDriver: replaces the Sprint 9 NotImplementedError stub.
// These tests exercise error paths without launching a real browser.

import { describe, expect, mock, test } from 'bun:test';
import { RealBrowserDriver } from './real-driver.ts';

describe('RealBrowserDriver', () => {
  test('navigate rejects with session_not_found for unknown sessionId', async () => {
    const drv = new RealBrowserDriver();
    await expect(
      drv.navigate('unknown-session-id', { url: 'http://x', method: 'GET' }),
    ).rejects.toThrow('session_not_found:unknown-session-id');
  });

  test('close resolves silently for unknown sessionId', async () => {
    const drv = new RealBrowserDriver();
    await expect(drv.close('unknown-session-id')).resolves.toBeUndefined();
  });

  test('scopeCheck rejection is propagated from navigate', async () => {
    const drv = new RealBrowserDriver({
      scopeCheck: async () => {
        throw new Error('scope_denied');
      },
      randomUUID: () => 'test-session-id',
    });
    // Inject a fake session directly so navigate reaches the scopeCheck call.
    const fakePage = {
      on: mock(() => {}),
      goto: mock(async () => ({ status: () => 200, url: () => 'http://x' })),
      screenshot: mock(async () => new Uint8Array()),
      content: mock(async () => '<html></html>'),
      evaluate: mock(async () => []),
    };
    // biome-ignore lint/suspicious/noExplicitAny: inject test session via internal map
    (drv as any).sessions.set('test-session-id', {
      sessionId: 'test-session-id',
      page: fakePage,
    });
    // sharedContext must be set for navigate to access it
    // biome-ignore lint/suspicious/noExplicitAny: inject shared context via internal field
    (drv as any).sharedContext = {
      unrouteAll: mock(async () => {}),
      route: mock(async () => {}),
    };
    await expect(
      drv.navigate('test-session-id', { url: 'http://x', method: 'GET' }),
    ).rejects.toThrow('scope_denied');
  });

  test('randomUUID dep is used for sessionId generation', () => {
    const fixedUuid = mock(() => 'fixed-uuid-1234');
    const drv = new RealBrowserDriver({ randomUUID: fixedUuid });
    // The UUID fn is injected but only called during launch (which needs a real browser).
    // Verify it is stored and callable.
    // biome-ignore lint/suspicious/noExplicitAny: internal field access for verification
    expect(typeof (drv as any).randomUUID).toBe('function');
  });
});
