// Sprint 9 — FakeBrowserDriver. Deterministic, fetch-backed.
//
// Rationale (R1 from contract): the real Chromium binary is too heavy to
// install in CI and brings non-determinism. Instead we simulate the
// browser network stack via globalThis.fetch (or an injected stub for
// the A-BR-NavBeforeFetch probe).
//
// What we capture per navigation:
//   - DOM snapshot: response body (text)
//   - Console messages: a single deterministic log line per page
//   - HAR: synthetic, includes Cookie + Set-Cookie headers in BOTH
//     directions so har-redactor can be exercised
//   - Screenshot: 1×1 transparent PNG bytes
//   - Trace: tiny placeholder bytes
//   - Redirect chain: derived from fetch() Response.url + redirected flag
//
// State per session: kept in Map<sessionId, FakeSessionState>. Sessions
// are isolated; closing one does not affect others (A-BR-Tenant-Iso).

import {
  type BrowserDriver,
  type BrowserDriverFetchDeps,
  type BrowserLaunchInput,
  type BrowserSession,
  BrowserTimeoutError,
  type ConsoleMessage,
  type NavigationOutcome,
  type NavigationRequest,
} from './types.ts';

// 1×1 transparent PNG — just enough to hash deterministically.
const ONE_PIXEL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xfa, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa3, 0x4f, 0x10, 0x21, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const TRACE_STUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // ZIP magic only

interface FakeSessionState {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly authCookies: ReadonlyArray<{ name: string; value: string }>;
  closed: boolean;
}

export interface FakeBrowserDriverDeps extends Partial<BrowserDriverFetchDeps> {
  /** Test seam — defaults to crypto.randomUUID(). */
  readonly randomUUID?: () => string;
  /** Test seam — defaults to () => new Date().toISOString(). */
  readonly nowIso?: () => string;
  /**
   * Inject a one-shot fault for the next call to `launch` or `navigate`.
   * Used by `retry-transient.test.ts` to assert transient retry behaviour.
   * The fault is consumed on the first call and never throws again.
   */
  readonly oneShotLaunchFault?: () => Error | null;
}

const HREF_RE = /href\s*=\s*"([^"]+)"|href\s*=\s*'([^']+)'/g;

const extractLinks = (body: string, baseUrl: string): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const match of body.matchAll(HREF_RE)) {
    const href = match[1] ?? match[2];
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl);
      out.push(abs.toString());
    } catch {
      // ignore malformed
    }
  }
  return out;
};

export class FakeBrowserDriver implements BrowserDriver {
  private readonly sessions = new Map<string, FakeSessionState>();
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly randomUUID: () => string;
  private readonly nowIso: () => string;
  private readonly oneShotLaunchFault: (() => Error | null) | undefined;

