// Sprint 10 — XssReplayDriver. The seam between the validator (decision)
// and the browser engine (signal capture). FakeXssReplayDriver is
// deterministic, fetch-backed; RealXssReplayDriver is a Playwright stub
// that throws NotImplementedError. Mirrors the Sprint 9 BrowserDriver
// pattern.
//
// What we capture per replay:
//   - DOM body (response text) — substring-checked for nonce echo
//   - Console messages tagged with the nonce
//   - Alert dispatch (if any) — synthesised when the response body would
//     plausibly fire one (e.g. `alert(`)
//   - Network requests originating from the injected script
//   - Screenshot bytes (1x1 PNG stub) + trace bytes (zip-magic stub)
//
// `simulateTimeout` flips the next launch to throw `BrowserReplayTimeoutError`.

import { nonceMatchesEcho } from './nonce.ts';

export interface XssReplayInput {
  readonly affectedUrl: string;
  readonly nonce: string;
  /** Stamped into the URL's `q` (or any echoing param) so the response
   * reflects it. The validator, NOT the driver, owns the payload shape. */
  readonly payload: string;
  readonly traceId: string;
}

export interface XssReplayResult {
  readonly finalUrl: string;
  readonly httpStatus: number | null;
  readonly domContainsNonce: boolean;
  readonly consoleNonceHits: ReadonlyArray<string>;
  readonly alertDispatched: boolean;
  readonly networkRequestsFromScript: ReadonlyArray<string>;
  readonly screenshot: Uint8Array;
  readonly trace: Uint8Array;
  readonly capturedAt: string;
}

export interface XssReplayDriver {
  replay(input: XssReplayInput): Promise<XssReplayResult>;
}

/**
 * Typed sentinel for browser-replay timeout. Worker maps this in the
 * validator decision tree to `inconclusive` with `reason:'timeout'`
 * (A-V-Hang). NOT a transient nack — the candidate stays a candidate;
 * this validation attempt is just inconclusive.
 */
export class BrowserReplayTimeoutError extends Error {
  override readonly name = 'BrowserReplayTimeoutError';
}

export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
}

// 1x1 transparent PNG — same constant shape as Sprint 9 FakeBrowserDriver.
const ONE_PIXEL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xfa, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa3, 0x4f, 0x10, 0x21, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const TRACE_STUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

export interface FakeXssReplayDriverDeps {
  /** Test seam — defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Test seam — defaults to () => new Date().toISOString(). */
  readonly nowIso?: () => string;
  /** When true, the next replay throws `BrowserReplayTimeoutError`. Used by
   * the A-V-Hang unit test + IT. */
  readonly simulateTimeout?: boolean;
  /**
   * When true, the driver reports `alertDispatched: true` regardless of
   * body content. Used by the A-V-AlertOnly path so the test can pin a
   * weak proof scenario without relying on response heuristics.
   */
  readonly forceAlertOnly?: boolean;
}

export class FakeXssReplayDriver implements XssReplayDriver {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly nowIso: () => string;
  private readonly simulateTimeout: boolean;
  private readonly forceAlertOnly: boolean;

  constructor(deps: FakeXssReplayDriverDeps = {}) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.nowIso = deps.nowIso ?? ((): string => new Date().toISOString());
    this.simulateTimeout = deps.simulateTimeout ?? false;
    this.forceAlertOnly = deps.forceAlertOnly ?? false;
  }

  async replay(input: XssReplayInput): Promise<XssReplayResult> {
    if (this.simulateTimeout) {
      throw new BrowserReplayTimeoutError(`xss_replay_timeout:${input.affectedUrl}`);
    }
    const stamped = stampPayloadIntoUrl(input.affectedUrl, input.payload);
    let res: Response;
    try {
      res = await this.fetchImpl(stamped, { method: 'GET', redirect: 'manual' });
    } catch (err) {
      throw new Error(
        `fake_xss_replay_fetch_failed:${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const body = await res.text();
    const domContainsNonce = nonceMatchesEcho(input.nonce, body);
    const consoleNonceHits = this.synthesiseConsoleHits(body, input.nonce);
    const alertDispatched = this.forceAlertOnly ? true : body.includes('alert(');
    return {
      finalUrl: stamped,
      httpStatus: res.status,
      domContainsNonce,
      consoleNonceHits,
      alertDispatched,
      networkRequestsFromScript: [],
      screenshot: ONE_PIXEL_PNG,
      trace: TRACE_STUB,
      capturedAt: this.nowIso(),
    };
  }

  private synthesiseConsoleHits(body: string, nonce: string): string[] {
    const out: string[] = [];
    if (body.includes(`console.log('[cs][${nonce}]`)) {
      out.push(`[cs][${nonce}]xss-replay`);
    }
    return out;
  }
}

const stampPayloadIntoUrl = (rawUrl: string, payload: string): string => {
  const url = new URL(rawUrl);
  // If a `q` param is already present, override it; otherwise append.
  url.searchParams.set('q', payload);
  return url.toString();
};

export class RealXssReplayDriver implements XssReplayDriver {
  replay(_input: XssReplayInput): Promise<XssReplayResult> {
    return Promise.reject(new NotImplementedError('RealXssReplayDriver.replay'));
  }
}

export type XssReplayDriverChoice = 'fake' | 'real';

const KNOWN_CHOICES = new Set<string>(['fake', 'real']);

export interface SelectXssReplayDriverOptions {
  readonly fakeDeps?: FakeXssReplayDriverDeps;
}

export const selectXssReplayDriver = (
  env: Record<string, string | undefined> = process.env,
  opts: SelectXssReplayDriverOptions = {},
): XssReplayDriver => {
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature.
  const raw = env['XSS_REPLAY_DRIVER'];
  if (raw !== undefined && !KNOWN_CHOICES.has(raw)) {
    throw new Error(`unknown_xss_replay_driver:${raw}`);
  }
  const choice: XssReplayDriverChoice = (raw ?? 'fake') as XssReplayDriverChoice;
  if (choice === 'real') return new RealXssReplayDriver();
  return new FakeXssReplayDriver(opts.fakeDeps ?? {});
};
