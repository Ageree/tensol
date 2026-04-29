// Sprint 9 — services/browser-worker public surface.

export const name = 'services/browser-worker' as const;

export type {
  AuthCookie,
  BrowserDriver,
  BrowserDriverFetchDeps,
  BrowserLaunchInput,
  BrowserSession,
  BrowserSessionStatus,
  BrowserArtifactBytes,
  ConsoleMessage,
  NavigationOutcome,
  NavigationRequest,
} from './types.ts';
export {
  BROWSER_SESSION_STATUSES,
  BrowserTimeoutError,
  DbTransientError,
  NotImplementedError,
  StorageWriteError,
} from './types.ts';

export { FakeBrowserDriver, type FakeBrowserDriverDeps } from './fake-driver.ts';
export { RealBrowserDriver } from './real-driver.ts';
export { selectBrowserDriver, type BrowserDriverChoice } from './select.ts';

export { redactCookies, REDACTED, type Har, type HarHeader } from './har-redactor.ts';
export {
  writeArtifacts,
  type WrittenArtifacts,
  type WriteArtifactsInput,
} from './artifact-writer.ts';
export { checkNavigation, type ScopeGuardDeps } from './scope-guard.ts';

export {
  handleReconBrowser,
  reconBrowserPayloadSchema,
  type AuditEmitter,
  type AuditEmitterArgs,
  type BrowserWorkerDeps,
  type ObservationWriter,
  type ObservationWriterInput,
  type ReconBrowserPayload,
} from './worker.ts';