  constructor(deps: FakeBrowserDriverDeps = {}) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.randomUUID = deps.randomUUID ?? ((): string => crypto.randomUUID());
    this.nowIso = deps.nowIso ?? ((): string => new Date().toISOString());
    this.oneShotLaunchFault = deps.oneShotLaunchFault;
  }

  async launch(input: BrowserLaunchInput): Promise<BrowserSession> {
    if (this.oneShotLaunchFault) {
      const fault = this.oneShotLaunchFault();
      if (fault) throw fault;
    }
    const sessionId = this.randomUUID();
    this.sessions.set(sessionId, {
      sessionId,
      tenantId: input.tenantId,
      assessmentId: input.assessmentId,
      authCookies: (input.authCookies ?? []).map((c) => ({ name: c.name, value: c.value })),
      closed: false,
    });
    return { sessionId, status: 'launched' };
  }

  async navigate(sessionId: string, request: NavigationRequest): Promise<NavigationOutcome> {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) {
      throw new Error(`session_not_found:${sessionId}`);
    }
    const startUrl = request.url;
    const reqHeaders: Array<{ name: string; value: string }> = [];
    if (state.authCookies.length > 0) {
      const cookieHeader = state.authCookies.map((c) => `${c.name}=${c.value}`).join('; ');
      reqHeaders.push({ name: 'Cookie', value: cookieHeader });
    }
    let res: Response;
    try {
      res = await this.fetchImpl(startUrl, { method: request.method, redirect: 'manual' });
    } catch (err) {
      if (err instanceof BrowserTimeoutError) throw err;
      // Wrap unknown fetch errors as transient; the worker will nack.
      throw new BrowserTimeoutError(
        `fake_driver_fetch_failed:${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // redirect: 'manual' surfaces 3xx responses with the Location header
    // intact. The worker scope-checks the target BEFORE issuing the
    // follow-up fetch (R5 in the contract — closes the Sprint 6 round-2
    // P1 redirect-target bypass).
    let finalUrl = startUrl;
    let redirectChain: string[] = [startUrl];
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        try {
          const target = new URL(location, startUrl).toString();
          finalUrl = target;
          redirectChain = [startUrl, target];
        } catch {
          // malformed redirect target — treat as terminal navigation.
        }
      }
    }
    const body = await res.text();
    const setCookieRaw = res.headers.get('set-cookie');
    const respHeaders: Array<{ name: string; value: string }> = [];
    if (setCookieRaw) respHeaders.push({ name: 'Set-Cookie', value: setCookieRaw });
    const consoleMessages: ConsoleMessage[] = [
      { level: 'log', text: `navigated:${finalUrl}`, tsIso: this.nowIso() },
    ];
    const har = this.buildHar({
      startUrl,
      finalUrl,
      method: request.method,
      reqHeaders,
      respHeaders,
      reqCookies: state.authCookies,
      respCookies: setCookieRaw ? this.parseSetCookieToHarCookies(setCookieRaw) : [],
      httpStatus: res.status,
    });
    return {
      finalUrl,
      redirectChain,
      artifacts: {
        screenshot: ONE_PIXEL_PNG,
        har: new TextEncoder().encode(JSON.stringify(har)),
        trace: TRACE_STUB,
        domSnapshot: body,
        consoleMessages,
        httpStatus: res.status,
      },
      discoveredLinks: extractLinks(body, finalUrl),
      // Sprint 16: FakeBrowserDriver does not simulate SPA discovery (fetch-based, no JS engine).
      spaRoutes: [],
    };
  }

  async close(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state) state.closed = true;
  }

  private parseSetCookieToHarCookies(raw: string): ReadonlyArray<{ name: string; value: string }> {
    const idx = raw.indexOf('=');
    if (idx === -1) return [];
    const name = raw.slice(0, idx).trim();
    const valueRaw = raw.slice(idx + 1);
    const value = valueRaw.split(';')[0]?.trim() ?? '';
    return [{ name, value }];
  }

  private buildHar(input: {
    startUrl: string;
    finalUrl: string;
    method: string;
    reqHeaders: Array<{ name: string; value: string }>;
    respHeaders: Array<{ name: string; value: string }>;
    reqCookies: ReadonlyArray<{ name: string; value: string }>;
    respCookies: ReadonlyArray<{ name: string; value: string }>;
    httpStatus: number;
  }): unknown {
    return {
      log: {
        version: '1.2',
        creator: { name: 'FakeBrowserDriver', version: '0.1.0' },
        entries: [
          {
            startedDateTime: this.nowIso(),
            time: 1,
            request: {
              method: input.method,
              url: input.startUrl,
              httpVersion: 'HTTP/1.1',
              headers: input.reqHeaders,
              cookies: input.reqCookies,
              queryString: [],
              headersSize: -1,
              bodySize: 0,
            },
            response: {
              status: input.httpStatus,
              statusText: '',
              httpVersion: 'HTTP/1.1',
              headers: input.respHeaders,
              cookies: input.respCookies,
              content: { size: 0, mimeType: 'text/html' },
              redirectURL: input.finalUrl !== input.startUrl ? input.finalUrl : '',
              headersSize: -1,
              bodySize: 0,
            },
            cache: {},
            timings: { send: 0, wait: 1, receive: 0 },
          },
        ],
      },
    };
  }
}
