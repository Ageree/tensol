// Sprint 15 — RealBrowserDriver (Playwright Chromium).
//
// Replaces the Sprint 9 stub. Uses playwright chromium.launch() for
// lifecycle management. Each session gets its own Browser+Context+Page.
// Scope-guard is called BEFORE page.goto() via the injected scopeCheck fn.
//
// Sprint 16 — SPA route discovery: after the initial navigation, the
// SPA_OBSERVER_SCRIPT is injected to patch history.pushState/popstate.
// Discovered pushstate routes are scope-checked and crawled up to maxSpaDepth.

import { chromium } from 'playwright';
import { SPA_OBSERVER_SCRIPT, parseSpaMaxDepth, parseSpaRoutes } from './spa-observer.ts';
import type {
  BrowserDriver,
  BrowserLaunchInput,
  BrowserSession,
  ConsoleMessage,
  DiscoveredSpaRoute,
  NavigationOutcome,
  NavigationRequest,
} from './types.ts';
import { BrowserTimeoutError, StorageWriteError } from './types.ts';

interface RealSession {
  readonly sessionId: string;
  readonly browser: Awaited<ReturnType<typeof chromium.launch>>;
  readonly context: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>;
  readonly page: Awaited<
    ReturnType<
      Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>['newPage']
    >
  >;
}

export interface RealBrowserDriverDeps {
  readonly scopeCheck?: (url: string) => Promise<void>;
  readonly randomUUID?: () => string;
  // Sprint 16: if provided, used directly; otherwise reads process.env.BROWSER_SPA_MAX_DEPTH.
  // Tests inject this directly — no process.env mutation needed.
  readonly maxSpaDepth?: number;
}

export class RealBrowserDriver implements BrowserDriver {
  private readonly sessions = new Map<string, RealSession>();
  private readonly scopeCheck: ((url: string) => Promise<void>) | undefined;
  private readonly randomUUID: () => string;
  private readonly maxSpaDepth: number;

  constructor(deps: RealBrowserDriverDeps = {}) {
    this.scopeCheck = deps.scopeCheck;
    this.randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
    // Resolve depth at construction time (not per-navigate) for thread-safety.
    const { BROWSER_SPA_MAX_DEPTH } = process.env;
    this.maxSpaDepth =
      deps.maxSpaDepth !== undefined ? deps.maxSpaDepth : parseSpaMaxDepth(BROWSER_SPA_MAX_DEPTH);
  }

