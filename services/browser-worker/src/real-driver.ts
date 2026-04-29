// Sprint 9 — RealBrowserDriver stub. Phase 2 fills with Playwright Chromium.
//
// Mirrors the Sprint 8 RealDecepticonAdapter pattern: every method
// rejects with NotImplementedError. Compiles + importable so the
// selector path (BROWSER_DRIVER=real) returns a working object that
// fails loudly at first navigation.

import type {
  BrowserDriver,
  BrowserLaunchInput,
  BrowserSession,
  NavigationOutcome,
  NavigationRequest,
} from './types.ts';
import { NotImplementedError } from './types.ts';

export class RealBrowserDriver implements BrowserDriver {
  launch(_input: BrowserLaunchInput): Promise<BrowserSession> {
    return Promise.reject(new NotImplementedError('RealBrowserDriver.launch'));
  }
  navigate(_sessionId: string, _request: NavigationRequest): Promise<NavigationOutcome> {
    return Promise.reject(new NotImplementedError('RealBrowserDriver.navigate'));
  }
  close(_sessionId: string): Promise<void> {
    return Promise.reject(new NotImplementedError('RealBrowserDriver.close'));
  }
}
