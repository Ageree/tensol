// Sprint 9 — selectBrowserDriver behaviour.

import { describe, expect, test } from 'bun:test';
import { FakeBrowserDriver } from './fake-driver.ts';
import { RealBrowserDriver } from './real-driver.ts';
import { selectBrowserDriver } from './select.ts';

describe('selectBrowserDriver', () => {
  test('default (no env) returns FakeBrowserDriver', () => {
    expect(selectBrowserDriver({})).toBeInstanceOf(FakeBrowserDriver);
  });

  test('BROWSER_DRIVER=fake returns FakeBrowserDriver', () => {
    expect(selectBrowserDriver({ BROWSER_DRIVER: 'fake' })).toBeInstanceOf(FakeBrowserDriver);
  });

  test('BROWSER_DRIVER=real returns RealBrowserDriver', () => {
    expect(selectBrowserDriver({ BROWSER_DRIVER: 'real' })).toBeInstanceOf(RealBrowserDriver);
  });

  test('unknown value throws', () => {
    expect(() => selectBrowserDriver({ BROWSER_DRIVER: 'puppeteer' })).toThrow(
      /unknown_browser_driver/,
    );
  });
});
