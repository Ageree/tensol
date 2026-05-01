// Public surface of the inlined browser-worker module (moved from services/browser-worker in S23).

export const name = 'services/coordinator/browser' as const;

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
  handleBrowserAuth,
  browserAuthPayloadSchema,
  type BrowserAuthDeps,
  type BrowserAuthPayload,
  type BrowserAuthAuditEmitter,
  type BrowserAuthAuditArgs,
} from './auth-handler.ts';

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
