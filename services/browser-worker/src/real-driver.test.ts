// Sprint 9 — RealBrowserDriver stub: every method rejects with NotImplementedError.

import { describe, expect, test } from 'bun:test';
import { RealBrowserDriver } from './real-driver.ts';
import { NotImplementedError } from './types.ts';

describe('RealBrowserDriver', () => {
  test('launch rejects with NotImplementedError', async () => {
    const drv = new RealBrowserDriver();
    await expect(
      drv.launch({ tenantId: 't', assessmentId: 'a', traceId: 'x'.repeat(32) }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  test('navigate rejects with NotImplementedError', async () => {
    const drv = new RealBrowserDriver();
    await expect(drv.navigate('s', { url: 'http://x', method: 'GET' })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  test('close rejects with NotImplementedError', async () => {
    const drv = new RealBrowserDriver();
    await expect(drv.close('s')).rejects.toBeInstanceOf(NotImplementedError);
  });

  test('error has correct name', async () => {
    const drv = new RealBrowserDriver();
    try {
      await drv.launch({ tenantId: 't', assessmentId: 'a', traceId: 'x'.repeat(32) });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('NotImplementedError');
    }
  });
});
