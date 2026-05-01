// Sprint 9 — browser-worker public types.
//
// `BrowserDriver` is the seam between the worker (which contains the
// audit/db/storage logic) and the browsing engine (Playwright in Phase 2,
// FakeBrowserDriver for now). Closed-set status enums; typed sentinel
// errors for retry classification.

export const BROWSER_SESSION_STATUSES = ['launched', 'navigated', 'aborted', 'closed'] as const;

export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number];

export interface AuthCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

export interface BrowserLaunchInput {
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly traceId: string;
  /** Optional auth cookies. Sprint 9 lab fixture is anonymous; field is
   * exercised by FakeBrowserDriver unit test only (A-BR-Auth). */
  readonly authCookies?: ReadonlyArray<AuthCookie>;
}

export interface BrowserSession {
  readonly sessionId: string;
  readonly status: BrowserSessionStatus;
}

export interface NavigationRequest {
  readonly url: string;
  readonly method: 'GET';
}

export interface ConsoleMessage {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  readonly text: string;
  readonly tsIso: string;
}

export interface BrowserArtifactBytes {
  /** Raw PNG bytes (a stub 1×1 PNG in FakeBrowserDriver). */
  readonly screenshot: Uint8Array;
  /** Pre-redaction HAR JSON bytes — caller MUST run redactCookies(). */
  readonly har: Uint8Array;
  /** Trace zip bytes (a stub one-byte buffer in FakeBrowserDriver). */
  readonly trace: Uint8Array;
  /** DOM snapshot string (rendered HTML body). */
  readonly domSnapshot: string;
  readonly consoleMessages: ReadonlyArray<ConsoleMessage>;
  readonly httpStatus: number | null;
}

export interface DiscoveredSpaRoute {
  readonly url: string;
  readonly sourceUrl: string;
  readonly depth: number;
  readonly method: 'pushstate' | 'popstate';
  readonly navigated: boolean;
  /** Present when navigated=true — raw artifact bytes for observation insertion. */
  readonly artifacts?: BrowserArtifactBytes;
}

export interface NavigationOutcome {
  readonly finalUrl: string;
  /** redirectChain[0] === startUrl, redirectChain[N] === finalUrl. */
  readonly redirectChain: ReadonlyArray<string>;
  readonly artifacts: BrowserArtifactBytes;
  /** Hyperlinks found on the rendered page (absolute URLs). depth-1 only. */
  readonly discoveredLinks: ReadonlyArray<string>;
  /** Sprint 16 — SPA routes discovered via pushState/popstate observer. */
  readonly spaRoutes: ReadonlyArray<DiscoveredSpaRoute>;
}

/** Inject point for the recording-fetch test stub used by A-BR-NavBeforeFetch. */
export interface BrowserDriverFetchDeps {
  readonly fetch: typeof globalThis.fetch;
}

export interface BrowserDriver {
  launch(input: BrowserLaunchInput): Promise<BrowserSession>;
  navigate(sessionId: string, request: NavigationRequest): Promise<NavigationOutcome>;
  close(sessionId: string): Promise<void>;
}

// =============== Typed sentinel errors (A-BR-RetryPolicy) ===============

/**
 * Browser engine timeout. Transient — not `__terminal:true`.
 * Worker maps this to a `nack` carrying a non-terminal error so the queue
 * retry-classifier (Sprint 7) retries up to maxAttempts.
 */
export class BrowserTimeoutError extends Error {
  override readonly name = 'BrowserTimeoutError';
}

/**
 * Real browser driver not implemented yet. Throws inside `RealBrowserDriver`
 * and via the lazy fallback in `selectBrowserDriver()`. Mirrors the
 * Sprint 8 RealDecepticonAdapter pattern.
 */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
}

/**
 * Sprint 9 codex iter-2 P1 — object-storage write failure. Transient.
 * Worker wraps `objectStorage.put` raw throws into this sentinel so the
 * queue retry-classifier recognizes the name and retries up to
 * maxAttempts. Without the wrap the raw `Error` defaults to terminal
 * and the queue short-circuits on the first attempt.
 */
export class StorageWriteError extends Error {
  override readonly name = 'StorageWriteError';
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Sprint 9 codex iter-2 P1 — DB transient failure. Worker wraps
 * `observationWriter` raw throws into this sentinel for the same reason
 * as `StorageWriteError`. Postgres connection blips, lock-timeouts, and
 * write retries flow through this name; permanent failures (constraint
 * violations) should NOT be wrapped — let them surface as plain Error
 * which the classifier treats as terminal.
 */
export class DbTransientError extends Error {
  override readonly name = 'DbTransientError';
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}
