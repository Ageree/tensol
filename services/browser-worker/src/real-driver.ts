// Sprint 15 — RealBrowserDriver (Playwright Chromium).
//
// Replaces the Sprint 9 stub. Uses playwright chromium.launch() for
// lifecycle management. Each session gets its own Browser+Context+Page.
// Scope-guard is called BEFORE page.goto() via the injected scopeCheck fn.

import { chromium } from 'playwright';
import type {
  BrowserDriver,
  BrowserLaunchInput,
  BrowserSession,
  ConsoleMessage,
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
}

export class RealBrowserDriver implements BrowserDriver {
  private readonly sessions = new Map<string, RealSession>();
  private readonly scopeCheck: ((url: string) => Promise<void>) | undefined;
  private readonly randomUUID: () => string;

  constructor(deps: RealBrowserDriverDeps = {}) {
    this.scopeCheck = deps.scopeCheck;
    this.randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
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

    // HAR capture via route interception — record all requests.
    const harEntries: Array<{ url: string; status: number }> = [];
    await context.route('**/*', async (route) => {
      const req = route.request();
      const resp = await route.fetch();
      harEntries.push({ url: req.url(), status: resp.status() });
      await route.fulfill({ response: resp });
    });

    const redirectChain: string[] = [startUrl];
    let finalUrl = startUrl;

    try {
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

      const har = JSON.stringify({
        log: {
          version: '1.2',
          creator: { name: 'RealBrowserDriver', version: '1.0' },
          entries: harEntries.map((e) => ({
            startedDateTime: new Date().toISOString(),
            time: 0,
            request: {
              method: 'GET',
              url: e.url,
              httpVersion: 'HTTP/1.1',
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

      // Discover links from rendered DOM.
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((href) => href.startsWith('http')),
      );

      await context.unrouteAll();

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
}