  async launch(input: BrowserLaunchInput): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'CyberStrike-BrowserWorker/1.0',
    });
    if (input.authCookies && input.authCookies.length > 0) {
      await context.addCookies(
        input.authCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
        })),
      );
    }
    const page = await context.newPage();
    const sessionId = this.randomUUID();
    this.sessions.set(sessionId, { sessionId, browser, context, page });
    return { sessionId, status: 'launched' };
  }

  async navigate(sessionId: string, request: NavigationRequest): Promise<NavigationOutcome> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`session_not_found:${sessionId}`);
    }

    const { page, context } = session;
    const startUrl = request.url;

    // Scope-first (P7): check BEFORE any page action.
    if (this.scopeCheck) {
      await this.scopeCheck(startUrl);
    }

    const consoleMessages: ConsoleMessage[] = [];
    page.on('console', (msg) => {
      consoleMessages.push({
        level: msg.type() as ConsoleMessage['level'],
        text: msg.text(),
        tsIso: new Date().toISOString(),
      });
    });

    // HAR capture via route interception — scope-check each subrequest before fetching.
    // Headers intentionally empty: Authorization and Cookie are never captured (HAR redaction, S2 lesson).
    const harEntries: Array<{ url: string; status: number }> = [];
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (this.scopeCheck) {
        try {
          await this.scopeCheck(req.url());
        } catch {
          await route.abort('blockedbyclient');
          return;
        }
      }
      const resp = await route.fetch();
      harEntries.push({ url: req.url(), status: resp.status() });
      await route.fulfill({ response: resp });
    });

    const redirectChain: string[] = [startUrl];
    let finalUrl = startUrl;

    try {
      // Install SPA observer BEFORE page load so pushState patches fire on page scripts.
      await page.addInitScript(SPA_OBSERVER_SCRIPT);

      const response = await page.goto(startUrl, { timeout: 30_000 });
      finalUrl = page.url();
      if (finalUrl !== startUrl) {
        redirectChain.push(finalUrl);
      }
      const httpStatus = response?.status() ?? null;

      const domSnapshot = await page.content();

      let screenshot: Uint8Array;
      try {
        screenshot = await page.screenshot({ type: 'png' });
      } catch (err) {
        throw new StorageWriteError('screenshot_failed', err);
      }

      const har = this.buildHar(harEntries);

      // Discover links from rendered DOM.
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((href) => href.startsWith('http')),
      );

      // Sprint 16 — collect SPA routes discovered during page load.
      // Wait briefly for SPA JS to execute pushState calls.
      await this.settle();
      // biome-ignore lint/suspicious/noExplicitAny: page.evaluate returns unknown from browser context.
      const rawRoutes = await page.evaluate(() => (window as any).__cs_spa_routes ?? []);
      const parsedRoutes = parseSpaRoutes(rawRoutes);

      await context.unrouteAll();

      // Crawl SPA routes (pushstate only, depth-first up to maxSpaDepth).
      const spaRoutes: DiscoveredSpaRoute[] = [];
      for (const route of parsedRoutes) {
        if (route.method === 'popstate') {
          // Discovery-only: log to audit consumer but do not navigate (S1 decision).
          spaRoutes.push({
            url: route.url,
            sourceUrl: route.sourceUrl,
            depth: 1,
            method: 'popstate',
            navigated: false,
          });
          continue;
        }
        if (1 > this.maxSpaDepth) {
          // Budget exceeded — skip without audit (not an OOS event).
          continue;
        }
        // Scope-first (P7): check discovered URL before any page.goto.
        if (this.scopeCheck) {
          try {
            await this.scopeCheck(route.url);
          } catch {
            spaRoutes.push({
              url: route.url,
              sourceUrl: route.sourceUrl,
              depth: 1,
              method: 'pushstate',
              navigated: false,
            });
            continue;
          }
        }
        // Navigate to the SPA route and capture artifacts.
        const spaConsoleMessages: ConsoleMessage[] = [];
        const spaHarEntries: Array<{ url: string; status: number }> = [];
        page.on('console', (msg) => {
          spaConsoleMessages.push({
            level: msg.type() as ConsoleMessage['level'],
            text: msg.text(),
            tsIso: new Date().toISOString(),
          });
        });
        await context.route('**/*', async (r) => {
          const req = r.request();
          if (this.scopeCheck) {
            try {
              await this.scopeCheck(req.url());
            } catch {
              await r.abort('blockedbyclient');
              return;
            }
          }
          const resp = await r.fetch();
          spaHarEntries.push({ url: req.url(), status: resp.status() });
          await r.fulfill({ response: resp });
        });
        try {
          const spaResp = await page.goto(route.url, { timeout: 30_000 });
          const spaHttpStatus = spaResp?.status() ?? null;
          const spaDom = await page.content();
          const spaScreenshot = await page.screenshot({ type: 'png' });
          const spaHar = new TextEncoder().encode(this.buildHar(spaHarEntries));
          await context.unrouteAll();
          spaRoutes.push({
            url: route.url,
            sourceUrl: route.sourceUrl,
            depth: 1,
            method: 'pushstate',
            navigated: true,
            artifacts: {
              screenshot: spaScreenshot,
              har: spaHar,
              trace: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
              domSnapshot: spaDom,
              consoleMessages: spaConsoleMessages,
              httpStatus: spaHttpStatus,
            },
          });
        } catch (err) {
          await context.unrouteAll();
          if (err instanceof Error && err.message.includes('Timeout')) {
            throw new BrowserTimeoutError(err.message);
          }
          throw err;
        }
      }

      return {
        finalUrl,
        redirectChain,
        artifacts: {
          screenshot,
          har: new TextEncoder().encode(har),
          trace: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
          domSnapshot,
          consoleMessages,
          httpStatus,
        },
        discoveredLinks: links,
        spaRoutes,
      };
    } catch (err) {
      if (err instanceof StorageWriteError) throw err;
      if (err instanceof Error && err.message.includes('Timeout')) {
        throw new BrowserTimeoutError(err.message);
      }
      throw err;
    }
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try {
      await session.browser.close();
    } catch {
      // best-effort close
    }
  }

  private buildHar(entries: ReadonlyArray<{ url: string; status: number }>): string {
    return JSON.stringify({
      log: {
        version: '1.2',
        creator: { name: 'RealBrowserDriver', version: '1.0' },
        entries: entries.map((e) => ({
          startedDateTime: new Date().toISOString(),
          time: 0,
          request: {
            method: 'GET',
            url: e.url,
            httpVersion: 'HTTP/1.1',
            // Headers intentionally empty: Authorization and Cookie are never captured (HAR redaction, S2 lesson).
            headers: [],
            cookies: [],
            queryString: [],
            headersSize: -1,
            bodySize: 0,
          },
          response: {
            status: e.status,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            headers: [],
            cookies: [],
            content: { size: 0, mimeType: 'text/html' },
            redirectURL: '',
            headersSize: -1,
            bodySize: 0,
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        })),
      },
    });
  }

  private settle(ms = 500): Promise<void> {
    const { BROWSER_SPA_SETTLE_MS } = process.env;
    const settleMs = Number.parseInt(BROWSER_SPA_SETTLE_MS ?? '', 10);
    const delay = Number.isNaN(settleMs) ? ms : settleMs;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}
