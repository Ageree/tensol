// Sprint 9 — selectBrowserDriver(env). Mirrors decepticon-adapter/select.ts.
//
// BROWSER_DRIVER=fake | real, default fake. Unknown values throw at
// boot so misconfiguration fails fast.

import { FakeBrowserDriver, type FakeBrowserDriverDeps } from './fake-driver.ts';
import { RealBrowserDriver } from './real-driver.ts';
import type { BrowserDriver } from './types.ts';

export type BrowserDriverChoice = 'fake' | 'real';

export interface SelectBrowserDriverOptions {
  readonly fakeDeps?: FakeBrowserDriverDeps;
}

const KNOWN_CHOICES = new Set<string>(['fake', 'real']);

const readEnvValue = (env: Record<string, string | undefined>): string | undefined => {
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature.
  return env['BROWSER_DRIVER'];
};

export const selectBrowserDriver = (
  env: Record<string, string | undefined> = process.env,
  opts: SelectBrowserDriverOptions = {},
): BrowserDriver => {
  const raw = readEnvValue(env);
  const choice: BrowserDriverChoice = (raw ?? 'fake') as BrowserDriverChoice;
  if (raw !== undefined && !KNOWN_CHOICES.has(raw)) {
    throw new Error(`unknown_browser_driver:${raw}`);
  }
  if (choice === 'real') return new RealBrowserDriver();
  return new FakeBrowserDriver(opts.fakeDeps ?? {});
};
